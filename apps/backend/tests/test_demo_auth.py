"""Demo sign-in: a stand-in for one machine, and never a way around real sign-in."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import jwt
import pytest
from starlette.websockets import WebSocketDisconnect

from app.core import demo_auth
from tests.interview_rig import EXERCISE, restarted
from tests.rig import auth, token

SECRET = "a-demo-signing-secret-of-thirty-two-plus-chars"
CODE = "operator-code-1234"
LOCAL = ("127.0.0.1", 50000)


def demo_token(sub: str = demo_auth.OPERATOR_ID, secret: str = SECRET, ttl: int = 300, **claims) -> str:
    now = int(time.time())
    payload = {"iss": demo_auth.ISSUER, "sub": sub, "iat": now, "exp": now + ttl, **claims}
    return jwt.encode({k: v for k, v in payload.items() if v is not None}, secret, algorithm="HS256")


def bearer(value: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {value}"}


@pytest.fixture
def demo_config(monkeypatch):
    """Switch the settings a demo start-up reads. Nothing is started here."""
    monkeypatch.setattr("app.core.config.AUTH_MODE", "demo")
    monkeypatch.setattr("app.core.config.DEMO_AUTH_SECRET", SECRET)
    monkeypatch.setattr("app.core.config.DEMO_OPERATOR_CODE", CODE)
    monkeypatch.setattr("app.core.config.CLERK_SECRET_KEY", "")
    monkeypatch.setattr("app.core.config.CLERK_ISSUER", "")
    demo_auth._failed_codes.clear()


@pytest.fixture
def demo(demo_config):
    """The app started in demo mode, reached from this machine."""
    with restarted(client=LOCAL) as client:
        yield client


def sign_in(client) -> str:
    response = client.post("/demo/operator-session", json={"accessCode": CODE})
    assert response.status_code == 200, response.text
    return response.json()["token"]


# With Clerk in charge, demo sign-in does not exist.


def test_demo_routes_are_absent_under_clerk(client):
    assert client.get("/demo/status").status_code == 404
    assert client.post("/demo/operator-session", json={"accessCode": CODE}).status_code == 404
    assert client.post("/demo/candidate-session", json={"inviteCode": "x" * 20}).status_code == 404


def test_a_demo_token_is_worthless_under_clerk(client, monkeypatch):
    """Even one signed with the real demo secret, on a server that has one set."""
    monkeypatch.setattr("app.core.config.DEMO_AUTH_SECRET", SECRET)
    assert client.get("/api/rooms", headers=bearer(demo_token())).status_code == 401
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/room/any?token={demo_token()}"):
            pass


def test_under_clerk_callers_from_anywhere_are_served(operators):
    """The network rule belongs to demo mode. It must not reach real deployments."""
    with restarted(client=("203.0.113.9", 4000)) as elsewhere:
        assert elsewhere.get("/health").status_code == 200
        assert elsewhere.get("/api/rooms", headers=auth("user_alice")).status_code == 200


# What demo mode needs before it will start.


@pytest.mark.parametrize(
    ("setting", "value", "complaint"),
    [
        ("DEMO_AUTH_SECRET", "short", "DEMO_AUTH_SECRET"),
        ("DEMO_AUTH_SECRET", "", "DEMO_AUTH_SECRET"),
        ("DEMO_OPERATOR_CODE", "letmein", "DEMO_OPERATOR_CODE"),
        ("DEMO_OPERATOR_CODE", SECRET, "must differ"),
        ("CLERK_SECRET_KEY", "sk_live_something", "Clerk credentials"),
        ("CLERK_ISSUER", "https://clerk.example.com", "Clerk credentials"),
        ("DEMO_ALLOWED_NETWORKS", ["everywhere"], "DEMO_ALLOWED_NETWORKS"),
        ("DEMO_ALLOWED_NETWORKS", [], "DEMO_ALLOWED_NETWORKS"),
    ],
    ids=["short-secret", "no-secret", "short-code", "code-is-secret", "clerk-key", "clerk-issuer", "bad-network", "no-network"],
)
def test_demo_mode_refuses_to_start_half_configured(demo_config, monkeypatch, setting, value, complaint):
    monkeypatch.setattr(f"app.core.config.{setting}", value)
    with pytest.raises(demo_auth.DemoConfigError, match=complaint):
        demo_auth.validate_config()

    with pytest.raises(demo_auth.DemoConfigError):
        with restarted(client=LOCAL):
            pass


# Signing in.


def test_the_access_code_signs_the_operator_in(demo):
    assert demo.get("/demo/status").json() == {"mode": "demo"}
    assert demo.get("/api/interviews").status_code == 401

    wrong = demo.post("/demo/operator-session", json={"accessCode": "not-the-code-at-all"})
    assert wrong.status_code == 401

    session = demo.post("/demo/operator-session", json={"accessCode": CODE}).json()
    assert session["role"] == "interviewer"
    assert session["user"]["id"] == demo_auth.OPERATOR_ID and session["user"]["name"] == "Demo interviewer"

    headers = bearer(session["token"])
    assert demo.get("/api/interviews", headers=headers).status_code == 200
    # The profile sync the web app does on load works with no Clerk to ask.
    assert demo.post("/api/users", headers=headers).json()["id"] == demo_auth.OPERATOR_ID
    assert demo.get("/api/interviews/system", headers=headers).json()["authMode"] == "demo"


def test_guessing_the_access_code_gets_slower(demo):
    for _ in range(demo_auth.CODE_ATTEMPTS):
        assert demo.post("/demo/operator-session", json={"accessCode": "wrong-wrong-wrong"}).status_code == 401
    assert demo.post("/demo/operator-session", json={"accessCode": "wrong-wrong-wrong"}).status_code == 429
    # Even the right code waits its turn.
    assert demo.post("/demo/operator-session", json={"accessCode": CODE}).status_code == 429


@pytest.mark.parametrize(
    "forged",
    [
        "not.a.token",
        demo_token(secret="another-secret-of-thirty-two-plus-characters"),
        demo_token(ttl=-60),
        demo_token(sub="user_alice"),
        demo_token(sub=None),
        demo_token(iss="someone-else"),
        jwt.encode({"iss": demo_auth.ISSUER, "sub": demo_auth.OPERATOR_ID, "iat": 0, "exp": 9999999999}, None, algorithm="none"),
        token("user_alice"),
    ],
    ids=["malformed", "wrong-secret", "expired", "not-a-demo-user", "no-subject", "wrong-issuer", "unsigned", "clerk-token"],
)
def test_forged_and_foreign_tokens_are_refused_in_demo_mode(demo, forged):
    assert demo.get("/api/interviews", headers=bearer(forged)).status_code == 401


def new_interview(demo, headers: dict) -> dict:
    exercise = demo.get(f"/api/problems/slug/{EXERCISE}", headers=headers).json()
    response = demo.post(
        "/api/interviews",
        json={"title": "Demo", "candidateName": "Sam Rivera", "problemId": exercise["id"],
              "durationSeconds": 420, "aiPolicy": "allowed"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_an_invite_link_seats_the_candidate_and_only_as_a_candidate(demo):
    operator = bearer(sign_in(demo))
    interview = new_interview(demo, operator)

    assert demo.post("/demo/candidate-session", json={"inviteCode": "no-such-invite-code"}).status_code == 404
    seat = demo.post("/demo/candidate-session", json={"inviteCode": interview["inviteCode"]}).json()
    assert seat["role"] == "candidate" and seat["sessionId"] == interview["id"]
    assert seat["user"]["name"] == "Sam Rivera"
    candidate = bearer(seat["token"])

    seen = demo.get(f"/api/interviews/{interview['id']}", headers=candidate).json()
    assert seen["role"] == "candidate" and seen["heldBack"] is None and seen["interviewer"] is None
    # A candidate's token opens nothing on the interviewer's side.
    for path in ("/api/interviews", "/api/interviews/problems", "/api/interviews/settings",
                 f"/api/interviews/{interview['id']}/evaluation"):
        assert demo.get(path, headers=candidate).status_code == 403, path
    assert demo.post(f"/api/interviews/{interview['id']}/start", headers=candidate).status_code == 403

    # Reloading the link returns to the same seat.
    again = demo.post("/demo/candidate-session", json={"inviteCode": interview["inviteCode"]}).json()
    assert again["user"]["id"] == seat["user"]["id"]
    # And a seat in one session is no seat in another.
    other = new_interview(demo, operator)
    assert demo.get(f"/api/interviews/{other['id']}", headers=candidate).status_code == 404
    summary = demo.get(f"/api/interviews/{interview['id']}/summary", headers=operator).json()
    assert summary["candidateJoined"] is True


def test_the_room_socket_takes_a_demo_token(demo):
    operator_token = sign_in(demo)
    interview = new_interview(demo, bearer(operator_token))
    with demo.websocket_connect(f"/ws/room/{interview['roomId']}?token={operator_token}") as socket:
        while True:
            event = socket.receive_json()
            if event["type"] == "presence":
                break
    assert event["members"][0]["userId"] == demo_auth.OPERATOR_ID


# Who demo mode will talk to at all.


@pytest.mark.parametrize(
    ("host", "allowed"),
    [
        ("127.0.0.1", True),
        ("::1", True),
        ("100.101.102.103", True),
        ("100.127.255.254", True),
        ("::ffff:100.64.0.7", True),
        ("100.128.0.1", False),
        ("192.168.1.20", False),
        ("203.0.113.9", False),
        ("2001:db8::1", False),
        ("172.18.0.1", False),
        ("testclient", False),
        ("", False),
        (None, False),
    ],
)
def test_only_this_machine_and_its_tailnet_count_as_local(demo_config, host, allowed):
    assert demo_auth.client_allowed(host) is allowed


def test_demo_mode_does_not_answer_the_wider_network(demo_config):
    """172.18.0.1 is where every caller appears to come from behind a reverse proxy."""
    for address in ("203.0.113.9", "192.168.1.20", "172.18.0.1"):
        with restarted(client=(address, 4000)) as outside:
            assert outside.get("/health").status_code == 403
            assert outside.post("/demo/operator-session", json={"accessCode": CODE}).status_code == 403
            assert outside.get("/api/interviews", headers=bearer(demo_token())).status_code == 403
            with pytest.raises(WebSocketDisconnect):
                with outside.websocket_connect(f"/ws/room/any?token={demo_token()}"):
                    pass


def test_nothing_shipped_turns_demo_mode_on():
    """The templates and compose files a deployment starts from never mention it."""
    backend = Path(__file__).resolve().parents[1]
    shipped = [backend / "docker-compose.yml", backend / "Dockerfile"]
    infra = backend.parent.parent / "infra"
    # `make test` mounts only apps/backend; CI and a normal checkout have infra too.
    if infra.is_dir():
        shipped += [infra / "docker-compose.prod.yml", infra / ".env.example", infra / "deploy.sh"]
    for path in shipped:
        text = path.read_text()
        assert "AUTH_MODE" not in text and "DEMO_" not in text, path.name

    example = (backend / ".env.example").read_text()
    for line in example.splitlines():
        if line.startswith(("AUTH_MODE", "DEMO_", "CLAUDE_CLI_")):
            # Documented, and switched off: commented out or left empty.
            assert line.split("=", 1)[1] in ("", "clerk"), line


def test_the_api_imports_with_no_clerk_settings_at_all():
    """Demo mode is started with the Clerk values empty, as a real process is.

    The fixtures above switch settings after import, which cannot show a
    module that refuses to import without an issuer.
    """
    backend = Path(__file__).resolve().parents[1]
    env = {
        "PATH": os.environ["PATH"],
        "AUTH_MODE": "demo",
        "CLERK_ISSUER": "",
        "CLERK_SECRET_KEY": "",
        "DB_PASSWORD": "unused-by-an-import",
        "DEMO_AUTH_SECRET": SECRET,
        "DEMO_OPERATOR_CODE": CODE,
    }
    result = subprocess.run(
        [sys.executable, "-c", "import app.main, app.core.auth as auth; print(auth.is_operator('demo_operator'))"],
        cwd=backend, env=env, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True"
