"""Everything the app reads from the environment, in one place.

This module is imported before anything else touches the database, so `.env` is
loaded exactly once and every other module sees the same values.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[2]

# Real environment variables win; the file only fills in what they leave unset.
load_dotenv(BACKEND_ROOT / ".env")


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Copy .env.example to .env and fill it in.")
    return value


DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "tandemcode_dev")
DB_USER = os.getenv("DB_USER", "tandemcode")
# No default on purpose. A fallback password is how credentials end up committed.
DB_PASSWORD = _required("DB_PASSWORD")

# quote_plus keeps the URL valid when the password contains @ : / or #
DATABASE_URL = (
    f"postgresql://{quote_plus(DB_USER)}:{quote_plus(DB_PASSWORD)}"
    f"@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

# Flyway migrated on every Spring Boot start; keep doing that.
RUN_MIGRATIONS_ON_STARTUP = os.getenv("RUN_MIGRATIONS_ON_STARTUP", "true").lower() in {
    "1",
    "true",
    "yes",
}

# The Clerk instance that issues session tokens, e.g.
# https://your-app-42.clerk.accounts.dev. The API refuses to start without it
# (see app.core.auth); the runner never checks a token and does not need it.
CLERK_ISSUER = os.getenv("CLERK_ISSUER", "").rstrip("/")

# Server-side Clerk credential, used to read user profiles. A real secret:
# it must never reach the browser, and the runner, which executes strangers'
# code, has no use for it.
CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY", "")

# Clerk stamps the requesting origin into each token's `azp` claim. Our own
# origins are the right default, since the browser app is the only client.
CLERK_AUTHORIZED_PARTIES = [
    party.strip()
    for party in os.getenv("CLERK_AUTHORIZED_PARTIES", ",".join(CORS_ORIGINS)).split(",")
    if party.strip()
]

# How callers prove who they are. "clerk" is the only mode a deployment should
# run. "demo" is a local stand-in for a class demonstration with no Clerk
# instance: it signs its own short-lived tokens for one operator and for
# candidates holding an invite code. See app.core.demo_auth for what it
# refuses to do, and docs/interviews.md for when to use it.
AUTH_MODE = os.getenv("AUTH_MODE", "clerk").strip().lower()
if AUTH_MODE not in {"clerk", "demo"}:
    raise RuntimeError(f"AUTH_MODE must be 'clerk' or 'demo', not {AUTH_MODE!r}")

# Demo mode only. Both are secrets and neither has a default.
DEMO_AUTH_SECRET = os.getenv("DEMO_AUTH_SECRET", "")
DEMO_OPERATOR_CODE = os.getenv("DEMO_OPERATOR_CODE", "")
# Who may reach a demo-mode API at all: this machine and its tailnet.
DEMO_ALLOWED_NETWORKS = [
    network.strip()
    for network in os.getenv("DEMO_ALLOWED_NETWORKS", "127.0.0.0/8,::1/128,100.64.0.0/10").split(",")
    if network.strip()
]

# Clerk mode: the user ids allowed to run interviews. Everyone else can only
# be a candidate. Demo mode has exactly one operator and ignores this.
INTERVIEW_OPERATOR_IDS = frozenset(
    user_id.strip() for user_id in os.getenv("INTERVIEW_OPERATOR_IDS", "").split(",") if user_id.strip()
)

# The Claude CLI behind the interview assistant. Unset, the assistant is off
# and says so; there is no other model and no canned reply to fall back to.
# The command is a launcher that picks its own profile (or CLAUDE_CLI_CONFIG_DIR
# names one). See app.assistant.cli for what is passed to it.
CLAUDE_CLI_COMMAND = os.getenv("CLAUDE_CLI_COMMAND", "").strip()
CLAUDE_CLI_CONFIG_DIR = os.getenv("CLAUDE_CLI_CONFIG_DIR", "").strip()
CLAUDE_CLI_MODEL = os.getenv("CLAUDE_CLI_MODEL", "").strip()
CLAUDE_CLI_EFFORT = os.getenv("CLAUDE_CLI_EFFORT", "").strip()
# The one directory the CLI is ever started in. Created empty if missing.
CLAUDE_CLI_WORKDIR = os.getenv("CLAUDE_CLI_WORKDIR", "").strip()
CLAUDE_CLI_TIMEOUT_SECONDS = os.getenv("CLAUDE_CLI_TIMEOUT_SECONDS", "").strip()
