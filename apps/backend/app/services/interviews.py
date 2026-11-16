"""Interview sessions: who may do what, and what each side is shown.

An interviewer (an operator, see app.core.auth.is_operator) creates a session,
runs its clock, sees every test case and scores what they observed. A
candidate is whoever redeemed the session's invite code. They see the brief,
the public examples and their own runs, and nothing held back until the
interviewer reveals it.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import HTTPException, status

from app.core.auth import is_operator
from app.dao.interviews import DIMENSIONS, InterviewDAO
from app.dao.problems import ProblemDAO
from app.dao.submissions import SubmissionDAO
from app.dao.users import UserDAO

INTERVIEWER, CANDIDATE = "interviewer", "candidate"

# Past this the lists are not something a person reads.
SESSION_LIST_LIMIT = 200

PENDING = {"pending", "running"}

# What an interviewer scores. Evidence they saw, on a short scale, with
# "unobserved" kept apart from "absent": not having had the chance to see
# something is not the same as seeing it missing.
EVIDENCE = [
    {
        "key": "clarification",
        "label": "Requirement clarification",
        "prompt": "Asked what counts before changing code, and restated the contract in their own words.",
    },
    {
        "key": "verification",
        "label": "Verification",
        "prompt": "Checked behaviour beyond the public examples, including claims the assistant made.",
    },
    {
        "key": "understanding",
        "label": "Understanding",
        "prompt": "Explained why the boundary cases behave as they do, without reading it off the screen.",
    },
    {
        "key": "ownership",
        "label": "Tool ownership",
        "prompt": "Chose what to ask and attach, corrected or rejected AI output, and can defend the final code.",
    },
]
SCORE_LABELS = {0: "Absent", 1: "Partial", 2: "Clear"}
UNOBSERVED = "Unobserved"
RECOMMENDATIONS = {
    "undecided": "No decision recorded",
    "advance": "Advance",
    "hold": "Needs another signal",
    "decline": "Do not advance",
}
RECOMMENDATION_NOTE = (
    "Entered by the interviewer. Test results never set or change it."
)


def role_in(session: dict, user_id: str) -> str | None:
    """What `user_id` is to this session, or None if they have no part in it."""
    if is_operator(user_id):
        return INTERVIEWER
    if session["candidateUserId"] == user_id:
        return CANDIDATE
    return None


def remaining_seconds(session: dict) -> int:
    """Negative once the session has run over; the clock does not stop itself."""
    return session["durationSeconds"] - session["elapsedSeconds"]


def _case_name(test: dict, position: int, held_back: bool) -> str:
    return test.get("name") or (f"Held-back case {position}" if held_back else f"Example {position}")


def split_cases(tests: list[dict]) -> tuple[list[dict], list[dict]]:
    """A problem's tests as public examples and held-back cases, each named."""
    public, held_back = [], []
    for index, test in enumerate(tests):
        hidden = bool(test.get("hidden"))
        group = held_back if hidden else public
        group.append(
            {
                "index": index,
                "name": _case_name(test, len(group) + 1, hidden),
                "input": test["input"],
                "expected": test["expected"],
            }
        )
    return public, held_back


def mask_held_back(submission: dict, tests: list[dict]) -> dict:
    """A run as a candidate may see it before the reveal: public examples only.

    Not only the held-back inputs: whether they passed, and how many there
    were that failed, is exactly what the interviewer is holding back.
    """
    result = submission.get("result")
    if not result:
        return submission
    hidden = {index for index, test in enumerate(tests) if test.get("hidden")}
    shown = [outcome for outcome in result["tests"] if outcome["index"] not in hidden]
    total = len(tests) - len(hidden)
    passed = sum(1 for outcome in shown if outcome["passed"])
    # With every case judged, the run's status is that of its first failure,
    # and the examples come first. So a failed example already owns the status.
    public_status = submission["status"] if passed < total else "accepted"
    masked = dict(submission)
    masked["status"] = public_status
    masked["result"] = {**result, "status": public_status, "passed": passed, "total": total, "tests": shown}
    return masked


def run_view(submission: dict, tests: list[dict], show_held_back: bool, with_code: bool = False) -> dict:
    """One run, case by case, for the session's own screens."""
    result = submission.get("result")
    outcomes = {outcome["index"]: outcome for outcome in (result or {}).get("tests", [])}
    public_cases, held_back_cases = split_cases(tests)

    def fill(case: dict, detailed: bool) -> dict:
        outcome = outcomes.get(case["index"])
        filled = {**case, "ran": outcome is not None, "passed": outcome["passed"] if outcome else None}
        if detailed:
            filled["timeMs"] = outcome["timeMs"] if outcome else None
            filled["stdout"] = outcome["stdout"] if outcome else ""
            filled["stderr"] = outcome["stderr"] if outcome else ""
        return filled

    judged = submission["status"] not in PENDING
    public = [fill(case, True) for case in public_cases]
    public_passed = sum(1 for case in public if case["passed"])
    view = {
        "id": submission["id"],
        "userId": submission["userId"],
        "userName": submission["userName"],
        "createdAt": submission["createdAt"],
        "state": "judged" if judged else submission["status"],
        "public": {
            "passed": public_passed,
            "total": len(public),
            # "passed" rather than "accepted": passing the examples is not
            # the same as the run being right, and here the screen must not
            # say that it is.
            "status": None
            if not judged
            else ("passed" if public and public_passed == len(public) else submission["status"]),
            "timeMs": result["timeMs"] if result else None,
            "cases": public,
        },
        "heldBackCount": len(held_back_cases),
        "heldBack": None,
        "judgeFailed": judged and (result is None or not result.get("tests")),
    }
    if show_held_back:
        held_back = [fill(case, False) for case in held_back_cases]
        view["heldBack"] = {
            "passed": sum(1 for case in held_back if case["passed"]),
            "total": len(held_back),
            "cases": held_back,
        }
        view["overallStatus"] = submission["status"] if judged else None
    if with_code:
        view["code"] = submission.get("code")
    return view


class RunVisibility:
    """Applies the held-back rule to runs leaving through the older room paths.

    The room socket, the room's run list and its replay all carry runs. An
    interview room uses the same paths, so each of them asks here first.
    """

    def __init__(self, interview_dao: InterviewDAO, problem_dao: ProblemDAO) -> None:
        self.interview_dao = interview_dao
        self.problem_dao = problem_dao

    async def _hides_held_back(self, room_id: str, caller_id: str | None) -> bool:
        session = await self.interview_dao.get_by_room(room_id)
        if session is None or session["heldBackRevealedAt"] is not None:
            return False
        # A broadcast has no one caller: it goes to the candidate too.
        return caller_id is None or not is_operator(caller_id)

    async def one(self, submission: dict, caller_id: str | None) -> dict:
        if not await self._hides_held_back(submission["roomId"], caller_id):
            return submission
        spec = await self.problem_dao.get_judge_spec(submission["problemId"])
        return mask_held_back(submission, spec["tests"])

    async def many(self, room_id: str, submissions: list[dict], caller_id: str | None) -> list[dict]:
        if not submissions or not await self._hides_held_back(room_id, caller_id):
            return submissions
        specs: dict[UUID, list[dict]] = {}
        masked = []
        for submission in submissions:
            problem_id = submission["problemId"]
            if problem_id not in specs:
                specs[problem_id] = (await self.problem_dao.get_judge_spec(problem_id))["tests"]
            masked.append(mask_held_back(submission, specs[problem_id]))
        return masked


def _not_found(session_id) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Interview not found: {session_id}")


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


class InterviewService:
    def __init__(
        self,
        interview_dao: InterviewDAO,
        problem_dao: ProblemDAO,
        user_dao: UserDAO,
        submission_dao: SubmissionDAO,
    ) -> None:
        self.interview_dao = interview_dao
        self.problem_dao = problem_dao
        self.user_dao = user_dao
        self.submission_dao = submission_dao

    # Reading

    async def get_session(self, session_id: UUID) -> dict:
        session = await self.interview_dao.get(session_id)
        if not session:
            raise _not_found(session_id)
        return session

    async def get_for(self, session_id: UUID, caller_id: str) -> tuple[dict, str]:
        """The session and the caller's role in it.

        Someone with no part in a session is told it does not exist, so a
        guessed id confirms nothing.
        """
        session = await self.interview_dao.get(session_id)
        role = role_in(session, caller_id) if session else None
        if role is None:
            raise _not_found(session_id)
        return session, role

    async def list_sessions(self) -> list[dict]:
        sessions = await self.interview_dao.list_all(SESSION_LIST_LIMIT)
        tests = await self.interview_dao.list_problem_tests()
        return [self._summary(session, tests.get(session["problemId"], [])) for session in sessions]

    async def get_summary(self, session_id: UUID) -> dict:
        session = await self.interview_dao.get_with_activity(session_id)
        if not session:
            raise _not_found(session_id)
        tests = (await self.problem_dao.get_judge_spec(session["problemId"]))["tests"]
        return self._summary(session, tests)

    def _summary(self, session: dict, tests: list[dict]) -> dict:
        activity = session["activity"]
        last = None
        if activity["lastResult"] is not None:
            outcomes = {outcome["index"]: outcome["passed"] for outcome in activity["lastResult"]["tests"]}
            hidden = [bool(test.get("hidden")) for test in tests]
            last = {
                "status": activity["lastStatus"],
                "publicPassed": sum(1 for index, held in enumerate(hidden) if not held and outcomes.get(index)),
                "publicTotal": hidden.count(False),
                "heldBackPassed": sum(1 for index, held in enumerate(hidden) if held and outcomes.get(index)),
                "heldBackTotal": hidden.count(True),
            }
        return {
            **self._clock(session),
            "id": session["id"],
            "title": session["title"],
            "candidateName": session["candidateName"],
            "candidateEmail": session["candidateEmail"],
            "candidateJoined": session["candidateUserId"] is not None,
            "problemId": session["problemId"],
            "problemSlug": session["problemSlug"],
            "problemTitle": session["problemTitle"],
            "problemDifficulty": session["problemDifficulty"],
            "aiPolicy": session["aiPolicy"],
            "inviteCode": session["inviteCode"],
            "roomId": session["roomId"],
            "heldBackRevealed": session["heldBackRevealedAt"] is not None,
            "isSample": session["isSample"],
            "createdAt": session["createdAt"],
            "updatedAt": session["updatedAt"],
            "runs": {"count": activity["runCount"], "lastRunAt": activity["lastRunAt"], "last": last},
            "assistant": {
                "turns": activity["aiTurns"],
                "costUsd": activity["aiCostUsd"],
                "inputTokens": activity["aiInputTokens"],
                "outputTokens": activity["aiOutputTokens"],
            },
            "evaluation": session["evaluationSummary"],
        }

    @staticmethod
    def _clock(session: dict) -> dict:
        return {
            "status": session["status"],
            "durationSeconds": session["durationSeconds"],
            "elapsedSeconds": session["elapsedSeconds"],
            "remainingSeconds": remaining_seconds(session),
            "runningSince": session["runningSince"],
            "startedAt": session["startedAt"],
            "endedAt": session["endedAt"],
            "serverNow": session["serverNow"],
        }

    async def brief(self, session: dict) -> dict:
        """The problem as this session presents it, edits applied."""
        problem = await self.problem_dao.get_by_id(session["problemId"])
        guide = await self.interview_dao.get_guide(session["problemId"])
        tests = (await self.problem_dao.get_judge_spec(session["problemId"]))["tests"]
        examples, held_back = split_cases(tests)
        library_criteria = guide["acceptanceCriteria"] if guide else []
        return {
            "id": problem["id"],
            "slug": problem["slug"],
            "title": problem["title"],
            "difficulty": problem["difficulty"],
            "statement": session["briefStatement"] if session["briefStatement"] is not None else problem["statement"],
            "acceptanceCriteria": session["briefCriteria"]
            if session["briefCriteria"] is not None
            else library_criteria,
            "starterCode": session["briefStarterCode"]
            if session["briefStarterCode"] is not None
            else problem["starterCode"],
            "timeLimitMs": problem["timeLimitMs"],
            "memLimitMb": problem["memLimitMb"],
            "examples": examples,
            "heldBackCount": len(held_back),
            "edited": {
                "statement": session["briefStatement"] is not None,
                "acceptanceCriteria": session["briefCriteria"] is not None,
                "starterCode": session["briefStarterCode"] is not None,
            },
            "_heldBack": held_back,
            "_guide": guide,
            "_library": {
                "statement": problem["statement"],
                "acceptanceCriteria": library_criteria,
                "starterCode": problem["starterCode"],
            },
        }

    async def view(self, session_id: UUID, caller_id: str) -> dict:
        """Everything one participant's screen needs, and nothing the other side holds."""
        session, role = await self.get_for(session_id, caller_id)
        brief = await self.brief(session)
        held_back, guide, library = brief.pop("_heldBack"), brief.pop("_guide"), brief.pop("_library")
        revealed = session["heldBackRevealedAt"] is not None
        view = {
            **self._clock(session),
            "id": session["id"],
            "title": session["title"],
            "role": role,
            "candidateName": session["candidateName"],
            "aiPolicy": session["aiPolicy"],
            "roomId": session["roomId"],
            "isSample": session["isSample"],
            "problem": brief,
            "heldBackRevealed": revealed,
            "heldBack": held_back if (role == INTERVIEWER or revealed) else None,
            "evidence": None,
            "interviewer": None,
        }
        if role == INTERVIEWER:
            view["interviewer"] = {
                "candidateEmail": session["candidateEmail"],
                "candidateJoined": session["candidateUserId"] is not None,
                "inviteCode": session["inviteCode"],
                "createdAt": session["createdAt"],
                "guide": guide["interviewerGuide"] if guide else None,
                "provenance": guide["provenance"] if guide else None,
                "referenceCode": guide["referenceCode"] if guide else None,
                "library": library,
                "canRevealHeldBack": await self.interview_dao.has_judged_run(session["roomId"]),
            }
            view["evidence"] = EVIDENCE
        return view

    # Creating and changing

    async def create(self, operator_id: str, payload) -> dict:
        if not await self.user_dao.exists(operator_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"User not found: {operator_id}")
        if not await self.problem_dao.exists(payload.problemId):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=f"Problem not found: {payload.problemId}"
            )
        brief = payload.brief
        session = await self.interview_dao.create(
            title=payload.title.strip(),
            candidate_name=payload.candidateName.strip(),
            candidate_email=(payload.candidateEmail or "").strip() or None,
            problem_id=payload.problemId,
            room_id=str(uuid4()),
            room_name=payload.title.strip()[:80],
            # 128 bits from the OS: the link is the candidate's only credential.
            invite_code=secrets.token_urlsafe(16),
            duration_seconds=payload.durationSeconds,
            ai_policy=payload.aiPolicy,
            brief_statement=brief.statement if brief else None,
            brief_criteria=brief.acceptanceCriteria if brief else None,
            brief_starter_code=brief.starterCode if brief else None,
            created_by=operator_id,
        )
        return await self.get_summary(session["id"])

    async def update(self, session_id: UUID, payload) -> dict:
        session = await self.get_session(session_id)
        given = payload.model_fields_set
        changes: dict = {}
        if "title" in given and payload.title is not None:
            changes["title"] = payload.title.strip()
        if "candidateName" in given and payload.candidateName is not None:
            changes["candidateName"] = payload.candidateName.strip()
        if "candidateEmail" in given:
            changes["candidateEmail"] = (payload.candidateEmail or "").strip() or None

        setup: dict = {}
        if "durationSeconds" in given and payload.durationSeconds is not None:
            setup["durationSeconds"] = payload.durationSeconds
        if "aiPolicy" in given and payload.aiPolicy is not None:
            setup["aiPolicy"] = payload.aiPolicy
        if "brief" in given and payload.brief is not None:
            edited = payload.brief.model_fields_set
            # A field sent as null goes back to the library's text.
            if "statement" in edited:
                setup["briefStatement"] = payload.brief.statement
            if "acceptanceCriteria" in edited:
                setup["briefCriteria"] = payload.brief.acceptanceCriteria
            if "starterCode" in edited:
                setup["briefStarterCode"] = payload.brief.starterCode
        if "problemId" in given and payload.problemId is not None and payload.problemId != session["problemId"]:
            if session["status"] != "scheduled" or await self.submission_dao.list_by_room(session["roomId"]):
                raise _conflict("The problem can only change before the session starts and before any run")
            if not await self.problem_dao.exists(payload.problemId):
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=f"Problem not found: {payload.problemId}"
                )
            setup["problemId"] = payload.problemId
            # Edits were written for the old problem. Keep any sent with this change.
            for key in ("briefStatement", "briefCriteria", "briefStarterCode"):
                setup.setdefault(key, None)
        if setup and session["status"] == "ended":
            raise _conflict("This session has ended. Reset it to change its setup.")

        await self.interview_dao.update(session_id, {**changes, **setup})
        return await self.get_summary(session_id)

    async def transition(self, session_id: UUID, action: str) -> dict:
        session = await self.get_session(session_id)
        move = {
            "start": self.interview_dao.start,
            "pause": self.interview_dao.pause,
            "end": self.interview_dao.end,
            "reset": self.interview_dao.reset,
        }[action]
        if not await move(session_id):
            raise _conflict(f"A session that is {session['status']} cannot {action}")
        return await self.get_summary(session_id)

    async def reveal(self, session_id: UUID, revealed: bool) -> dict:
        session = await self.get_session(session_id)
        if revealed and not await self.interview_dao.has_judged_run(session["roomId"]):
            raise _conflict("Held-back cases can be revealed after the candidate's first judged run")
        await self.interview_dao.set_revealed(session_id, revealed)
        return await self.get_summary(session_id)

    async def join(self, invite_code: str, caller_id: str) -> dict:
        """Redeem an invite. The first person to do so is the candidate."""
        session = await self.interview_dao.get_by_invite(invite_code)
        if not session:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is not valid")
        if is_operator(caller_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are signed in as an interviewer. Open the invite link as the candidate.",
            )
        if not await self.user_dao.exists(caller_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"User not found: {caller_id}")
        if not await self.interview_dao.bind_candidate(session["id"], caller_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This invite has already been used by someone else",
            )
        return {"sessionId": session["id"]}

    # Runs

    async def runs(self, session_id: UUID, caller_id: str) -> list[dict]:
        session, role = await self.get_for(session_id, caller_id)
        show = role == INTERVIEWER or session["heldBackRevealedAt"] is not None
        submissions = await self.submission_dao.list_by_room(session["roomId"])
        specs: dict[UUID, list[dict]] = {}
        views = []
        for submission in submissions:
            problem_id = submission["problemId"]
            if problem_id not in specs:
                specs[problem_id] = (await self.problem_dao.get_judge_spec(problem_id))["tests"]
            views.append(run_view(submission, specs[problem_id], show))
        return views

    async def run(self, session_id: UUID, run_id: UUID, caller_id: str) -> dict:
        session, role = await self.get_for(session_id, caller_id)
        submission = await self.submission_dao.get_by_id(run_id)
        if not submission or submission["roomId"] != session["roomId"]:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Run not found: {run_id}")
        show = role == INTERVIEWER or session["heldBackRevealedAt"] is not None
        tests = (await self.problem_dao.get_judge_spec(submission["problemId"]))["tests"]
        return run_view(submission, tests, show, with_code=True)

    # Evidence

    async def evaluation(self, session_id: UUID) -> dict:
        await self.get_session(session_id)
        saved = await self.interview_dao.get_evaluation(session_id)
        if saved:
            return {**saved, "saved": True}
        return {
            "sessionId": session_id,
            "evidence": {dimension: {"score": None, "note": ""} for dimension in DIMENSIONS},
            "summary": "",
            "recommendation": "undecided",
            "updatedBy": None,
            "updatedByName": None,
            "updatedAt": None,
            "saved": False,
        }

    async def save_evaluation(self, session_id: UUID, payload, operator_id: str) -> dict:
        await self.get_session(session_id)
        evidence = {
            dimension: {
                "score": getattr(payload.evidence, dimension).score,
                "note": getattr(payload.evidence, dimension).note.strip(),
            }
            for dimension in DIMENSIONS
        }
        saved = await self.interview_dao.save_evaluation(
            session_id, evidence, payload.summary.strip(), payload.recommendation, operator_id
        )
        return {**saved, "saved": True}

    async def export(self, session_id: UUID, turns: list[dict]) -> dict:
        """The evaluation as a document that stands on its own.

        Runs are listed as facts beside the evidence. Nothing here turns them
        into a score or a recommendation.
        """
        session = await self.interview_dao.get_with_activity(session_id)
        if not session:
            raise _not_found(session_id)
        evaluation = await self.evaluation(session_id)
        tests = (await self.problem_dao.get_judge_spec(session["problemId"]))["tests"]
        submissions = await self.submission_dao.list_by_room(session["roomId"])
        runs = []
        for submission in reversed(submissions):
            view = run_view(submission, tests, True)
            runs.append(
                {
                    "at": submission["createdAt"],
                    "by": submission["userName"],
                    "state": view["state"],
                    "publicPassed": view["public"]["passed"],
                    "publicTotal": view["public"]["total"],
                    "heldBackPassed": view["heldBack"]["passed"],
                    "heldBackTotal": view["heldBack"]["total"],
                }
            )
        by_role = {INTERVIEWER: 0, CANDIDATE: 0}
        for turn in turns:
            by_role[turn["askedAs"]] += 1
        return {
            "format": "tandemcode.interview-evaluation/v1",
            "exportedAt": datetime.now(timezone.utc),
            "session": {
                "id": session["id"],
                "title": session["title"],
                "candidate": {"name": session["candidateName"], "email": session["candidateEmail"]},
                "problem": {"slug": session["problemSlug"], "title": session["problemTitle"]},
                "aiPolicy": session["aiPolicy"],
                "aiEnabled": session["aiPolicy"] == "allowed",
                "status": session["status"],
                "durationSeconds": session["durationSeconds"],
                "elapsedSeconds": session["elapsedSeconds"],
                "startedAt": session["startedAt"],
                "endedAt": session["endedAt"],
                "heldBackRevealed": session["heldBackRevealedAt"] is not None,
                "isSample": session["isSample"],
            },
            "scale": {"0": SCORE_LABELS[0], "1": SCORE_LABELS[1], "2": SCORE_LABELS[2], "null": UNOBSERVED},
            "evidence": [
                {
                    "dimension": item["key"],
                    "label": item["label"],
                    "score": evaluation["evidence"][item["key"]]["score"],
                    "scoreLabel": SCORE_LABELS.get(evaluation["evidence"][item["key"]]["score"], UNOBSERVED),
                    "note": evaluation["evidence"][item["key"]]["note"],
                }
                for item in EVIDENCE
            ],
            "summary": evaluation["summary"],
            "recommendation": {
                "value": evaluation["recommendation"],
                "label": RECOMMENDATIONS[evaluation["recommendation"]],
                "source": "interviewer",
                "note": RECOMMENDATION_NOTE,
            },
            "saved": evaluation["saved"],
            "updatedAt": evaluation["updatedAt"],
            "updatedBy": evaluation["updatedByName"],
            "runs": runs,
            "assistant": {
                "policy": session["aiPolicy"],
                "turns": len(turns),
                "askedByCandidate": by_role[CANDIDATE],
                "askedByInterviewer": by_role[INTERVIEWER],
                "inputTokens": session["activity"]["aiInputTokens"],
                "outputTokens": session["activity"]["aiOutputTokens"],
                "costUsd": session["activity"]["aiCostUsd"],
            },
        }

    # Library and settings

    async def library(self) -> list[dict]:
        problems = await self.problem_dao.list_all()
        guides = await self.interview_dao.list_guides()
        tests = await self.interview_dao.list_problem_tests()
        used = await self.interview_dao.session_counts_by_problem()
        library = []
        for problem in problems:
            guide = guides.get(problem["id"])
            examples, held_back = split_cases(tests.get(problem["id"], []))
            library.append(
                {
                    "id": problem["id"],
                    "slug": problem["slug"],
                    "title": problem["title"],
                    "difficulty": problem["difficulty"],
                    "statement": problem["statement"],
                    "starterCode": problem["starterCode"],
                    "timeLimitMs": problem["timeLimitMs"],
                    "memLimitMb": problem["memLimitMb"],
                    "examples": examples,
                    "heldBack": held_back,
                    "sessionCount": used.get(problem["id"], 0),
                    "hasGuide": guide is not None,
                    "summary": guide["summary"] if guide else None,
                    "acceptanceCriteria": guide["acceptanceCriteria"] if guide else [],
                    "provenance": guide["provenance"] if guide else None,
                    "guide": guide["interviewerGuide"] if guide else None,
                    "referenceCode": guide["referenceCode"] if guide else None,
                    "recommendedDurationSeconds": guide["recommendedDurationSeconds"] if guide else None,
                }
            )
        # Problems written for interviews first, then the rest by title.
        library.sort(key=lambda item: (not item["hasGuide"], item["title"].lower()))
        return library

    async def settings(self) -> dict:
        return await self.interview_dao.get_settings()

    async def save_settings(self, payload) -> dict:
        return await self.interview_dao.save_settings(payload.defaultDurationSeconds, payload.defaultAiPolicy)

    async def judge_queue(self) -> dict:
        return await self.interview_dao.judge_queue()


def export_markdown(document: dict) -> str:
    """The same evaluation as export(), for reading rather than parsing."""
    session = document["session"]

    def when(value) -> str:
        return value.strftime("%Y-%m-%d %H:%M UTC") if value else "not recorded"

    def minutes(seconds: int) -> str:
        return f"{seconds // 60} min {seconds % 60:02d} s"

    lines = [
        f"# Interview evaluation: {session['title']}",
        "",
        f"- Candidate: {session['candidate']['name']}"
        + (f" ({session['candidate']['email']})" if session["candidate"]["email"] else ""),
        f"- Problem: {session['problem']['title']}",
        f"- AI assistant: {'allowed' if session['aiEnabled'] else 'disabled'} for this session",
        f"- Session: {session['status']}, {minutes(session['elapsedSeconds'])} used of {minutes(session['durationSeconds'])}",
        f"- Started: {when(session['startedAt'])}",
        f"- Ended: {when(session['endedAt'])}",
        f"- Evaluation saved: {when(document['updatedAt']) if document['saved'] else 'not saved yet'}"
        + (f" by {document['updatedBy']}" if document["updatedBy"] else ""),
    ]
    if session["isSample"]:
        lines.append("- Sample data: this session was seeded for a demonstration")
    lines += [
        "",
        "## Evidence",
        "",
        f"Scale: 0 {SCORE_LABELS[0].lower()}, 1 {SCORE_LABELS[1].lower()}, 2 {SCORE_LABELS[2].lower()}. "
        f"{UNOBSERVED} means there was no chance to observe it, which is not a zero.",
        "",
    ]
    for item in document["evidence"]:
        score = item["score"]
        shown = UNOBSERVED if score is None else f"{score} ({item['scoreLabel']})"
        lines.append(f"### {item['label']}: {shown}")
        lines.append("")
        lines.append(item["note"] or "No note recorded.")
        lines.append("")
    lines += ["## Summary", "", document["summary"] or "No summary recorded.", ""]
    recommendation = document["recommendation"]
    lines += ["## Recommendation", "", f"{recommendation['label']}. {recommendation['note']}", ""]

    lines += ["## Runs", ""]
    if document["runs"]:
        lines += ["| Time | By | Public examples | Held-back cases |", "| --- | --- | --- | --- |"]
        for run in document["runs"]:
            if run["state"] != "judged":
                lines.append(f"| {when(run['at'])} | {run['by']} | {run['state']} | {run['state']} |")
            else:
                lines.append(
                    f"| {when(run['at'])} | {run['by']} | {run['publicPassed']}/{run['publicTotal']} passed "
                    f"| {run['heldBackPassed']}/{run['heldBackTotal']} passed |"
                )
        lines += ["", "Runs are listed as facts. They do not produce a score or a recommendation."]
    else:
        lines.append("No runs were recorded.")
    assistant = document["assistant"]
    lines += ["", "## AI assistant use", ""]
    if assistant["policy"] != "allowed":
        lines.append("The assistant was disabled for this session.")
    else:
        asked = "1 question" if assistant["turns"] == 1 else f"{assistant['turns']} questions"
        lines.append(
            f"{asked}: {assistant['askedByCandidate']} by the candidate, "
            f"{assistant['askedByInterviewer']} by the interviewer. "
            f"{assistant['inputTokens']} input tokens, {assistant['outputTokens']} output tokens, "
            f"about ${assistant['costUsd']:.4f} at list price."
        )
    lines.append("")
    return "\n".join(lines)
