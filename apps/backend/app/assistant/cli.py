"""Run a bounded, text-only Codex question through the local CLI.

Each question starts its own `codex app-server` over stdio, opens one
ephemeral thread whose base instructions are the assistant's own, and reads
the answer as it is written. The server is the only way the CLI streams an
answer word by word; `codex exec` prints it whole at the end.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import stat
import time
import tomllib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

from app.core import config

DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_TIMEOUT_SECONDS = 300.0
# The whole prompt on stdin: instructions, attached context, history, question.
MAX_PROMPT_BYTES = 64 * 1024
# What one answer may print before the run is stopped.
MAX_OUTPUT_BYTES = 48 * 1024
# The server writes one JSON-RPC message per line.
STREAM_LINE_LIMIT = 4 * 1024 * 1024
# Between asking a run to stop and killing it.
KILL_GRACE_SECONDS = 3.0

ALLOWED_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")

# Everything the child inherits from this process. PATH and HOME let it find
# its own files; the rest is locale. Database passwords, sign-in secrets and
# credentials passed to the API through environment variables stay behind.
INHERITED_ENV = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR")

# Files that would make the working directory a project with its own
# instructions or tools.
WORKDIR_FORBIDDEN = ("AGENTS.md", "AGENTS.override.md", ".codex", ".git")

# Everything that would give the model a tool, a plugin, a hook or a reason to
# start another program. The assistant writes text and nothing else.
DISABLED_FEATURES = (
    "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin",
    "plugin_discovery_prefetch", "hooks", "multi_agent", "multi_agent_v2", "goals", "skill_search",
    "browser_use", "browser_use_external", "computer_use", "image_generation", "view_image",
    "sleep_tool", "tool_suggest", "daemon_auto_start", "workspace_dependencies",
)
# An MCP server name that can be named on a command line as it is.
MCP_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

COMPLETED, CANCELLED, FAILED, TIMEOUT, TRUNCATED = "completed", "cancelled", "failed", "timeout", "truncated"

_SECRET_LIKE = re.compile(r"(?i)(bearer\s+|token[\"'=:\s]+|key[\"'=:\s]+|password[\"'=:\s]+)\S+")
_OPAQUE = re.compile(r"[A-Za-z0-9_\-]{32,}")
ERROR_LIMIT = 400


class CliConfigError(Exception):
    """The assistant is configured in a way this module will not run."""


@dataclass(frozen=True)
class CliSettings:
    command: Path
    config_dir: Path
    workdir: Path
    model: str
    effort: str | None
    timeout_seconds: float
    reserved_homes: tuple[Path, ...] = ()


@dataclass
class Usage:
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    cost_usd: float | None = None
    duration_ms: int | None = None
    first_token_ms: int | None = None


@dataclass
class Started:
    model: str | None


@dataclass
class Thinking:
    pass


@dataclass
class Delta:
    text: str


@dataclass
class Finished:
    status: str
    answer: str
    error: str | None
    usage: Usage


Event = Started | Thinking | Delta | Finished


def sanitize(text: str) -> str:
    """An error fit to store and show: short, and with nothing key-shaped in it."""
    cleaned = _SECRET_LIKE.sub(r"\1[redacted]", text.replace("\x00", ""))
    cleaned = _OPAQUE.sub("[redacted]", cleaned)
    cleaned = " ".join(cleaned.split())
    return cleaned[:ERROR_LIMIT]


def _default_reserved_homes() -> tuple[Path, ...]:
    listed = os.getenv("CODEX_CLI_RESERVED_HOMES", "")
    homes = [Path(home.strip()).expanduser() for home in listed.split(",") if home.strip()]
    return tuple(homes)


def load_settings() -> CliSettings | None:
    """Settings from the environment, or None when the assistant is switched off.

    Raises CliConfigError when it is switched on but not runnable, so that a
    half-configured assistant is reported rather than guessed around.
    """
    if not config.CODEX_CLI_COMMAND:
        return None
    missing = [
        name
        for name, value in (
            ("CODEX_CLI_CONFIG_DIR", config.CODEX_CLI_CONFIG_DIR),
            ("CODEX_CLI_MODEL", config.CODEX_CLI_MODEL),
            ("CODEX_CLI_WORKDIR", config.CODEX_CLI_WORKDIR),
        )
        if not value
    ]
    if missing:
        raise CliConfigError(f"{', '.join(missing)} must be set when CODEX_CLI_COMMAND is")
    try:
        timeout = float(config.CODEX_CLI_TIMEOUT_SECONDS or DEFAULT_TIMEOUT_SECONDS)
    except ValueError as exc:
        raise CliConfigError("CODEX_CLI_TIMEOUT_SECONDS is not a number") from exc
    settings = CliSettings(
        command=Path(config.CODEX_CLI_COMMAND),
        config_dir=Path(config.CODEX_CLI_CONFIG_DIR).expanduser(),
        workdir=Path(config.CODEX_CLI_WORKDIR).expanduser(),
        model=config.CODEX_CLI_MODEL,
        effort=config.CODEX_CLI_EFFORT or None,
        timeout_seconds=timeout,
        reserved_homes=_default_reserved_homes(),
    )
    validate(settings)
    return settings


def validate(settings: CliSettings) -> None:
    command = settings.command
    if not command.is_absolute():
        raise CliConfigError("CODEX_CLI_COMMAND must be an absolute path")
    if not command.is_file() or not os.access(command, os.X_OK):
        raise CliConfigError("CODEX_CLI_COMMAND is not an executable file")

    if not settings.config_dir.is_absolute():
        raise CliConfigError("CODEX_CLI_CONFIG_DIR must be an absolute path")
    if not settings.config_dir.is_dir():
        raise CliConfigError("CODEX_CLI_CONFIG_DIR is not a directory")
    resolved = settings.config_dir.resolve()
    for reserved in settings.reserved_homes:
        if resolved == reserved.expanduser().resolve():
            raise CliConfigError(
                "CODEX_CLI_CONFIG_DIR names a reserved Codex profile."
            )

    if not MODEL_PATTERN.match(settings.model):
        raise CliConfigError("CODEX_CLI_MODEL is not a model name")
    if settings.effort is not None and settings.effort not in ALLOWED_EFFORTS:
        raise CliConfigError(f"CODEX_CLI_EFFORT must be one of {', '.join(sorted(ALLOWED_EFFORTS))}")
    if not 5 <= settings.timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise CliConfigError(f"CODEX_CLI_TIMEOUT_SECONDS must be between 5 and {int(MAX_TIMEOUT_SECONDS)}")

    workdir = settings.workdir
    if not workdir.is_absolute():
        raise CliConfigError("CODEX_CLI_WORKDIR must be an absolute path")
    try:
        workdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise CliConfigError(f"CODEX_CLI_WORKDIR cannot be created: {exc.strerror}") from exc
    if not workdir.is_dir() or workdir.is_symlink():
        raise CliConfigError("CODEX_CLI_WORKDIR is not a directory of its own")
    if stat.S_IMODE(workdir.stat().st_mode) & 0o022:
        raise CliConfigError("CODEX_CLI_WORKDIR must not be writable by other users")
    for name in WORKDIR_FORBIDDEN:
        if (workdir / name).exists():
            raise CliConfigError(
                f"CODEX_CLI_WORKDIR holds {name}. It must be a directory used for nothing else."
            )


def configured_mcp_servers(config_dir: Path) -> list[str]:
    """MCP servers named in the profile's config.toml, each to be switched off.

    `codex app-server` has no switch to ignore the profile's config, so every
    server it names is disabled by name. A name that cannot be is a refusal.
    """
    try:
        data = tomllib.loads((config_dir / "config.toml").read_text())
    except FileNotFoundError:
        return []
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise CliConfigError("The Codex profile's config.toml cannot be read") from exc
    servers = data.get("mcp_servers") or {}
    if not isinstance(servers, dict):
        raise CliConfigError("The Codex profile's mcp_servers is not a table")
    for name in servers:
        if not MCP_NAME_PATTERN.match(name):
            raise CliConfigError("The Codex profile names an MCP server that cannot be switched off")
    return sorted(servers)


def build_argv(settings: CliSettings) -> list[str]:
    """The exact program and arguments. No caller-supplied text is in here."""
    argv = [str(settings.command), "app-server"]
    for feature in DISABLED_FEATURES:
        argv += ["--disable", feature]
    argv += [
        "--enable", "skip_host_skill_discovery",
        "-c", "suppress_unstable_features_warning=true",
        "-c", 'web_search="disabled"',
        "-c", "project_doc_max_bytes=0",
    ]
    for name in configured_mcp_servers(settings.config_dir):
        argv += ["-c", f"mcp_servers.{name}.enabled=false"]
    return argv


def build_env(settings: CliSettings) -> dict[str, str]:
    env = {name: os.environ[name] for name in INHERITED_ENV if os.environ.get(name)}
    env["CODEX_HOME"] = str(settings.config_dir)
    return env


def _int(value) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


class CliRun:
    """One question to the CLI. Iterate `events()` once; `cancel()` from anywhere."""

    def __init__(self, settings: CliSettings, system_prompt: str, prompt: str) -> None:
        if len(prompt.encode()) > MAX_PROMPT_BYTES:
            raise ValueError("The prompt is larger than the assistant accepts")
        if not prompt.strip():
            raise ValueError("The prompt is empty")
        self.settings = settings
        self.system_prompt = system_prompt
        self.argv = build_argv(settings)
        self.env = build_env(settings)
        self.prompt = prompt
        self.process: asyncio.subprocess.Process | None = None
        self.cancelled = False

    def cancel(self) -> None:
        """Ask the run to stop. Safe to call twice, or before it has started."""
        self.cancelled = True
        self._signal(signal.SIGTERM)

    def _signal(self, signum: int) -> None:
        process = self.process
        if process is None:
            return
        try:
            # The child leads its own session, so this reaches whatever it
            # started as well: a launcher script, the CLI behind it, anything
            # the CLI forked.
            os.killpg(process.pid, signum)
        except (ProcessLookupError, PermissionError):
            pass

    async def _stop(self) -> None:
        """Make sure nothing of this run is left, however it ended."""
        process = self.process
        if process is None:
            return
        if process.returncode is None:
            self._signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), KILL_GRACE_SECONDS)
            except asyncio.TimeoutError:
                pass
        # Even when the leader has exited, a grandchild may not have.
        self._signal(signal.SIGKILL)
        if process.returncode is None:
            await process.wait()

    def _requests(self) -> dict[str, dict]:
        """The JSON-RPC requests this run sends, in order, keyed by id."""
        workdir = str(self.settings.workdir)
        return {
            "init": {"method": "initialize", "params": {"clientInfo": {"name": "tandemcode", "version": "1"}, "capabilities": None}},
            "mcp": {"method": "mcpServerStatus/list", "params": {}},
            "thread": {
                "method": "thread/start",
                "params": {
                    "model": self.settings.model,
                    "cwd": workdir,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "baseInstructions": self.system_prompt,
                    "ephemeral": True,
                },
            },
        }

    async def events(self) -> AsyncIterator[Event]:
        usage = Usage(model=self.settings.model)
        answer: list[str] = []
        answer_bytes = 0
        status: str | None = None
        error: str | None = None
        stderr_tail = b""
        started = time.monotonic()
        # Text streamed so far for each message item, so a completed item
        # only adds what its deltas did not.
        streamed: dict[str, str] = {}
        current_item: str | None = None
        thread_id: str | None = None
        requests = self._requests()

        try:
            self.process = await asyncio.create_subprocess_exec(
                *self.argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.settings.workdir),
                env=self.env,
                start_new_session=True,
                limit=STREAM_LINE_LIMIT,
            )
        except OSError as exc:
            yield Finished(FAILED, "", f"Could not start Codex: {exc.strerror}", usage)
            return
        process = self.process
        if self.cancelled:
            self._signal(signal.SIGTERM)

        async def read_stderr() -> bytes:
            tail = b""
            while chunk := await process.stderr.read(4096):
                tail = (tail + chunk)[-2000:]
            return tail

        async def send(message: dict) -> None:
            process.stdin.write((json.dumps(message) + "\n").encode())
            await process.stdin.drain()

        async def ask(key: str, request: dict) -> None:
            await send({"id": key, **request})

        def take(text: str) -> str:
            """Keep what fits under the output cap and say whether it all did."""
            nonlocal answer_bytes, status
            remaining = MAX_OUTPUT_BYTES - answer_bytes
            if len(text.encode()) > remaining:
                text = text.encode()[:remaining].decode("utf-8", errors="ignore")
                status = TRUNCATED
            answer.append(text)
            answer_bytes += len(text.encode())
            return text

        stderr_task = asyncio.create_task(read_stderr())
        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                try:
                    await ask("init", requests["init"])
                except (BrokenPipeError, ConnectionResetError):
                    pass

                while status is None:
                    try:
                        raw = await process.stdout.readline()
                    except ValueError:
                        # A line past STREAM_LINE_LIMIT. Nothing sane prints one.
                        status, error = FAILED, "Codex printed a line too long to read"
                        break
                    if not raw:
                        break
                    try:
                        message = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(message, dict):
                        continue
                    method = message.get("method")
                    params = message.get("params") if isinstance(message.get("params"), dict) else {}

                    if "id" in message and method:
                        # The server asking for something: an approval, a tool
                        # call, input. This assistant grants none of them.
                        await send({"id": message["id"], "error": {"code": -32601, "message": "Not available here"}})
                        continue

                    if "id" in message:
                        key = message["id"]
                        failure = message.get("error")
                        if failure:
                            detail = failure.get("message") if isinstance(failure, dict) else None
                            status = FAILED
                            error = sanitize(detail) if isinstance(detail, str) else "Codex refused the request"
                            break
                        result = message.get("result") or {}
                        if key == "init":
                            await send({"method": "initialized"})
                            await ask("mcp", requests["mcp"])
                        elif key == "mcp":
                            servers = result.get("data") or []
                            if any(server.get("tools") or server.get("serverInfo") for server in servers if isinstance(server, dict)):
                                status, error = FAILED, "Codex started an MCP server. The assistant does not run with tools."
                                break
                            await ask("thread", requests["thread"])
                        elif key == "thread":
                            thread_id = (result.get("thread") or {}).get("id")
                            if isinstance(result.get("model"), str):
                                usage.model = result["model"]
                            yield Started(usage.model)
                            turn = {
                                "threadId": thread_id,
                                "input": [{"type": "text", "text": self.prompt, "text_elements": []}],
                                "summary": "none",
                            }
                            if self.settings.effort:
                                turn["effort"] = self.settings.effort
                            await ask("turn", {"method": "turn/start", "params": turn})
                        continue

                    if params.get("threadId") not in (None, thread_id):
                        continue
                    if method == "turn/started":
                        yield Thinking()
                    elif method == "item/agentMessage/delta":
                        item_id, text = params.get("itemId"), params.get("delta")
                        if not isinstance(text, str) or not text:
                            continue
                        if usage.first_token_ms is None:
                            usage.first_token_ms = int((time.monotonic() - started) * 1000)
                        if item_id != current_item:
                            current_item = item_id
                            if answer:
                                text = "\n\n" + text
                        streamed[item_id] = streamed.get(item_id, "") + params["delta"]
                        if piece := take(text):
                            yield Delta(piece)
                    elif method == "item/completed":
                        item = params.get("item") or {}
                        if item.get("type") != "agentMessage" or not isinstance(item.get("text"), str):
                            continue
                        so_far = streamed.get(item.get("id"), "")
                        rest = item["text"][len(so_far):] if item["text"].startswith(so_far) else ""
                        if not rest:
                            continue
                        if usage.first_token_ms is None:
                            usage.first_token_ms = int((time.monotonic() - started) * 1000)
                        if not so_far and answer:
                            rest = "\n\n" + rest
                        streamed[item.get("id")] = item["text"]
                        current_item = item.get("id")
                        if piece := take(rest):
                            yield Delta(piece)
                    elif method == "thread/tokenUsage/updated":
                        total = (params.get("tokenUsage") or {}).get("total") or {}
                        sent = _int(total.get("inputTokens"))
                        usage.cache_read_tokens = _int(total.get("cachedInputTokens"))
                        usage.cache_write_tokens = _int(total.get("cacheWriteInputTokens"))
                        if sent is not None:
                            # Stored separately so older transcripts and the session totals stay comparable.
                            usage.input_tokens = max(0, sent - (usage.cache_read_tokens or 0) - (usage.cache_write_tokens or 0))
                        usage.output_tokens = _int(total.get("outputTokens"))
                    elif method == "error":
                        failure = params.get("error") or {}
                        if isinstance(failure.get("message"), str) and not params.get("willRetry"):
                            error = sanitize(failure["message"])
                    elif method == "turn/completed":
                        turn = params.get("turn") or {}
                        outcome = turn.get("status")
                        failure = turn.get("error") or {}
                        if outcome == "interrupted":
                            status = CANCELLED if self.cancelled else FAILED
                            error = None if self.cancelled else "Codex stopped the answer"
                        elif outcome == "failed":
                            status = FAILED
                            detail = failure.get("message") if isinstance(failure, dict) else None
                            error = sanitize(detail) if isinstance(detail, str) else (error or "Codex could not answer")
                        else:
                            status = COMPLETED if answer else FAILED
                            error = None if answer else "Codex returned no answer"
        except TimeoutError:
            status, error = TIMEOUT, f"No answer within {int(self.settings.timeout_seconds)} seconds"
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            await self._stop()
            try:
                stderr_tail = await asyncio.wait_for(stderr_task, 2)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                stderr_task.cancel()

        text = "".join(answer)
        if self.cancelled and status in (None, FAILED):
            status, error = CANCELLED, None
        elif status is None:
            status = FAILED
            detail = error or sanitize(stderr_tail.decode("utf-8", errors="replace"))
            error = f"Codex exited without an answer: {detail}" if detail else "Codex exited without an answer"
        if status == TRUNCATED and error is None:
            error = "The answer was cut off at the size limit"
        if usage.duration_ms is None:
            usage.duration_ms = int((time.monotonic() - started) * 1000)
        yield Finished(status, text, error, usage)
