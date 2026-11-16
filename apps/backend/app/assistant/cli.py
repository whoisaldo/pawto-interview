"""Run the Claude CLI for one question, with no shell anywhere on the path.

The interview assistant answers through a Claude Code CLI that is already
installed and signed in on the host. This module is the only code that starts
it, and it knows nothing about interviews or the database, so it can be
tested with a stand-in program.

What it guarantees:

- The program and its arguments are a list handed to exec. Nothing a caller
  writes is ever part of a command line: the question and its context go in
  on stdin, and the arguments are fixed flags plus two validated settings.
- The CLI gets no tools, no MCP servers, no saved session and none of the
  host profile's instructions, skills or hooks. It can answer and nothing
  else, which is what keeps this from being a way to run commands on the host.
- It always starts in the one configured directory, with an environment of a
  few named variables. The API's own secrets are not among them.
- It refuses a profile directory that is reserved for something else, and it
  refuses to run with no profile named at all.
- Every run has a deadline and a cap on what it may print, and a run that is
  cancelled, late or over the cap has its whole process group killed.
- It never substitutes another model or a canned reply. A failure is reported
  as a failure.
"""

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
# One stream-json line. The init and result lines run to tens of kilobytes.
STREAM_LINE_LIMIT = 4 * 1024 * 1024
# Between asking a run to stop and killing it.
KILL_GRACE_SECONDS = 3.0
# A ceiling the CLI enforces on its own spending for one question.
MAX_USD_PER_RUN = "0.50"

ALLOWED_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$")

# Everything the child inherits from this process. PATH and HOME let it find
# its own files; the rest is locale. Database passwords, sign-in secrets and
# any variables of a Claude session this API was started from stay behind.
INHERITED_ENV = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR")

# Files that would make the working directory a project with its own
# instructions or tools.
WORKDIR_FORBIDDEN = ("CLAUDE.md", "AGENTS.md", ".claude", ".mcp.json", ".git")

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
    listed = os.getenv("CLAUDE_CLI_RESERVED_HOMES", "")
    homes = [Path(home.strip()).expanduser() for home in listed.split(",") if home.strip()]
    # The login a person uses at their own terminal is never this API's to spend.
    homes.append(Path.home() / ".claude")
    return tuple(homes)


def load_settings() -> CliSettings | None:
    """Settings from the environment, or None when the assistant is switched off.

    Raises CliConfigError when it is switched on but not runnable, so that a
    half-configured assistant is reported rather than guessed around.
    """
    if not config.CLAUDE_CLI_COMMAND:
        return None
    missing = [
        name
        for name, value in (
            ("CLAUDE_CLI_CONFIG_DIR", config.CLAUDE_CLI_CONFIG_DIR),
            ("CLAUDE_CLI_MODEL", config.CLAUDE_CLI_MODEL),
            ("CLAUDE_CLI_WORKDIR", config.CLAUDE_CLI_WORKDIR),
        )
        if not value
    ]
    if missing:
        raise CliConfigError(f"{', '.join(missing)} must be set when CLAUDE_CLI_COMMAND is")
    try:
        timeout = float(config.CLAUDE_CLI_TIMEOUT_SECONDS or DEFAULT_TIMEOUT_SECONDS)
    except ValueError as exc:
        raise CliConfigError("CLAUDE_CLI_TIMEOUT_SECONDS is not a number") from exc
    settings = CliSettings(
        command=Path(config.CLAUDE_CLI_COMMAND),
        config_dir=Path(config.CLAUDE_CLI_CONFIG_DIR).expanduser(),
        workdir=Path(config.CLAUDE_CLI_WORKDIR).expanduser(),
        model=config.CLAUDE_CLI_MODEL,
        effort=config.CLAUDE_CLI_EFFORT or None,
        timeout_seconds=timeout,
        reserved_homes=_default_reserved_homes(),
    )
    validate(settings)
    return settings


def validate(settings: CliSettings) -> None:
    command = settings.command
    if not command.is_absolute():
        raise CliConfigError("CLAUDE_CLI_COMMAND must be an absolute path")
    if not command.is_file() or not os.access(command, os.X_OK):
        raise CliConfigError("CLAUDE_CLI_COMMAND is not an executable file")

    if not settings.config_dir.is_absolute():
        raise CliConfigError("CLAUDE_CLI_CONFIG_DIR must be an absolute path")
    if not settings.config_dir.is_dir():
        raise CliConfigError("CLAUDE_CLI_CONFIG_DIR is not a directory")
    resolved = settings.config_dir.resolve()
    for reserved in settings.reserved_homes:
        if resolved == reserved.expanduser().resolve():
            raise CliConfigError(
                "CLAUDE_CLI_CONFIG_DIR names a reserved Claude profile. Use the profile set aside for this service."
            )

    if not MODEL_PATTERN.match(settings.model):
        raise CliConfigError("CLAUDE_CLI_MODEL is not a model name")
    if settings.effort is not None and settings.effort not in ALLOWED_EFFORTS:
        raise CliConfigError(f"CLAUDE_CLI_EFFORT must be one of {', '.join(sorted(ALLOWED_EFFORTS))}")
    if not 5 <= settings.timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise CliConfigError(f"CLAUDE_CLI_TIMEOUT_SECONDS must be between 5 and {int(MAX_TIMEOUT_SECONDS)}")

    workdir = settings.workdir
    if not workdir.is_absolute():
        raise CliConfigError("CLAUDE_CLI_WORKDIR must be an absolute path")
    try:
        workdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise CliConfigError(f"CLAUDE_CLI_WORKDIR cannot be created: {exc.strerror}") from exc
    if not workdir.is_dir() or workdir.is_symlink():
        raise CliConfigError("CLAUDE_CLI_WORKDIR is not a directory of its own")
    if stat.S_IMODE(workdir.stat().st_mode) & 0o022:
        raise CliConfigError("CLAUDE_CLI_WORKDIR must not be writable by other users")
    for name in WORKDIR_FORBIDDEN:
        if (workdir / name).exists():
            raise CliConfigError(
                f"CLAUDE_CLI_WORKDIR holds {name}. It must be a directory used for nothing else."
            )


def build_argv(settings: CliSettings, system_prompt: str) -> list[str]:
    """The exact program and arguments. No caller-supplied text is in here."""
    argv = [
        str(settings.command),
        "--print",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        # No instructions, skills, plugins, hooks or MCP servers from the profile.
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        # An empty tool list: the model can write an answer and do nothing else.
        "--tools", "",
        "--no-session-persistence",
        "--max-budget-usd", MAX_USD_PER_RUN,
        "--system-prompt", system_prompt,
        "--model", settings.model,
    ]
    if settings.effort:
        argv += ["--effort", settings.effort]
    return argv


def build_env(settings: CliSettings) -> dict[str, str]:
    env = {name: os.environ[name] for name in INHERITED_ENV if os.environ.get(name)}
    env["CLAUDE_CONFIG_DIR"] = str(settings.config_dir)
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
        usage = Usage()
        answer: list[str] = []
        answer_bytes = 0
        status: str | None = None
        error: str | None = None
        result_text: str | None = None
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
            yield Finished(FAILED, "", f"Could not start the Claude CLI: {exc.strerror}", usage)
            return
        process = self.process
        if self.cancelled:
            self._signal(signal.SIGTERM)

        async def read_stderr() -> bytes:
            data = await process.stderr.read()
            return data[-2000:]

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
                        status, error = FAILED, "The Claude CLI printed a line too long to read"
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

                    if kind == "system" and message.get("subtype") == "init":
                        usage.model = message.get("model") or usage.model
                        yield Started(usage.model)
                    elif kind == "stream_event" and isinstance(message.get("event"), dict):
                        event = message["event"]
                        if event.get("type") != "content_block_delta":
                            continue
                        delta = event.get("delta") or {}
                        if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
                            if usage.first_token_ms is None:
                                usage.first_token_ms = int((time.monotonic() - started) * 1000)
                            text = delta["text"]
                            room = MAX_OUTPUT_BYTES - answer_bytes
                            if len(text.encode()) > room:
                                text = text.encode()[:room].decode("utf-8", errors="ignore")
                                status = TRUNCATED
                            if text:
                                answer.append(text)
                                answer_bytes += len(text.encode())
                                yield Delta(text)
                            if status == TRUNCATED:
                                break
                        elif delta.get("type") == "thinking_delta":
                            yield Thinking()
                    elif kind == "result":
                        result_text = message.get("result") if isinstance(message.get("result"), str) else None
                        fields = message.get("usage") or {}
                        usage.input_tokens = _int(fields.get("input_tokens"))
                        usage.output_tokens = _int(fields.get("output_tokens"))
                        usage.cache_read_tokens = _int(fields.get("cache_read_input_tokens"))
                        usage.cache_write_tokens = _int(fields.get("cache_creation_input_tokens"))
                        cost = message.get("total_cost_usd")
                        usage.cost_usd = float(cost) if isinstance(cost, (int, float)) else None
                        usage.duration_ms = _int(message.get("duration_ms")) or _int(message.get("duration_api_ms"))
                        models = message.get("modelUsage")
                        if isinstance(models, dict) and models:
                            usage.model = next(iter(models))
                        if message.get("is_error") or message.get("subtype") not in (None, "success"):
                            status = FAILED
                            error = sanitize(result_text or f"The Claude CLI reported {message.get('subtype')}")
                        else:
                            status = COMPLETED
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
        elif status == COMPLETED and not text and result_text:
            # A CLI that sent no partial messages still sent its answer whole.
            clipped = result_text.encode()[:MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore")
            if clipped != result_text:
                status = TRUNCATED
            text = clipped
            yield Delta(text)
        elif status is None:
            status = FAILED
            detail = sanitize(stderr_tail.decode("utf-8", errors="replace"))
            code = process.returncode
            error = f"The Claude CLI exited with status {code} and no answer" + (f": {detail}" if detail else "")
        if status == TRUNCATED and error is None:
            error = "The answer was cut off at the size limit"
        if usage.duration_ms is None:
            usage.duration_ms = int((time.monotonic() - started) * 1000)
        yield Finished(status, text, error, usage)
