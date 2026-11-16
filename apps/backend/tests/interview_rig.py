"""Helpers for the interview tests: one interviewer, one candidate, real runs."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient

from app.dao.problems import ProblemDAO
from app.dao.submissions import SubmissionDAO
from app.main import app
from app.runner.__main__ import judge_next
from tests.rig import auth, room_socket

EXERCISE = "actual-grader-output"
REFERENCE = (Path(__file__).parent / "solutions" / f"{EXERCISE}.py").read_text()
# The four held-back cases the teaching variant gets wrong.
STARTER_FAILS = ["empty arrays", "whitespace log", "error metadata only", "placeholder with default max score"]


def problem(client, slug: str = EXERCISE) -> dict:
    response = client.get(f"/api/problems/slug/{slug}", headers=auth("user_alice"))
    assert response.status_code == 200, response.text
    return response.json()


def create_interview(client, **overrides) -> dict:
    payload = {
        "title": "Grader output exercise",
        "candidateName": "Bob Candidate",
        "problemId": problem(client)["id"],
        "durationSeconds": 420,
        "aiPolicy": "allowed",
        **overrides,
    }
    response = client.post("/api/interviews", json=payload, headers=auth("user_alice"))
    assert response.status_code == 200, response.text
    return response.json()


def join(client, interview: dict, user_id: str = "user_bob"):
    return client.post(
        "/api/interviews/join", json={"inviteCode": interview["inviteCode"]}, headers=auth(user_id)
    )


def act(client, interview: dict, action: str, user_id: str = "user_alice"):
    return client.post(f"/api/interviews/{interview['id']}/{action}", headers=auth(user_id))


def view(client, interview: dict, user_id: str) -> dict:
    response = client.get(f"/api/interviews/{interview['id']}", headers=auth(user_id))
    assert response.status_code == 200, response.text
    return response.json()


def run_code(client, interview: dict, code: str, user_id: str = "user_bob"):
    """Submit from inside the room, as the app does."""
    with room_socket(client, interview["roomId"], user_id):
        return client.post(
            "/api/submissions",
            json={
                "roomId": interview["roomId"],
                "problemId": interview["problemId"],
                "language": "python",
                "code": code,
            },
            headers=auth(user_id),
        )


def drain_queue(client) -> int:
    pool = client.app.state.db_pool
    judged = 0
    while client.portal.call(judge_next, SubmissionDAO(pool), ProblemDAO(pool)):
        judged += 1
    return judged


def started_with_candidate(client, interview: dict) -> dict:
    """Bob has joined and the clock is running."""
    assert join(client, interview).status_code == 200
    response = act(client, interview, "start")
    assert response.status_code == 200, response.text
    return response.json()


def judged_starter_run(client, interview: dict) -> dict:
    """Bob runs the untouched starter and the judge scores every case."""
    starter = view(client, interview, "user_bob")["problem"]["starterCode"]
    response = run_code(client, interview, starter)
    assert response.status_code == 200, response.text
    drain_queue(client)
    return response.json()


@contextmanager
def restarted(**client_options):
    """A second app instance over the same database, which is what a restart is.

    Both instances are the one `app` object, so the second start-up replaces
    the first's pool and listeners on `app.state`. They are put back on the
    way out, or the test's own client would be left holding a closed pool.
    """
    saved = dict(app.state._state)
    try:
        with TestClient(app, **client_options) as again:
            yield again
    finally:
        app.state._state.clear()
        app.state._state.update(saved)
