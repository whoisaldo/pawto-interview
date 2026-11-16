"""The interview assistant: who may ask, what is sent, and what is kept.

A question goes to the Claude CLI (app.assistant.cli) only when the session
allows AI, the asker is part of the session, and the asker chose what to
attach. Every question is stored with its context sizes and its usage, where
the interviewer can read it.

There is no second model and no stock answer. When the CLI is not set up, is
set up wrongly, times out or fails, that is what the asker is told.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from uuid import UUID, uuid4

import asyncpg
from fastapi import HTTPException, status

from app.assistant import cli
from app.dao.ai_turns import AiTurnDAO
from app.dao.interviews import InterviewDAO
from app.dao.problems import ProblemDAO
from app.dao.submissions import SubmissionDAO
from app.services.interviews import CANDIDATE, INTERVIEWER, PENDING, InterviewService, run_view

logger = logging.getLogger(__name__)

# The editor's text when attached. Half the prompt, so the question, the
# problem and the conversation always fit beside it.
MAX_CODE_CONTEXT_BYTES = 32 * 1024
# A session is an hour at most; past this it is a script, not a candidate.
MAX_TURNS_PER_SESSION = 60
# CLIs running at once across every session: each is a process and a request
# on one account.
MAX_CONCURRENT_RUNS = 2
# Earlier questions and answers sent along, newest kept when space runs out.
HISTORY_TURNS = 6
# Per case, in attached test results. A traceback fits; a print loop does not.
CASE_OUTPUT_CHARS = 1200

SYSTEM_PROMPT = """You are the AI assistant inside a TandemCode interview room. The interviewer has allowed AI assistance for this session and can read this whole conversation.

Help the person think: explain, review, point out risks and suggest what to check. Be concise and concrete. Write plain Markdown.

You can see only what is attached to this message. The problem, the code and the latest test results appear only when the asker chose to send them. If you need something that was not attached, say what to attach. You cannot run code, so never say that you ran, tested or verified anything."""

CANDIDATE_NOTE = "\n\nYou are talking with the candidate. You have not seen any held-back test case, and you should not guess at them."
INTERVIEWER_NOTE = "\n\nYou are talking with the interviewer, who is trying the assistant out."

GENERIC_FAILURE = "The assistant could not answer. Your interviewer can see the details."


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "\n[cut]"


def render_problem(brief: dict) -> str:
    lines = [f"Title: {brief['title']}", "", brief["statement"] or "No statement."]
    if brief["acceptanceCriteria"]:
        lines += ["", "Acceptance criteria:"] + [f"- {line}" for line in brief["acceptanceCriteria"]]
    if brief["examples"]:
        lines += ["", "Public examples:"]
        for case in brief["examples"]:
            lines.append(f"- {case['name']}: input {case['input'].strip() or '(empty)'} -> expected {case['expected']}")
    return "\n".join(lines)


def render_run(view: dict | None) -> str:
    if view is None:
        return "No run has been judged yet."
    public = view["public"]
    lines = [f"Latest judged run: {public['passed']} of {public['total']} public examples passed."]
    for case in public["cases"]:
        outcome = "not run" if not case["ran"] else ("passed" if case["passed"] else "FAILED")
        lines.append(f"- {case['name']}: {outcome}; input {case['input'].strip() or '(empty)'}; expected {case['expected']}")
        if case["ran"] and not case["passed"]:
            if case["stdout"].strip():
                lines.append(f"  printed: {_clip(case['stdout'].strip(), CASE_OUTPUT_CHARS)}")
            if case["stderr"].strip():
                lines.append(f"  stderr: {_clip(case['stderr'].strip(), CASE_OUTPUT_CHARS)}")
    held_back = view["heldBack"]
    if held_back is not None:
        lines.append(f"Held-back cases: {held_back['passed']} of {held_back['total']} passed.")
        for case in held_back["cases"]:
            outcome = "not run" if not case["ran"] else ("passed" if case["passed"] else "FAILED")
            lines.append(
                f"- {case['name']}: {outcome}; input {case['input'].strip() or '(empty)'}; expected {case['expected']}"
            )
    return "\n".join(lines)


def assemble(question: str, blocks: list[tuple[str, str]], history: list[dict]) -> str:
    """The text on the CLI's stdin: what was attached, what was said, the question."""
    parts = []
    for kind, text in blocks:
        parts.append(f'<attached kind="{kind}">\n{text}\n</attached>')
    if not blocks:
        parts.append("Nothing was attached to this question.")
    if history:
        said = ["Earlier in this conversation (attachments from then are not repeated):"]
        for turn in history:
            said += [f"They asked: {turn['question']}", f"You answered: {turn['answer']}", ""]
        parts.append("\n".join(said).rstrip())
    parts.append(f"Question:\n{question}")
    return "\n\n".join(parts)


class LiveTurn:
    """One question in flight: the CLI run, and the stream its asker reads.

    The run belongs to a task of its own, not to the request that asked. A
    browser that goes away cannot leave a CLI running or a turn unrecorded.
    """

    def __init__(
        self,
        turn: dict,
        run: cli.CliRun,
        turns: AiTurnDAO,
        after: Callable[[dict], Awaitable[None]],
    ) -> None:
        self.turn = turn
        self.run = run
        self.turns = turns
        self.after = after
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue()
        self.done = False
        self.task = asyncio.create_task(self._drive())

    def cancel(self) -> None:
        if not self.done:
            self.run.cancel()

    async def _drive(self) -> None:
        finished: cli.Finished | None = None
        thinking_sent = False
        try:
            async for event in self.run.events():
                if isinstance(event, cli.Started):
                    await self.queue.put({"event": "started", "data": {"model": event.model}})
                elif isinstance(event, cli.Thinking):
                    # One notice is enough to say the model is working.
                    if not thinking_sent:
                        thinking_sent = True
                        await self.queue.put({"event": "thinking", "data": {}})
                elif isinstance(event, cli.Delta):
                    await self.queue.put({"event": "delta", "data": {"text": event.text}})
                elif isinstance(event, cli.Finished):
                    finished = event
        except Exception:
            logger.exception("Assistant turn %s stopped unexpectedly", self.turn["id"])
        if finished is None:
            finished = cli.Finished(cli.FAILED, "", "The assistant stopped unexpectedly", cli.Usage())

        stored = None
        try:
            usage = finished.usage
            stored = await self.turns.finish(
                self.turn["id"],
                status=finished.status,
                answer=finished.answer,
                error=finished.error,
                model=usage.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cache_read_tokens=usage.cache_read_tokens,
                cache_write_tokens=usage.cache_write_tokens,
                cost_usd=usage.cost_usd,
                duration_ms=usage.duration_ms,
                first_token_ms=usage.first_token_ms,
            )
        except Exception:
            logger.exception("Could not store assistant turn %s", self.turn["id"])
        self.done = True
        final = stored or {**self.turn, "status": cli.FAILED, "error": "The answer could not be saved"}
        await self.queue.put({"event": "done", "turn": final})
        await self.queue.put(None)
        try:
            await self.after(final)
        except Exception:
            logger.exception("Could not announce assistant turn %s", self.turn["id"])

    async def stream(self) -> AsyncIterator[dict]:
        while True:
            item = await self.queue.get()
            if item is None:
                return
            yield item


class AssistantHub:
    """The CLI's settings and the runs alive in this process."""

    def __init__(self) -> None:
        self.settings: cli.CliSettings | None = None
        self.problem: str | None = None
        self.live: dict[UUID, LiveTurn] = {}
        self.testing = False
        self.reload()

    def reload(self) -> None:
        try:
            self.settings, self.problem = cli.load_settings(), None
        except cli.CliConfigError as exc:
            self.settings, self.problem = None, str(exc)
            logger.warning("Interview assistant is misconfigured: %s", exc)

    @property
    def busy(self) -> bool:
        return len(self.live) + (1 if self.testing else 0) >= MAX_CONCURRENT_RUNS

    def limits(self) -> dict:
        return {
            "codeBytes": MAX_CODE_CONTEXT_BYTES,
            "promptBytes": cli.MAX_PROMPT_BYTES,
            "outputBytes": cli.MAX_OUTPUT_BYTES,
            "timeoutSeconds": int(self.settings.timeout_seconds) if self.settings else None,
            "turnsPerSession": MAX_TURNS_PER_SESSION,
        }

    def describe(self) -> dict:
        """For the interviewer's settings page. Names, never secrets or full paths."""
        settings = self.settings
        return {
            "configured": settings is not None or self.problem is not None,
            "ready": settings is not None,
            "problem": self.problem,
            "launcher": settings.command.name if settings else None,
            "profile": settings.config_dir.name if settings else None,
            "model": settings.model if settings else None,
            "effort": settings.effort if settings else None,
            "limits": self.limits(),
            "running": len(self.live),
            "maxRunning": MAX_CONCURRENT_RUNS,
        }

    def track(self, live: LiveTurn) -> None:
        self.live[live.turn["id"]] = live
        live.task.add_done_callback(lambda _task: self.live.pop(live.turn["id"], None))

    async def shutdown(self) -> None:
        """Stop every CLI this process started, and let each record that it stopped."""
        runs = list(self.live.values())
        for live in runs:
            live.cancel()
        if runs:
            await asyncio.wait([live.task for live in runs], timeout=cli.KILL_GRACE_SECONDS + 5)


def _unavailable(state: str, detail: str, code: int) -> HTTPException:
    return HTTPException(status_code=code, detail=detail, headers={"X-Assistant-State": state})


class AssistantService:
    def __init__(
        self,
        hub: AssistantHub,
        interviews: InterviewService,
        interview_dao: InterviewDAO,
        problem_dao: ProblemDAO,
        submission_dao: SubmissionDAO,
        turn_dao: AiTurnDAO,
        announce: Callable[[str, dict], Awaitable[None]],
    ) -> None:
        self.hub = hub
        self.interviews = interviews
        self.interview_dao = interview_dao
        self.problem_dao = problem_dao
        self.submission_dao = submission_dao
        self.turn_dao = turn_dao
        self.announce = announce

    def availability(self, session: dict, role: str, turns_used: int) -> dict:
        """Whether this person can ask right now, and if not, the reason in words."""
        hub = self.hub
        base = {
            "model": hub.settings.model if hub.settings else None,
            "effort": hub.settings.effort if hub.settings else None,
            "limits": hub.limits(),
            "turnsUsed": turns_used,
        }

        def answer(state: str, detail: str) -> dict:
            return {**base, "state": state, "detail": detail}

        if session["aiPolicy"] != "allowed":
            return answer("policy_off", "AI assistance is off for this session.")
        if hub.settings is None:
            if hub.problem and role == INTERVIEWER:
                return answer("misconfigured", hub.problem)
            if hub.problem:
                return answer("misconfigured", "The assistant is unavailable. Your interviewer can see why.")
            return answer("not_configured", "The assistant is not set up on this server.")
        if session["status"] == "ended":
            return answer("ended", "The session has ended.")
        if role == CANDIDATE and session["status"] != "running":
            return answer("not_running", "The assistant is available while the session is running.")
        if turns_used >= MAX_TURNS_PER_SESSION:
            return answer("limit_reached", "This session has used all of its assistant questions.")
        return answer("ready", "Ready.")

    async def availability_for(self, session: dict, role: str) -> dict:
        return self.availability(session, role, await self.turn_dao.count_for_session(session["id"]))

    def turn_view(self, turn: dict, role: str) -> dict:
        """A stored turn as `role` may read it. Failure details are the interviewer's."""
        view = dict(turn)
        if role != INTERVIEWER and view.get("error") and view["status"] == cli.FAILED:
            view["error"] = GENERIC_FAILURE
        return view

    async def turns(self, session_id: UUID, caller_id: str) -> list[dict]:
        session, role = await self.interviews.get_for(session_id, caller_id)
        turns = await self.turn_dao.list_for_session(session["id"])
        if role != INTERVIEWER:
            # A candidate reads their own conversation, not the interviewer's trial questions.
            turns = [turn for turn in turns if turn["userId"] == caller_id]
        return [self.turn_view(turn, role) for turn in turns]

    async def ask(self, session_id: UUID, caller_id: str, payload) -> tuple[dict, LiveTurn, str]:
        session, role = await self.interviews.get_for(session_id, caller_id)
        availability = await self.availability_for(session, role)
        state = availability["state"]
        if state != "ready":
            code = {
                "policy_off": status.HTTP_403_FORBIDDEN,
                "not_configured": status.HTTP_503_SERVICE_UNAVAILABLE,
                "misconfigured": status.HTTP_503_SERVICE_UNAVAILABLE,
                "limit_reached": status.HTTP_429_TOO_MANY_REQUESTS,
            }.get(state, status.HTTP_409_CONFLICT)
            raise _unavailable(state, availability["detail"], code)
        if self.hub.busy:
            raise _unavailable(
                "busy", "The assistant is answering other questions. Try again in a moment.",
                status.HTTP_429_TOO_MANY_REQUESTS,
            )

        selection = payload.context
        blocks: list[tuple[str, str]] = []
        if selection.prompt:
            brief = await self.interviews.brief(session)
            blocks.append(("problem", render_problem(brief)))
        if selection.code:
            if payload.code is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="Code was selected but the editor's text was not sent",
                )
            size = len(payload.code.encode())
            if size > MAX_CODE_CONTEXT_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=f"The code is {size // 1024} KB and the assistant accepts {MAX_CODE_CONTEXT_BYTES // 1024} KB. "
                    "Shorten it or untick Code.",
                )
            blocks.append(("code", payload.code))
        if selection.tests:
            blocks.append(("test-results", render_run(await self._latest_run(session, role))))

        question = payload.question.strip()
        conversation_id = payload.conversationId or uuid4()
        history = []
        if payload.conversationId:
            history = (await self.turn_dao.conversation(conversation_id, caller_id))[-HISTORY_TURNS:]
        prompt = assemble(question, blocks, history)
        while history and len(prompt.encode()) > cli.MAX_PROMPT_BYTES:
            history = history[1:]
            prompt = assemble(question, blocks, history)
        if len(prompt.encode()) > cli.MAX_PROMPT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="The question and its attachments are larger than the assistant accepts. Attach less.",
            )

        context = [{"kind": kind, "bytes": len(text.encode())} for kind, text in blocks]
        settings = self.hub.settings
        try:
            turn = await self.turn_dao.start(
                session_id=session["id"],
                conversation_id=conversation_id,
                user_id=caller_id,
                asked_as=role,
                question=question,
                context=context,
                prompt_bytes=len(prompt.encode()),
                model=settings.model,
                effort=settings.effort,
                max_per_session=MAX_TURNS_PER_SESSION,
            )
        except asyncpg.UniqueViolationError as exc:
            raise _unavailable(
                "in_flight", "Wait for your current question to finish", status.HTTP_429_TOO_MANY_REQUESTS
            ) from exc
        if turn is None:
            raise _unavailable(
                "limit_reached", "This session has used all of its assistant questions.",
                status.HTTP_429_TOO_MANY_REQUESTS,
            )

        system_prompt = SYSTEM_PROMPT + (CANDIDATE_NOTE if role == CANDIDATE else INTERVIEWER_NOTE)
        room_id = session["roomId"]

        async def after(final: dict) -> None:
            # The interviewer's transcript follows without polling.
            await self.announce(room_id, {"type": "interview", "sessionId": session["id"], "what": "assistant"})

        try:
            run = cli.CliRun(settings, system_prompt, prompt)
        except ValueError as exc:
            await self.turn_dao.finish(
                turn["id"], status=cli.FAILED, answer="", error=str(exc), model=None, input_tokens=None,
                output_tokens=None, cache_read_tokens=None, cache_write_tokens=None, cost_usd=None,
                duration_ms=None, first_token_ms=None,
            )
            raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=str(exc)) from exc
        live = LiveTurn(turn, run, self.turn_dao, after)
        self.hub.track(live)
        return turn, live, role

    async def _latest_run(self, session: dict, role: str) -> dict | None:
        """The newest judged run, as this asker is allowed to see it."""
        show = role == INTERVIEWER or session["heldBackRevealedAt"] is not None
        for submission in await self.submission_dao.list_by_room(session["roomId"]):
            if submission["status"] in PENDING:
                continue
            tests = (await self.problem_dao.get_judge_spec(submission["problemId"]))["tests"]
            return run_view(submission, tests, show)
        return None

    async def cancel(self, session_id: UUID, turn_id: UUID, caller_id: str) -> dict:
        session, role = await self.interviews.get_for(session_id, caller_id)
        turn = await self.turn_dao.get(turn_id)
        if not turn or turn["sessionId"] != session["id"]:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Question not found: {turn_id}")
        if role != INTERVIEWER and turn["userId"] != caller_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="That is not your question")
        live = self.hub.live.get(turn_id)
        if live is not None:
            live.cancel()
        return {"cancelling": live is not None, "status": turn["status"]}

    async def test(self) -> dict:
        """One small real question, for the settings page. No session, nothing stored."""
        hub = self.hub
        hub.reload()
        if hub.settings is None:
            return {"ok": False, "status": "not_configured" if not hub.problem else "misconfigured",
                    "error": hub.problem or "CLAUDE_CLI_COMMAND is not set", "answer": "", "usage": None}
        if hub.busy:
            raise _unavailable("busy", "The assistant is busy. Try again in a moment.", status.HTTP_429_TOO_MANY_REQUESTS)
        hub.testing = True
        try:
            run = cli.CliRun(
                hub.settings,
                "You are checking that a connection works. Follow the instruction exactly.",
                "Reply with the single word: ready",
            )
            finished = None
            async for event in run.events():
                if isinstance(event, cli.Finished):
                    finished = event
        finally:
            hub.testing = False
        usage = finished.usage
        return {
            "ok": finished.status == cli.COMPLETED,
            "status": finished.status,
            "error": finished.error,
            "answer": finished.answer[:200],
            "usage": {
                "model": usage.model,
                # Sent in all, whether or not it was read from the prompt cache.
                "inputTokens": sum(
                    count or 0
                    for count in (usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens)
                ),
                "outputTokens": usage.output_tokens,
                "costUsd": usage.cost_usd,
                "durationMs": usage.duration_ms,
                "firstTokenMs": usage.first_token_ms,
            },
        }
