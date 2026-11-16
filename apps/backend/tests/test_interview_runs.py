"""Runs in an interview room: every case is judged, and held-back ones stay held back."""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from app.dao.problems import ProblemDAO
from app.runner.judge import ACCEPTED, WRONG_ANSWER, judge
from tests.interview_rig import (
    REFERENCE,
    STARTER_FAILS,
    act,
    drain_queue,
    join,
    judged_starter_run,
    problem,
    run_code,
    started_with_candidate,
)
from tests.rig import auth, room_socket, roster, token

HELD_BACK_NAMES = ["empty arrays", "whitespace log", "error metadata only", "errors plus actual output"]


def runs(client, interview: dict, user_id: str) -> list[dict]:
    response = client.get(f"/api/interviews/{interview['id']}/runs", headers=auth(user_id))
    assert response.status_code == 200, response.text
    return response.json()


def test_the_starter_passes_every_example_and_fails_four_held_back_cases(client, operators):
    """The exercise only works if a green public run proves nothing."""
    dao = ProblemDAO(client.app.state.db_pool)
    exercise = problem(client)
    spec = client.portal.call(dao.get_judge_spec, exercise["id"])
    assert spec["stopOnFailure"] is False

    verdict = judge(exercise["starterCode"], spec["tests"], spec["timeLimitMs"], spec["memLimitMb"], False)
    assert len(verdict.tests) == 12
    failed = [spec["tests"][outcome.index]["name"] for outcome in verdict.tests if not outcome.passed]
    assert failed == STARTER_FAILS
    assert [outcome.passed for outcome in verdict.tests[:4]] == [True] * 4
    assert (verdict.status, verdict.passed, verdict.total) == (WRONG_ANSWER, 8, 12)

    reference = judge(REFERENCE, spec["tests"], spec["timeLimitMs"], spec["memLimitMb"], False)
    assert (reference.status, reference.passed) == (ACCEPTED, 12)


def test_judging_every_case_is_opt_in(client, operators):
    """Practice problems still stop at the first failure."""
    dao = ProblemDAO(client.app.state.db_pool)
    spec = client.portal.call(dao.get_judge_spec, problem(client, "two-sum")["id"])
    assert spec["stopOnFailure"] is True


def test_a_candidate_sees_the_examples_and_not_what_is_held_back(client, interview):
    started_with_candidate(client, interview)
    submission = judged_starter_run(client, interview)

    response = client.get(f"/api/interviews/{interview['id']}/runs", headers=auth("user_bob"))
    (run,) = response.json()
    assert run["state"] == "judged"
    assert (run["public"]["passed"], run["public"]["total"], run["public"]["status"]) == (4, 4, "passed")
    assert [case["name"] for case in run["public"]["cases"]] == [
        "null result", "actual test row", "lint log", "captured stderr row",
    ]
    assert run["public"]["cases"][1]["stdout"].strip() == "true"
    assert run["heldBack"] is None and "overallStatus" not in run
    assert run["heldBackCount"] == 8
    for name in HELD_BACK_NAMES:
        assert name not in response.text, name

    # The interviewer sees every case of the same run.
    (hosted,) = runs(client, interview, "user_alice")
    assert hosted["overallStatus"] == "wrong_answer"
    assert (hosted["heldBack"]["passed"], hosted["heldBack"]["total"]) == (4, 8)
    assert [case["name"] for case in hosted["heldBack"]["cases"] if not case["passed"]] == STARTER_FAILS

    detail = client.get(f"/api/interviews/{interview['id']}/runs/{submission['id']}", headers=auth("user_bob")).json()
    assert "hasActualGraderOutput" in detail["code"] and detail["heldBack"] is None


def test_the_older_room_paths_hold_back_the_same_cases(client, interview):
    """The room's own run list, single run, replay and socket all carry runs."""
    started_with_candidate(client, interview)
    room_id = interview["roomId"]

    with room_socket(client, room_id, "user_bob") as bob:
        roster(bob)
        submission = client.post(
            "/api/submissions",
            json={"roomId": room_id, "problemId": interview["problemId"], "language": "python",
                  "code": problem(client)["starterCode"]},
            headers=auth("user_bob"),
        ).json()
        drain_queue(client)
        while True:
            event = bob.receive_json()
            if event["type"] == "submission" and event["submission"]["status"] not in ("pending", "running"):
                heard = event["submission"]
                break

    listed = client.get(f"/api/submissions/room/{room_id}", headers=auth("user_bob")).json()[0]
    single = client.get(f"/api/submissions/{submission['id']}", headers=auth("user_bob")).json()
    replayed = client.get(f"/api/rooms/{room_id}/replay", headers=auth("user_bob")).json()["submissions"][0]
    for seen in (heard, listed, single, replayed):
        assert seen["status"] == "accepted"
        assert (seen["result"]["passed"], seen["result"]["total"]) == (4, 4)
        assert all(not outcome["hidden"] for outcome in seen["result"]["tests"])
        assert len(seen["result"]["tests"]) == 4

    # The interviewer's copy over the same path is whole.
    whole = client.get(f"/api/submissions/{submission['id']}", headers=auth("user_alice")).json()
    assert (whole["status"], whole["result"]["passed"], whole["result"]["total"]) == ("wrong_answer", 8, 12)

    # After the reveal there is nothing left to hold back.
    client.put(f"/api/interviews/{interview['id']}/held-back", json={"revealed": True}, headers=auth("user_alice"))
    shown = client.get(f"/api/submissions/{submission['id']}", headers=auth("user_bob")).json()
    assert (shown["status"], shown["result"]["total"]) == ("wrong_answer", 12)
    (run,) = runs(client, interview, "user_bob")
    assert [case["name"] for case in run["heldBack"]["cases"] if not case["passed"]] == STARTER_FAILS
    assert "whitespace" in run["heldBack"]["cases"][3]["name"]


def test_a_failing_example_is_reported_case_by_case(client, interview):
    started_with_candidate(client, interview)
    assert run_code(client, interview, "print('false')\n").status_code == 200
    drain_queue(client)

    (run,) = runs(client, interview, "user_bob")
    # Every case ran, though the second one already failed.
    assert [case["passed"] for case in run["public"]["cases"]] == [True, False, False, False]
    assert all(case["ran"] for case in run["public"]["cases"])
    assert (run["public"]["passed"], run["public"]["status"]) == (1, "wrong_answer")
    assert run["judgeFailed"] is False


def test_a_candidate_runs_only_while_the_session_is_running(client, interview):
    join(client, interview)
    code = "print('false')\n"
    assert run_code(client, interview, code).status_code == 409

    act(client, interview, "start")
    assert run_code(client, interview, code).status_code == 200
    drain_queue(client)

    act(client, interview, "pause")
    refused = run_code(client, interview, code)
    assert refused.status_code == 409 and "running" in refused.json()["detail"]
    # The interviewer can still try something while it is paused.
    assert run_code(client, interview, code, "user_alice").status_code == 200
    drain_queue(client)

    act(client, interview, "start")
    act(client, interview, "end")
    assert run_code(client, interview, code).status_code == 409


def test_an_interview_room_runs_its_own_problem(client, interview):
    started_with_candidate(client, interview)
    with room_socket(client, interview["roomId"], "user_bob"):
        response = client.post(
            "/api/submissions",
            json={"roomId": interview["roomId"], "problemId": problem(client, "two-sum")["id"],
                  "language": "python", "code": "print(1)\n"},
            headers=auth("user_bob"),
        )
    assert response.status_code == 409


def test_an_interview_room_is_closed_to_everyone_else(client, interview):
    """A practice room opens to anyone with its id. This one does not."""
    started_with_candidate(client, interview)
    room_id = interview["roomId"]
    for path in ("room", "yjs"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/{path}/{room_id}?token={token('user_carol')}"):
                pass
    assert client.get(f"/api/interviews/{interview['id']}/runs", headers=auth("user_carol")).status_code == 404

    with room_socket(client, room_id, "user_alice") as alice, room_socket(client, room_id, "user_bob") as bob:
        assert ("user_bob", "participant") in roster(bob)
        roster(alice)


def test_session_changes_are_announced_to_the_room(client, interview):
    join(client, interview)
    with room_socket(client, interview["roomId"], "user_bob") as bob:
        roster(bob)
        act(client, interview, "start")
        while True:
            event = bob.receive_json()
            if event["type"] == "interview":
                break
    assert event == {"type": "interview", "sessionId": interview["id"], "what": "session"}
