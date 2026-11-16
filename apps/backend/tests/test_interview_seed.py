"""Sample sessions: demo mode only, created once, and flagged as samples."""

from __future__ import annotations

import asyncio

from app import interview_seed
from app.core import demo_auth
from app.dao.problems import ProblemDAO
from app.dao.submissions import SubmissionDAO
from app.database import create_pool
from app.runner.__main__ import judge_next
from tests.interview_rig import restarted
from tests.test_demo_auth import CODE, LOCAL, bearer, demo_config  # noqa: F401  (a fixture)


def test_samples_are_refused_outside_demo_mode():
    assert "demo only" in asyncio.run(interview_seed.seed())


def test_samples_are_created_once_with_real_runs(demo_config, monkeypatch):  # noqa: F811
    async def judged_here(_submissions, _submission_id) -> bool:
        # No runner process in the suite: judge the queued run in place.
        pool = await create_pool()
        try:
            while await judge_next(SubmissionDAO(pool), ProblemDAO(pool)):
                pass
        finally:
            await pool.close()
        return True

    monkeypatch.setattr(interview_seed, "_judged", judged_here)
    assert asyncio.run(interview_seed.seed()) == "Created 3 sample sessions."
    assert "already exist" in asyncio.run(interview_seed.seed())

    with restarted(client=LOCAL) as demo:
        token = demo.post("/demo/operator-session", json={"accessCode": CODE}).json()["token"]
        listed = demo.get("/api/interviews", headers=bearer(token)).json()

    # Other tests leave their own sessions in the same database. Only the
    # seeded ones are flagged.
    sessions = {item["title"]: item for item in listed if item["isSample"]}
    assert len(sessions) == 3
    allowed = sessions["Rehearsal with AI allowed"]
    assert (allowed["status"], allowed["elapsedSeconds"], allowed["aiPolicy"]) == ("ended", 398, "allowed")
    assert allowed["startedAt"] < allowed["endedAt"]
    assert allowed["runs"]["count"] == 3
    assert allowed["runs"]["last"]["heldBackPassed"] == 8
    assert allowed["evaluation"]["scores"]["ownership"] is None
    # Seeded notes never decide anything, and nothing pretends the assistant was used.
    assert allowed["evaluation"]["recommendation"] == "undecided"
    assert allowed["assistant"]["turns"] == 0

    off = sessions["Rehearsal with AI off"]
    assert (off["status"], off["aiPolicy"], off["evaluation"]) == ("ended", "disabled", None)
    # The second attempt handles empty lists and whitespace and still counts
    # errors alone, so the two errors-only cases keep failing.
    assert (off["runs"]["count"], off["runs"]["last"]["heldBackPassed"]) == (2, 6)
    assert sessions["Warm-up on Two Sum"]["status"] == "scheduled"
    assert demo_auth.enabled()
