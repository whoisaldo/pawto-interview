"""Run a bounded, text-only Codex question through the local CLI."""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import stat
import time
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
# Codex emits complete messages on individual JSONL lines.
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


def build_argv(settings: CliSettings, system_prompt: str) -> list[str]:
    """The exact program and arguments. No caller-supplied text is in here."""
    argv = [
        str(settings.command), "--ask-for-approval", "never", "exec",
        "--json", "--color", "never", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--disable", "shell_tool", "--disable", "unified_exec",
        "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
        "--disable", "multi_agent", "--disable", "multi_agent_v2",
        "--disable", "goals", "--disable", "skill_search",
        "--enable", "skip_host_skill_discovery",
        "-c", "suppress_unstable_features_warning=true",
        "-c", 'web_search="disabled"',
        "-c", "project_doc_max_bytes=0",
        "-c", f"developer_instructions={json.dumps(system_prompt)}",
        "--model", settings.model,
    ]
    if settings.effort:
        argv += ["-c", f'model_reasoning_effort="{settings.effort}"']
    argv.append("-")
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
        self.argv = build_argv(settings, system_prompt)
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

    async def events(self) -> AsyncIterator[Event]:
        usage = Usage(model=self.settings.model)
        answer: list[str] = []
        answer_bytes = 0
        status: str | None = None
        error: str | None = None
        stderr_tail = b""
        started = time.monotonic()

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

        stderr_task = asyncio.create_task(read_stderr())
        try:
            async with asyncio.timeout(self.settings.timeout_seconds):
                process.stdin.write(self.prompt.encode())
                try:
                    await process.stdin.drain()
                    process.stdin.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass

                while True:
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
                    kind = message.get("type")

                    if kind == "thread.started":
                        yield Started(usage.model)
                    elif kind == "turn.started":
                        yield Thinking()
                    elif kind == "item.completed":
                        item = message.get("item") or {}
                        item_type = item.get("type")
                        if item_type == "error" and isinstance(item.get("message"), str):
                            error = sanitize(item["message"])
                        if item_type != "agent_message" or not isinstance(item.get("text"), str):
                            continue
                        if usage.first_token_ms is None:
                            usage.first_token_ms = int((time.monotonic() - started) * 1000)
                        text = ("\n\n" if answer else "") + item["text"]
                        remaining = MAX_OUTPUT_BYTES - answer_bytes
                        if len(text.encode()) > remaining:
                            text = text.encode()[:remaining].decode("utf-8", errors="ignore")
                            status = TRUNCATED
                        if text:
                            answer.append(text)
                            answer_bytes += len(text.encode())
                            yield Delta(text)
                        if status == TRUNCATED:
                            break
                    elif kind == "turn.completed":
                        tokens = message.get("usage") or {}
                        total = _int(tokens.get("input_tokens"))
                        usage.cache_read_tokens = _int(tokens.get("cached_input_tokens"))
                        usage.cache_write_tokens = _int(tokens.get("cache_write_input_tokens"))
                        if total is not None:
                            # Stored separately so older transcripts and the session totals stay comparable.
                            usage.input_tokens = max(0, total - (usage.cache_read_tokens or 0) - (usage.cache_write_tokens or 0))
                        usage.output_tokens = _int(tokens.get("output_tokens"))
                        status = COMPLETED if answer else FAILED
                        error = None if answer else "Codex returned no answer"
                        break
                    elif kind in ("error", "turn.failed"):
                        failure = message.get("error") or {}
                        detail = failure.get("message") or message.get("message")
                        if isinstance(detail, str):
                            error = sanitize(detail)
                        if kind == "turn.failed":
                            status = FAILED
                            error = error or "Codex could not answer"
                            break
        except TimeoutError:
            status, error = TIMEOUT, f"No answer within {int(self.settings.timeout_seconds)} seconds"
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
