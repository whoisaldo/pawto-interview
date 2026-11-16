"""Interview sessions: who may run one, what is kept, and what each side sees."""

from __future__ import annotations

import json

from app.dao.submissions import SubmissionDAO
from tests.interview_rig import (
    REFERENCE,
    act,
    create_interview,
    drain_queue,
    join,
    judged_starter_run,
    problem,
    restarted,
    run_code,
    started_with_candidate,
    view,
)
from tests.rig import auth


def test_only_an_interviewer_can_create_or_list(client, operators):
    payload = {
        "title": "t",
        "candidateName": "c",
        "problemId": problem(client)["id"],
        "durationSeconds": 600,
        "aiPolicy": "allowed",
    }
    assert client.post("/api/interviews", json=payload, headers=auth("user_bob")).status_code == 403
    assert client.get("/api/interviews", headers=auth("user_bob")).status_code == 403
    assert client.get("/api/interviews/problems", headers=auth("user_bob")).status_code == 403
    assert client.get("/api/interviews", headers=auth("user_alice")).status_code == 200


def test_nobody_runs_interviews_until_someone_is_named(client, signed_up):
    """With no operator listed, the interviewer's side is closed to everyone."""
    signed_up("user_alice")
    assert client.get("/api/interviews", headers=auth("user_alice")).status_code == 403


def test_whether_ai_is_allowed_must_be_said(client, operators):
    payload = {
        "title": "t",
        "candidateName": "c",
        "problemId": problem(client)["id"],
        "durationSeconds": 600,
    }
    assert client.post("/api/interviews", json=payload, headers=auth("user_alice")).status_code == 422


def test_a_new_session_is_scheduled_with_its_own_unlisted_room(client, interview):
    assert interview["status"] == "scheduled"
    assert interview["remainingSeconds"] == 420
    assert interview["aiPolicy"] == "allowed"
    assert interview["candidateJoined"] is False
    assert len(interview["inviteCode"]) >= 16

    room = client.get(f"/api/rooms/{interview['roomId']}", headers=auth("user_alice")).json()
    assert room["visibility"] == "unlisted"
    assert room["currentProblemId"] == interview["problemId"]
    listed = client.get("/api/rooms", headers=auth("user_alice")).json()
    assert interview["roomId"] not in [item["id"] for item in listed]


def test_a_session_and_its_changes_survive_a_restart(client, interview):
    changed = client.patch(
        f"/api/interviews/{interview['id']}",
        json={
            "title": "Renamed",
            "candidateName": "Robert",
            "durationSeconds": 900,
            "aiPolicy": "disabled",
            "brief": {"acceptanceCriteria": ["Only this one"]},
        },
        headers=auth("user_alice"),
    )
    assert changed.status_code == 200, changed.text
    assert act(client, interview, "start").status_code == 200
    assert act(client, interview, "pause").status_code == 200

    with restarted() as again_client:
        again = again_client.get(f"/api/interviews/{interview['id']}/summary", headers=auth("user_alice")).json()
        assert (again["title"], again["candidateName"]) == ("Renamed", "Robert")
        assert (again["durationSeconds"], again["aiPolicy"], again["status"]) == (900, "disabled", "paused")
        assert again["id"] in [item["id"] for item in again_client.get("/api/interviews", headers=auth("user_alice")).json()]
        brief = again_client.get(f"/api/interviews/{interview['id']}", headers=auth("user_alice")).json()["problem"]
        assert brief["acceptanceCriteria"] == ["Only this one"]


def _rewind(client, interview: dict, seconds: int) -> None:
    """Pretend the current stretch started `seconds` ago."""

    async def rewind(pool):
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE interview_sessions SET running_since = NOW() - make_interval(secs => $2) WHERE id = $1",
                interview["id"],
                seconds,
            )

    client.portal.call(rewind, client.app.state.db_pool)


def test_the_clock_banks_time_across_pauses(client, interview):
    assert act(client, interview, "pause").status_code == 409
    running = act(client, interview, "start").json()
    assert running["status"] == "running" and running["runningSince"]

    _rewind(client, interview, 90)
    paused = act(client, interview, "pause").json()
    assert paused["status"] == "paused"
    assert 90 <= paused["elapsedSeconds"] <= 92
    assert paused["remainingSeconds"] == 420 - paused["elapsedSeconds"]
    assert act(client, interview, "pause").status_code == 409

    # Time does not pass while paused.
    still = client.get(f"/api/interviews/{interview['id']}/summary", headers=auth("user_alice")).json()
    assert still["elapsedSeconds"] == paused["elapsedSeconds"]

    assert act(client, interview, "start").json()["status"] == "running"
    _rewind(client, interview, 30)
    ended = act(client, interview, "end").json()
    assert ended["status"] == "ended" and ended["endedAt"]
    assert 120 <= ended["elapsedSeconds"] <= 124
    assert act(client, interview, "start").status_code == 409


def test_reset_returns_to_the_start_and_keeps_the_record(client, interview):
    started_with_candidate(client, interview)
    judged_starter_run(client, interview)
    assert client.put(
        f"/api/interviews/{interview['id']}/held-back", json={"revealed": True}, headers=auth("user_alice")
    ).status_code == 200

    reset = act(client, interview, "reset").json()
    assert (reset["status"], reset["elapsedSeconds"], reset["startedAt"]) == ("scheduled", 0, None)
    assert reset["heldBackRevealed"] is False
    # What happened still happened.
    assert reset["runs"]["count"] == 1
    assert reset["candidateJoined"] is True
    assert act(client, interview, "reset").status_code == 409


def test_running_over_is_shown_and_not_enforced(client, interview):
    started_with_candidate(client, interview)
    _rewind(client, interview, 500)
    over = client.get(f"/api/interviews/{interview['id']}/summary", headers=auth("user_alice")).json()
    assert over["status"] == "running"
    assert over["remainingSeconds"] <= -80
    # The interviewer ends a session. The clock does not.
    assert run_code(client, interview, "print('false')\n").status_code == 200


def test_the_first_person_to_redeem_the_invite_is_the_candidate(client, interview):
    assert client.get(f"/api/interviews/{interview['id']}", headers=auth("user_bob")).status_code == 404
    assert join(client, interview, "user_bob").json() == {"sessionId": interview["id"]}
    # Coming back is fine. Someone else arriving is not.
    assert join(client, interview, "user_bob").status_code == 200
    assert join(client, interview, "user_carol").status_code == 403
    assert client.get(f"/api/interviews/{interview['id']}", headers=auth("user_carol")).status_code == 404
    # An interviewer who opens the candidate's link does not take the seat.
    assert join(client, interview, "user_alice").status_code == 403
    assert client.post(
        "/api/interviews/join", json={"inviteCode": "not-a-real-invite-code"}, headers=auth("user_bob")
    ).status_code == 404


def test_the_candidate_is_shown_the_brief_and_nothing_held_back(client, interview):
    join(client, interview)
    response = client.get(f"/api/interviews/{interview['id']}", headers=auth("user_bob"))
    seen = response.json()

    assert seen["role"] == "candidate"
    assert "placeholder" in seen["problem"]["statement"]
    assert len(seen["problem"]["acceptanceCriteria"]) == 6
    assert [case["name"] for case in seen["problem"]["examples"]] == [
        "null result", "actual test row", "lint log", "captured stderr row",
    ]
    assert seen["problem"]["heldBackCount"] == 8
    assert seen["heldBack"] is None
    assert seen["interviewer"] is None and seen["evidence"] is None
    # Not anywhere in the response, under any key.
    for secret in (interview["inviteCode"], "whitespace log", "Reference answer", "changeRequest", "pawtograder/platform.git"):
        assert secret not in response.text, secret

    hosting = view(client, interview, "user_alice")
    assert hosting["role"] == "interviewer"
    assert len(hosting["heldBack"]) == 8
    assert hosting["interviewer"]["referenceCode"] == REFERENCE
    assert hosting["interviewer"]["guide"]["changeRequest"]["prompt"].startswith("Errors-only records")
    assert "146759bee573b633fa7dd8850d8c73194e8bdb0e" in hosting["interviewer"]["provenance"]
    assert [item["key"] for item in hosting["evidence"]] == [
        "clarification", "verification", "understanding", "ownership",
    ]


def test_brief_edits_belong_to_the_session_and_can_be_undone(client, interview):
    def edit(brief: dict):
        return client.patch(
            f"/api/interviews/{interview['id']}", json={"brief": brief}, headers=auth("user_alice")
        )

    library = view(client, interview, "user_alice")["problem"]
    assert edit({"statement": "Shorter brief.", "starterCode": "print('x')\n"}).status_code == 200
    edited = view(client, interview, "user_alice")["problem"]
    assert (edited["statement"], edited["starterCode"]) == ("Shorter brief.", "print('x')\n")
    assert edited["edited"] == {"statement": True, "acceptanceCriteria": False, "starterCode": True}
    assert edited["acceptanceCriteria"] == library["acceptanceCriteria"]

    # The library problem is untouched, for every other session.
    other = create_interview(client, title="Another")
    assert view(client, other, "user_alice")["problem"]["statement"] == library["statement"]
    assert problem(client)["statement"] == library["statement"]

    assert edit({"statement": None, "starterCode": None}).status_code == 200
    restored = view(client, interview, "user_alice")["problem"]
    assert (restored["statement"], restored["starterCode"]) == (library["statement"], library["starterCode"])
    assert restored["edited"]["statement"] is False


def test_the_problem_can_change_until_there_is_a_run(client, interview):
    two_sum = problem(client, "two-sum")

    def change():
        return client.patch(
            f"/api/interviews/{interview['id']}", json={"problemId": two_sum["id"]}, headers=auth("user_alice")
        )

    assert change().json()["problemSlug"] == "two-sum"
    room = client.get(f"/api/rooms/{interview['roomId']}", headers=auth("user_alice")).json()
    assert room["currentProblemId"] == two_sum["id"]

    act(client, interview, "start")
    back = client.patch(
        f"/api/interviews/{interview['id']}", json={"problemId": interview["problemId"]}, headers=auth("user_alice")
    )
    assert back.status_code == 409


def test_an_ended_session_keeps_its_setup(client, interview):
    act(client, interview, "start")
    act(client, interview, "end")
    refused = client.patch(
        f"/api/interviews/{interview['id']}", json={"aiPolicy": "disabled"}, headers=auth("user_alice")
    )
    assert refused.status_code == 409
    renamed = client.patch(
        f"/api/interviews/{interview['id']}", json={"title": "Filed"}, headers=auth("user_alice")
    )
    assert renamed.json()["title"] == "Filed"


def test_ai_policy_shows_on_both_sides_and_follows_a_change(client, interview):
    join(client, interview)
    for user in ("user_alice", "user_bob"):
        assert view(client, interview, user)["aiPolicy"] == "allowed"

    client.patch(f"/api/interviews/{interview['id']}", json={"aiPolicy": "disabled"}, headers=auth("user_alice"))
    for user in ("user_alice", "user_bob"):
        seen = view(client, interview, user)
        assert seen["aiPolicy"] == "disabled"
        assert seen["assistant"]["state"] == "policy_off"
    listed = client.get("/api/interviews", headers=auth("user_alice")).json()
    assert next(item for item in listed if item["id"] == interview["id"])["aiPolicy"] == "disabled"


def test_held_back_cases_are_revealed_after_an_attempt_and_not_before(client, interview):
    started_with_candidate(client, interview)

    def reveal(revealed: bool):
        return client.put(
            f"/api/interviews/{interview['id']}/held-back", json={"revealed": revealed}, headers=auth("user_alice")
        )

    assert reveal(True).status_code == 409
    assert view(client, interview, "user_alice")["interviewer"]["canRevealHeldBack"] is False
    assert reveal(True).status_code == 409

    judged_starter_run(client, interview)
    assert view(client, interview, "user_bob")["heldBack"] is None
    assert client.put(
        f"/api/interviews/{interview['id']}/held-back", json={"revealed": True}, headers=auth("user_bob")
    ).status_code == 403

    assert reveal(True).json()["heldBackRevealed"] is True
    shown = view(client, interview, "user_bob")
    assert shown["heldBackRevealed"] is True
    assert [case["name"] for case in shown["heldBack"]][2:4] == ["empty arrays", "whitespace log"]

    assert reveal(False).json()["heldBackRevealed"] is False
    assert view(client, interview, "user_bob")["heldBack"] is None


EVIDENCE = {
    "clarification": {"score": 2, "note": "Asked whether an empty list counts before editing."},
    "verification": {"score": 1, "note": "Ran the examples; wrote no case of their own."},
    "understanding": {"score": 0, "note": "Could not say why whitespace is not output."},
    "ownership": {"score": None, "note": ""},
}


def test_an_unsaved_evaluation_is_empty_and_undecided(client, interview):
    evaluation = client.get(f"/api/interviews/{interview['id']}/evaluation", headers=auth("user_alice")).json()
    assert evaluation["saved"] is False
    assert evaluation["recommendation"] == "undecided"
    assert all(item == {"score": None, "note": ""} for item in evaluation["evidence"].values())
    assert client.get(f"/api/interviews/{interview['id']}/evaluation", headers=auth("user_bob")).status_code == 403


def test_evidence_notes_are_saved_and_keep_unobserved_apart_from_zero(client, interview):
    saved = client.put(
        f"/api/interviews/{interview['id']}/evaluation",
        json={"evidence": EVIDENCE, "summary": "Careful at the start.", "recommendation": "hold"},
        headers=auth("user_alice"),
    )
    assert saved.status_code == 200, saved.text

    with restarted() as again_client:
        again = again_client.get(f"/api/interviews/{interview['id']}/evaluation", headers=auth("user_alice")).json()
    assert again["saved"] is True
    assert again["evidence"] == EVIDENCE
    assert again["evidence"]["understanding"]["score"] == 0
    assert again["evidence"]["ownership"]["score"] is None
    assert (again["summary"], again["recommendation"], again["updatedByName"]) == ("Careful at the start.", "hold", "Alice")

    listed = client.get("/api/interviews", headers=auth("user_alice")).json()
    summary = next(item for item in listed if item["id"] == interview["id"])["evaluation"]
    assert summary["scores"] == {"clarification": 2, "verification": 1, "understanding": 0, "ownership": None}

    too_high = {**EVIDENCE, "ownership": {"score": 3, "note": ""}}
    assert client.put(
        f"/api/interviews/{interview['id']}/evaluation", json={"evidence": too_high}, headers=auth("user_alice")
    ).status_code == 422
    assert client.put(
        f"/api/interviews/{interview['id']}/evaluation", json={"evidence": EVIDENCE}, headers=auth("user_bob")
    ).status_code == 403


def test_passing_every_test_recommends_nothing(client, interview):
    """A green run is a fact about the code. The recommendation is a person's."""
    started_with_candidate(client, interview)
    assert run_code(client, interview, REFERENCE).status_code == 200
    drain_queue(client)

    summary = client.get(f"/api/interviews/{interview['id']}/summary", headers=auth("user_alice")).json()
    assert summary["runs"]["last"] == {
        "status": "accepted", "publicPassed": 4, "publicTotal": 4, "heldBackPassed": 8, "heldBackTotal": 8,
    }
    assert summary["evaluation"] is None

    evaluation = client.get(f"/api/interviews/{interview['id']}/evaluation", headers=auth("user_alice")).json()
    assert evaluation["saved"] is False and evaluation["recommendation"] == "undecided"
    assert all(item["score"] is None for item in evaluation["evidence"].values())

    exported = client.get(f"/api/interviews/{interview['id']}/evaluation/export", headers=auth("user_alice")).json()
    assert exported["recommendation"]["value"] == "undecided"
    assert exported["recommendation"]["source"] == "interviewer"
    assert exported["runs"][0]["heldBackPassed"] == 8


def test_an_evaluation_exports_as_json_and_markdown(client, interview):
    started_with_candidate(client, interview)
    judged_starter_run(client, interview)
    client.put(
        f"/api/interviews/{interview['id']}/evaluation",
        json={"evidence": EVIDENCE, "summary": "Careful at the start.", "recommendation": "hold"},
        headers=auth("user_alice"),
    )

    response = client.get(f"/api/interviews/{interview['id']}/evaluation/export?format=json", headers=auth("user_alice"))
    assert response.status_code == 200, response.text
    assert "attachment" in response.headers["content-disposition"]
    document = json.loads(response.text)
    assert document["format"] == "tandemcode.interview-evaluation/v1"
    assert document["session"]["aiEnabled"] is True and document["session"]["aiPolicy"] == "allowed"
    assert document["session"]["candidate"]["name"] == "Bob Candidate"
    assert [(item["dimension"], item["score"], item["scoreLabel"]) for item in document["evidence"]] == [
        ("clarification", 2, "Clear"),
        ("verification", 1, "Partial"),
        ("understanding", 0, "Absent"),
        ("ownership", None, "Unobserved"),
    ]
    assert document["recommendation"]["label"] == "Needs another signal"
    assert document["runs"] == [
        {
            "at": document["runs"][0]["at"], "by": "Bob", "state": "judged",
            "publicPassed": 4, "publicTotal": 4, "heldBackPassed": 4, "heldBackTotal": 8,
        }
    ]
    assert document["assistant"] == {
        "policy": "allowed", "turns": 0, "askedByCandidate": 0, "askedByInterviewer": 0,
        "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0,
    }

    markdown = client.get(
        f"/api/interviews/{interview['id']}/evaluation/export?format=markdown", headers=auth("user_alice")
    )
    assert markdown.headers["content-type"].startswith("text/markdown")
    text = markdown.text
    assert "# Interview evaluation: Grader output exercise" in text
    assert "- AI assistant: allowed for this session" in text
    assert "### Tool ownership: Unobserved" in text
    assert "### Understanding: 0 (Absent)" in text
    assert "| 4/4 passed | 4/8 passed |" in text
    assert "Needs another signal. Entered by the interviewer." in text
    assert client.get(
        f"/api/interviews/{interview['id']}/evaluation/export", headers=auth("user_bob")
    ).status_code == 403


def test_the_library_gives_an_interviewer_the_whole_problem(client, operators):
    library = client.get("/api/interviews/problems", headers=auth("user_alice")).json()
    assert len(library) >= 16
    exercise = library[0]
    assert exercise["slug"] == "actual-grader-output" and exercise["hasGuide"] is True
    assert len(exercise["examples"]) == 4 and len(exercise["heldBack"]) == 8
    assert exercise["referenceCode"] == REFERENCE
    assert exercise["recommendedDurationSeconds"] == 420
    assert [item["hasGuide"] for item in library] == sorted((item["hasGuide"] for item in library), reverse=True)
    # The public problem endpoint is still the candidate-safe one.
    public = client.get("/api/problems/slug/actual-grader-output", headers=auth("user_bob"))
    assert "whitespace log" not in public.text and "Reference answer" not in public.text


def test_the_guide_reference_is_the_judged_solution(client, operators):
    """Two copies of the reference would drift. The suite judges one and compares the other."""
    library = client.get("/api/interviews/problems", headers=auth("user_alice")).json()
    assert library[0]["referenceCode"] == REFERENCE


def test_defaults_for_new_interviews_are_kept(client, operators):
    assert client.get("/api/interviews/settings", headers=auth("user_alice")).json()["defaultAiPolicy"] in (
        "allowed", "disabled",
    )
    saved = client.put(
        "/api/interviews/settings",
        json={"defaultDurationSeconds": 1500, "defaultAiPolicy": "disabled"},
        headers=auth("user_alice"),
    )
    assert saved.status_code == 200, saved.text
    with restarted() as again_client:
        again = again_client.get("/api/interviews/settings", headers=auth("user_alice")).json()
    assert (again["defaultDurationSeconds"], again["defaultAiPolicy"]) == (1500, "disabled")
    assert client.put(
        "/api/interviews/settings",
        json={"defaultDurationSeconds": 5, "defaultAiPolicy": "disabled"},
        headers=auth("user_alice"),
    ).status_code == 422
    assert client.get("/api/interviews/settings", headers=auth("user_bob")).status_code == 403


def test_the_console_reports_what_it_depends_on(client, interview):
    started_with_candidate(client, interview)
    run_code(client, interview, "print('false')\n")
    system = client.get("/api/interviews/system", headers=auth("user_alice")).json()
    assert system["authMode"] == "clerk"
    assert system["judge"]["waiting"] == 1
    assert system["assistant"]["ready"] is False and system["assistant"]["configured"] is False

    drain_queue(client)
    pool = client.app.state.db_pool
    assert client.portal.call(SubmissionDAO(pool).count_created_since, "user_bob", 60) >= 1
    system = client.get("/api/interviews/system", headers=auth("user_alice")).json()
    assert system["judge"]["waiting"] == 0 and system["judge"]["lastJudgedAt"]
