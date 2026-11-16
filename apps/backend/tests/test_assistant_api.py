"""The interview assistant over HTTP: the AI policy, what is attached, and what is kept.

The CLI is the stand-in from tests/fake_claude.py, so these check everything
around the model and never call one.
"""

from __future__ import annotations

import json
import os
import threading
import time
from uuid import uuid4

import pytest

from app.assistant import cli
from app.dao.ai_turns import AiTurnDAO
from tests.interview_rig import (
    act,
    create_interview,
    join,
    judged_starter_run,
    restarted,
    started_with_candidate,
    view,
)
from tests.rig import auth, room_socket, roster
from tests.test_assistant_cli import FAKE

CODE = "def marker_in_the_editor():\n    return 'only when attached'\n"


@pytest.fixture
def assistant(client, tmp_path):
    """Point the running app at the stand-in CLI."""
    profile = tmp_path / "profile"
    profile.mkdir()
    workdir = tmp_path / "workdir"
    workdir.mkdir(mode=0o700)
    settings = cli.CliSettings(
        command=FAKE, config_dir=profile, workdir=workdir, model="fake-model-1", effort="low", timeout_seconds=20
    )
    hub = client.app.state.assistant_hub
    hub.settings, hub.problem = settings, None
    yield settings
    hub.settings = None


def behave(settings, **behavior) -> None:
    (settings.config_dir / "behavior.json").write_text(json.dumps(behavior))


def sent(settings) -> dict:
    return json.loads((settings.config_dir / "record.json").read_text())


def ask(client, interview, user_id="user_bob", **body):
    payload = {"question": "Why might this be wrong?", **body}
    return client.post(
        f"/api/interviews/{interview['id']}/assistant/turns", json=payload, headers=auth(user_id)
    )


def events(response) -> list[tuple[str, dict]]:
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    parsed = []
    for block in response.text.strip().split("\n\n"):
        name, data = block.split("\n", 1)
        parsed.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return parsed


def turns(client, interview, user_id="user_alice") -> list[dict]:
    response = client.get(f"/api/interviews/{interview['id']}/assistant/turns", headers=auth(user_id))
    assert response.status_code == 200, response.text
    return response.json()


def test_with_ai_disabled_nothing_is_asked_and_nothing_is_run(client, operators, assistant):
    interview = create_interview(client, aiPolicy="disabled")
    started_with_candidate(client, interview)
    assert view(client, interview, "user_bob")["assistant"]["state"] == "policy_off"

    for user in ("user_bob", "user_alice"):
        refused = ask(client, interview, user, context={"prompt": True})
        assert refused.status_code == 403
        assert refused.headers["x-assistant-state"] == "policy_off"
        assert refused.json()["detail"] == "AI assistance is off for this session."
    assert not (assistant.config_dir / "record.json").exists()
    assert turns(client, interview) == []


def test_turning_ai_off_mid_session_takes_effect_at_once(client, interview, assistant):
    started_with_candidate(client, interview)
    assert events(ask(client, interview))[-1][1]["status"] == "completed"

    client.patch(f"/api/interviews/{interview['id']}", json={"aiPolicy": "disabled"}, headers=auth("user_alice"))
    assert ask(client, interview).status_code == 403
    # What was asked while it was allowed stays on the record.
    assert len(turns(client, interview)) == 1


def test_an_assistant_that_is_not_set_up_says_so_and_never_answers(client, interview):
    """No CLI configured: the honest answer is that there is no answer."""
    started_with_candidate(client, interview)
    assert view(client, interview, "user_bob")["assistant"]["state"] == "not_configured"
    refused = ask(client, interview)
    assert refused.status_code == 503
    assert refused.headers["x-assistant-state"] == "not_configured"
    assert turns(client, interview) == []


def test_a_broken_setup_is_explained_to_the_interviewer_only(client, interview):
    started_with_candidate(client, interview)
    hub = client.app.state.assistant_hub
    hub.settings, hub.problem = None, "CLAUDE_CLI_CONFIG_DIR names a reserved Claude profile."
    try:
        assert view(client, interview, "user_alice")["assistant"]["detail"] == hub.problem
        seen = view(client, interview, "user_bob")["assistant"]
        assert seen["state"] == "misconfigured" and "reserved" not in seen["detail"]
        assert ask(client, interview).status_code == 503
    finally:
        hub.problem = None


def test_an_answer_streams_and_is_stored_with_its_usage(client, interview, assistant):
    started_with_candidate(client, interview)
    stream = events(ask(client, interview, context={"prompt": True}))

    names = [name for name, _ in stream]
    assert names == ["turn", "started", "thinking", "delta", "delta", "delta", "done"]
    first = stream[0][1]
    assert (first["status"], first["askedAs"], first["model"]) == ("running", "candidate", "fake-model-1")
    assert [item["kind"] for item in first["context"]] == ["problem"]
    assert "".join(data["text"] for name, data in stream if name == "delta") == "Check the empty list case."
    done = stream[-1][1]
    assert (done["status"], done["answer"], done["error"]) == ("completed", "Check the empty list case.", None)
    assert done["usage"] == {
        "inputTokens": 321, "outputTokens": 45, "cacheReadTokens": 7, "cacheWriteTokens": 3,
        "costUsd": 0.0125, "durationMs": 432, "firstTokenMs": done["usage"]["firstTokenMs"],
    }

    # The interviewer reads the same turn, and the session's totals follow.
    (stored,) = turns(client, interview, "user_alice")
    assert (stored["id"], stored["userName"], stored["question"]) == (done["id"], "Bob", "Why might this be wrong?")
    summary = client.get(f"/api/interviews/{interview['id']}/summary", headers=auth("user_alice")).json()
    # 321 fresh, 7 read from the prompt cache and 3 written to it: all of it was sent.
    assert summary["assistant"] == {"turns": 1, "costUsd": 0.0125, "inputTokens": 331, "outputTokens": 45}
    assert view(client, interview, "user_bob")["assistant"]["turnsUsed"] == 1


def test_only_what_was_ticked_is_sent(client, interview, assistant):
    started_with_candidate(client, interview)
    judged_starter_run(client, interview)

    # Nothing ticked: the editor's text came along in the request and is still not sent.
    stream = events(ask(client, interview, code=CODE))
    assert stream[0][1]["context"] == []
    prompt = sent(assistant)["stdin"]
    assert "Nothing was attached" in prompt and "Why might this be wrong?" in prompt
    for absent in ("marker_in_the_editor", "gradebook", "Latest judged run", "null result"):
        assert absent not in prompt, absent

    stream = events(ask(client, interview, code=CODE, context={"code": True}))
    assert [item["kind"] for item in stream[0][1]["context"]] == ["code"]
    assert stream[0][1]["context"][0]["bytes"] == len(CODE.encode())
    prompt = sent(assistant)["stdin"]
    assert "marker_in_the_editor" in prompt and "gradebook" not in prompt and "Latest judged run" not in prompt

    stream = events(ask(client, interview, context={"prompt": True, "tests": True}))
    assert [item["kind"] for item in stream[0][1]["context"]] == ["problem", "test-results"]
    prompt = sent(assistant)["stdin"]
    assert "gradebook" in prompt and "4 of 4 public examples passed" in prompt
    assert "marker_in_the_editor" not in prompt


def test_held_back_cases_never_reach_the_candidates_assistant(client, interview, assistant):
    started_with_candidate(client, interview)
    judged_starter_run(client, interview)
    everything = {"prompt": True, "code": True, "tests": True}

    events(ask(client, interview, code=CODE, context=everything))
    prompt = sent(assistant)["stdin"]
    for held_back in ("whitespace log", "empty arrays", "error metadata only", "Held-back"):
        assert held_back not in prompt, held_back
    assert "have not seen any held-back test case" in sent(assistant)["argv"][sent(assistant)["argv"].index("--system-prompt") + 1]

    # The interviewer's own question can include them: they can already see them.
    events(ask(client, interview, "user_alice", code=CODE, context=everything))
    assert "Held-back cases: 4 of 8 passed" in sent(assistant)["stdin"]

    # And so can the candidate's, once they have been revealed.
    client.put(f"/api/interviews/{interview['id']}/held-back", json={"revealed": True}, headers=auth("user_alice"))
    events(ask(client, interview, context=everything, code=CODE))
    assert "whitespace log: FAILED" in sent(assistant)["stdin"]


def test_a_follow_up_carries_the_conversation_and_a_new_one_does_not(client, interview, assistant):
    started_with_candidate(client, interview)
    first = events(ask(client, interview, question="What is a placeholder record?"))[-1][1]

    events(ask(client, interview, question="And an empty list?", conversationId=first["conversationId"]))
    prompt = sent(assistant)["stdin"]
    assert "They asked: What is a placeholder record?" in prompt
    assert "You answered: Check the empty list case." in prompt

    events(ask(client, interview, question="Unrelated."))
    assert "placeholder record" not in sent(assistant)["stdin"]

    # Someone else cannot pull a conversation into their own prompt.
    events(ask(client, interview, "user_alice", question="Mine.", conversationId=first["conversationId"]))
    assert "placeholder record" not in sent(assistant)["stdin"]


def test_a_candidate_asks_only_while_the_session_runs(client, interview, assistant):
    join(client, interview)
    assert ask(client, interview).status_code == 409
    # The interviewer can try it before starting.
    assert events(ask(client, interview, "user_alice"))[-1][1]["status"] == "completed"

    act(client, interview, "start")
    assert ask(client, interview).status_code == 200
    act(client, interview, "pause")
    refused = ask(client, interview)
    assert refused.status_code == 409 and refused.headers["x-assistant-state"] == "not_running"
    act(client, interview, "start")
    act(client, interview, "end")
    assert ask(client, interview).headers["x-assistant-state"] == "ended"
    assert ask(client, interview, "user_alice").status_code == 409


def test_someone_outside_the_session_cannot_ask_or_read(client, interview, assistant):
    started_with_candidate(client, interview)
    events(ask(client, interview))
    assert ask(client, interview, "user_carol").status_code == 404
    assert client.get(
        f"/api/interviews/{interview['id']}/assistant/turns", headers=auth("user_carol")
    ).status_code == 404
    assert not any("carol" in json.dumps(turn) for turn in turns(client, interview))


def test_a_candidate_reads_their_own_questions_and_the_interviewer_reads_all(client, interview, assistant):
    started_with_candidate(client, interview)
    events(ask(client, interview, "user_alice", question="Trying it out."))
    events(ask(client, interview, "user_bob", question="My question."))

    assert [turn["question"] for turn in turns(client, interview, "user_bob")] == ["My question."]
    assert [(turn["question"], turn["askedAs"]) for turn in turns(client, interview, "user_alice")] == [
        ("Trying it out.", "interviewer"), ("My question.", "candidate"),
    ]


def test_oversized_input_is_refused_and_never_cut_silently(client, interview, assistant):
    started_with_candidate(client, interview)
    assert ask(client, interview, question="x" * 4001).status_code == 422
    assert ask(client, interview, question="   ").status_code == 422
    assert ask(client, interview, context={"code": True}).status_code == 422

    big = ask(client, interview, code="x" * (33 * 1024), context={"code": True})
    assert big.status_code == 413 and "untick Code" in big.json()["detail"]
    assert not (assistant.config_dir / "record.json").exists()
    assert turns(client, interview) == []


def test_a_session_has_a_fixed_number_of_questions(client, interview, assistant, monkeypatch):
    monkeypatch.setattr("app.services.assistant.MAX_TURNS_PER_SESSION", 2)
    started_with_candidate(client, interview)
    events(ask(client, interview))
    events(ask(client, interview))
    refused = ask(client, interview)
    assert refused.status_code == 429 and refused.headers["x-assistant-state"] == "limit_reached"
    assert view(client, interview, "user_bob")["assistant"]["state"] == "limit_reached"


def test_a_failure_is_reported_as_one_and_its_detail_is_the_interviewers(client, interview, assistant):
    started_with_candidate(client, interview)
    behave(assistant, mode="crash")
    done = events(ask(client, interview))[-1][1]
    assert done["status"] == "failed" and done["answer"] == ""
    assert done["error"] == "The assistant could not answer. Your interviewer can see the details."

    (stored,) = turns(client, interview, "user_alice")
    assert "status 3" in stored["error"] and "abcdefghijklmnopqrstuvwxyz" not in stored["error"]
    assert turns(client, interview, "user_bob")[0]["error"] == done["error"]


def test_the_model_that_answered_is_what_gets_recorded(client, interview, assistant):
    started_with_candidate(client, interview)
    behave(assistant, mode="answer", answered_by="some-other-model")
    done = events(ask(client, interview))[-1][1]
    assert done["model"] == "some-other-model"
    # The configured one is still shown beside it, so a difference is visible.
    assert view(client, interview, "user_bob")["assistant"]["model"] == "fake-model-1"


def wait_for_running_turn(client, interview) -> dict:
    for _ in range(100):
        running = [turn for turn in turns(client, interview) if turn["status"] == "running"]
        if running:
            return running[0]
        time.sleep(0.05)
    raise AssertionError("the question never started")


def test_cancelling_stops_the_cli_and_records_it(client, interview, assistant):
    started_with_candidate(client, interview)
    behave(assistant, mode="slow")
    finished: list = []
    asking = threading.Thread(target=lambda: finished.append(ask(client, interview)))
    asking.start()
    try:
        running = wait_for_running_turn(client, interview)
        for _ in range(100):
            if (assistant.config_dir / "record.json").exists():
                break
            time.sleep(0.05)

        # One question at a time per person.
        second = ask(client, interview)
        assert second.status_code == 429 and second.headers["x-assistant-state"] == "in_flight"
        # Not somebody else's to stop, unless they are the interviewer.
        assert client.post(
            f"/api/interviews/{interview['id']}/assistant/turns/{running['id']}/cancel", headers=auth("user_carol")
        ).status_code == 404

        cancelled = client.post(
            f"/api/interviews/{interview['id']}/assistant/turns/{running['id']}/cancel", headers=auth("user_bob")
        )
        assert cancelled.json()["cancelling"] is True
    finally:
        asking.join(timeout=30)
    assert not asking.is_alive()

    done = events(finished[0])[-1][1]
    assert (done["status"], done["answer"]) == ("cancelled", "Thinking about it")
    assert turns(client, interview)[0]["status"] == "cancelled"
    with pytest.raises(ProcessLookupError):
        os.kill(sent(assistant)["pid"], 0)
    # And the seat is free again.
    behave(assistant, mode="answer")
    assert events(ask(client, interview))[-1][1]["status"] == "completed"


def test_the_interviewer_can_stop_a_candidates_question(client, interview, assistant):
    started_with_candidate(client, interview)
    behave(assistant, mode="slow")
    finished: list = []
    asking = threading.Thread(target=lambda: finished.append(ask(client, interview)))
    asking.start()
    try:
        running = wait_for_running_turn(client, interview)
        client.post(
            f"/api/interviews/{interview['id']}/assistant/turns/{running['id']}/cancel", headers=auth("user_alice")
        )
    finally:
        asking.join(timeout=30)
    assert events(finished[0])[-1][1]["status"] == "cancelled"


def test_shutting_down_stops_whatever_is_running(client, interview, assistant):
    started_with_candidate(client, interview)
    behave(assistant, mode="slow")
    finished: list = []
    asking = threading.Thread(target=lambda: finished.append(ask(client, interview)))
    asking.start()
    try:
        wait_for_running_turn(client, interview)
        client.portal.call(client.app.state.assistant_hub.shutdown)
    finally:
        asking.join(timeout=30)
    assert turns(client, interview)[0]["status"] == "cancelled"
    assert client.app.state.assistant_hub.live == {}


def test_a_question_left_running_by_a_dead_server_is_settled_on_start(client, interview, assistant):
    started_with_candidate(client, interview)
    pool = client.app.state.db_pool

    async def orphan():
        return await AiTurnDAO(pool).start(
            session_id=interview["id"], conversation_id=uuid4(), user_id="user_bob", asked_as="candidate",
            question="left behind", context=[], prompt_bytes=10, model="fake-model-1", effort=None, max_per_session=60,
        )

    client.portal.call(orphan)
    assert ask(client, interview).status_code == 429

    with restarted():
        pass
    (stale,) = turns(client, interview)
    assert stale["status"] == "failed" and "restarted" in stale["error"]
    assert events(ask(client, interview))[-1][1]["status"] == "completed"


def test_the_interviewer_hears_when_a_question_finishes(client, interview, assistant):
    started_with_candidate(client, interview)
    with room_socket(client, interview["roomId"], "user_alice") as alice:
        roster(alice)
        events(ask(client, interview))
        while True:
            event = alice.receive_json()
            if event["type"] == "interview":
                break
    assert event["what"] == "assistant"


def test_the_settings_page_can_try_the_connection(client, operators, assistant):
    assert client.post("/api/interviews/assistant/test", headers=auth("user_bob")).status_code == 403

    tried = client.post("/api/interviews/assistant/test", headers=auth("user_alice")).json()
    assert tried["ok"] is False and tried["status"] == "not_configured"

    def reload_keeping_the_stand_in(hub=client.app.state.assistant_hub):
        hub.settings, hub.problem = assistant, None

    client.app.state.assistant_hub.reload = reload_keeping_the_stand_in
    try:
        tried = client.post("/api/interviews/assistant/test", headers=auth("user_alice")).json()
    finally:
        del client.app.state.assistant_hub.reload
    assert tried["ok"] is True and tried["status"] == "completed"
    assert tried["usage"]["model"] == "fake-model-1" and tried["usage"]["inputTokens"] == 331
    assert sent(assistant)["stdin"] == "Reply with the single word: ready"

    described = client.get("/api/interviews/system", headers=auth("user_alice")).json()["assistant"]
    assert described["ready"] is True
    assert (described["launcher"], described["profile"], described["model"]) == ("fake_claude.py", "profile", "fake-model-1")
    # Names, not paths.
    assert "/" not in described["launcher"] and "/" not in described["profile"]
