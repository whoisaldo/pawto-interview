"""Sample interview sessions for a demonstration.

    AUTH_MODE=demo python -m app.interview_seed

Demo mode only, and safe to run twice: it does nothing once samples exist.
Every sample is flagged and shown as one. Their runs are real: the code is
queued like any submission and the runner judges it, so start the runner
first. No assistant conversation is made up; a sample shows none.
"""

from __future__ import annotations

import asyncio
import logging

from app.core import demo_auth
from app.dao.interviews import DIMENSIONS, InterviewDAO
from app.dao.problems import ProblemDAO
from app.dao.submissions import SubmissionDAO
from app.dao.users import UserDAO
from app.database import create_pool
from app.migrate import migrate

logger = logging.getLogger(__name__)

EXERCISE = "actual-grader-output"
JUDGE_WAIT_SECONDS = 90

# A plausible second attempt: empty lists and whitespace are handled, and
# errors alone still count. That leaves the two errors-only cases failing, so
# a sample shows a run that is neither all wrong nor all right.
PARTIAL_FIX = (
    'result.get("grader_result_tests") is not None',
    'len(result.get("grader_result_tests") or []) > 0',
), (
    'or result.get("lint_output")',
    'or (result.get("lint_output") or "").strip()',
), (
    'or result.get("grader_result_output") is not None',
    'or len(result.get("grader_result_output") or []) > 0',
)

SAMPLES = [
    {
        "title": "Rehearsal with AI allowed",
        "candidate": "Jordan Avery",
        "slug": EXERCISE,
        "seconds": 420,
        "ai": "allowed",
        "ended": {"elapsed": 398, "minutes_ago": 190},
        "runs": ["starter", "partial", "reference"],
        "evaluation": {
            "clarification": (2, "Sample note. Asked whether an empty list counts as output before changing anything."),
            "verification": (1, "Sample note. Reran the examples after each edit and wrote one case of their own."),
            "understanding": (2, "Sample note. Explained why a whitespace-only log is not output without prompting."),
            "ownership": (None, ""),
            "summary": "Sample evaluation, seeded so the Evaluations page has something to show. Not a real person.",
        },
    },
    {
        "title": "Rehearsal with AI off",
        "candidate": "Sam Okafor",
        "slug": EXERCISE,
        "seconds": 420,
        "ai": "disabled",
        "ended": {"elapsed": 421, "minutes_ago": 95},
        "runs": ["starter", "partial"],
        "evaluation": None,
    },
    {
        "title": "Warm-up on Two Sum",
        "candidate": "Riley Chen",
        "slug": "two-sum",
        "seconds": 1200,
        "ai": "disabled",
        "ended": None,
        "runs": [],
        "evaluation": None,
    },
]


async def _judged(submissions: SubmissionDAO, submission_id) -> bool:
    """Wait for the runner. The next run by the same person cannot queue until it has."""
    for _ in range(JUDGE_WAIT_SECONDS * 2):
        submission = await submissions.get_by_id(submission_id)
        if submission["status"] not in ("pending", "running"):
            return True
        await asyncio.sleep(0.5)
    return False


async def seed() -> str:
    if not demo_auth.enabled():
        return "Sample sessions are for AUTH_MODE=demo only. Nothing was created."
    demo_auth.validate_config()
    await migrate()
    pool = await create_pool()
    try:
        interviews, problems = InterviewDAO(pool), ProblemDAO(pool)
        submissions, users = SubmissionDAO(pool), UserDAO(pool)
        if await interviews.has_samples():
            return "Sample sessions already exist. Nothing was created."

        await users.create(demo_auth.OPERATOR_ID, demo_auth.OPERATOR_EMAIL, demo_auth.OPERATOR_NAME)
        created = 0
        for index, sample in enumerate(SAMPLES):
            problem = await problems.get_by_slug(sample["slug"])
            session = await interviews.create(
                title=sample["title"],
                candidate_name=sample["candidate"],
                candidate_email=None,
                problem_id=problem["id"],
                room_id=f"sample-{index}-{problem['id']}",
                room_name=sample["title"],
                invite_code=f"sample-invite-{index}-{str(problem['id'])[:8]}",
                duration_seconds=sample["seconds"],
                ai_policy=sample["ai"],
                brief_statement=None,
                brief_criteria=None,
                brief_starter_code=None,
                created_by=demo_auth.OPERATOR_ID,
                is_sample=True,
            )
            created += 1

            if sample["runs"]:
                candidate_id = demo_auth.candidate_user_id(str(session["id"]))
                await users.create(candidate_id, f"{candidate_id}@demo.invalid", sample["candidate"])
                await interviews.bind_candidate(session["id"], candidate_id)
                starter = problem["starterCode"]
                partial = starter
                for old, new in PARTIAL_FIX:
                    partial = partial.replace(old, new)
                guide = await interviews.get_guide(problem["id"])
                code = {"starter": starter, "partial": partial, "reference": guide["referenceCode"]}
                for kind in sample["runs"]:
                    run = await submissions.create(session["roomId"], candidate_id, problem["id"], "python", code[kind])
                    if not await _judged(submissions, run["id"]):
                        logger.warning("The runner did not judge a sample run. Is it running?")
                        break

            if sample["ended"]:
                await interviews.set_sample_history(
                    session["id"], sample["ended"]["elapsed"], sample["ended"]["minutes_ago"]
                )
            if sample["evaluation"]:
                evidence = {
                    dimension: {"score": sample["evaluation"][dimension][0], "note": sample["evaluation"][dimension][1]}
                    for dimension in DIMENSIONS
                }
                await interviews.save_evaluation(
                    session["id"], evidence, sample["evaluation"]["summary"], "undecided", demo_auth.OPERATOR_ID
                )
        return f"Created {created} sample sessions."
    finally:
        await pool.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    print(asyncio.run(seed()))
