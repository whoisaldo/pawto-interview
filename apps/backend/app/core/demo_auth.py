"""A stand-in for Clerk, for a demonstration on one machine and its tailnet.

Clerk is how TandemCode signs people in, and it stays the only way a
deployment does. A class demonstration has no Clerk instance and nobody to
create accounts for, so `AUTH_MODE=demo` signs short-lived tokens here
instead: one for the operator who holds the access code, and one for each
candidate who opens an invite link.

It is built so that it cannot quietly become a way around real sign-in:

- It is off unless AUTH_MODE says demo, and then it needs two secrets of its
  own with no defaults.
- It refuses to start next to Clerk credentials, so a deployment with real
  sign-in cannot be flipped into it by one variable.
- It only answers callers on this machine or its tailnet (DEMO_ALLOWED_NETWORKS).
  Behind a public reverse proxy every caller arrives from the proxy's address
  and is refused.
- Its tokens are HS256 and Clerk's are RS256. Each mode rejects the other's.
"""

from __future__ import annotations

import hmac
import ipaddress
import time
from collections import defaultdict, deque

import jwt

from app.core import config

ISSUER = "tandemcode-demo"
OPERATOR_ID = "demo_operator"
OPERATOR_NAME = "Demo interviewer"
OPERATOR_EMAIL = "interviewer@demo.invalid"
CANDIDATE_PREFIX = "demo_candidate_"

# A demonstration is an afternoon. A token that outlives it is a liability.
TOKEN_TTL_SECONDS = 12 * 3600

MIN_SECRET_CHARS = 32
MIN_OPERATOR_CODE_CHARS = 12

# Wrong access codes from one address before it has to wait.
CODE_ATTEMPTS = 5
CODE_WINDOW_SECONDS = 60.0
_failed_codes: dict[str, deque[float]] = defaultdict(deque)


class DemoConfigError(RuntimeError):
    """Demo mode was asked for and cannot be run safely as configured."""


class DemoTokenError(Exception):
    """A demo token was absent, malformed, expired, or not signed by us."""


def enabled() -> bool:
    return config.AUTH_MODE == "demo"


def validate_config() -> None:
    """Called when the API starts in demo mode. Raises rather than limps."""
    if len(config.DEMO_AUTH_SECRET) < MIN_SECRET_CHARS:
        raise DemoConfigError(f"DEMO_AUTH_SECRET must be at least {MIN_SECRET_CHARS} characters")
    if len(config.DEMO_OPERATOR_CODE) < MIN_OPERATOR_CODE_CHARS:
        raise DemoConfigError(f"DEMO_OPERATOR_CODE must be at least {MIN_OPERATOR_CODE_CHARS} characters")
    if hmac.compare_digest(config.DEMO_AUTH_SECRET, config.DEMO_OPERATOR_CODE):
        raise DemoConfigError("DEMO_AUTH_SECRET and DEMO_OPERATOR_CODE must differ")
    if config.CLERK_SECRET_KEY or config.CLERK_ISSUER:
        raise DemoConfigError(
            "AUTH_MODE=demo cannot run next to Clerk credentials. "
            "Unset CLERK_ISSUER and CLERK_SECRET_KEY, or use AUTH_MODE=clerk."
        )
    allowed_networks()


def allowed_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    try:
        networks = [ipaddress.ip_network(network) for network in config.DEMO_ALLOWED_NETWORKS]
    except ValueError as exc:
        raise DemoConfigError(f"DEMO_ALLOWED_NETWORKS is not a list of networks: {exc}") from exc
    if not networks:
        raise DemoConfigError("DEMO_ALLOWED_NETWORKS is empty")
    return networks


def client_allowed(host: str | None) -> bool:
    """Whether a caller's address is this machine or its tailnet."""
    if not host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    # ::ffff:100.80.1.2 is the same caller as 100.80.1.2.
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return any(address in network for network in allowed_networks() if network.version == address.version)


def operator_code_matches(candidate: str, client_host: str) -> bool:
    """Compare in constant time, and make guessing from one address slow."""
    now = time.monotonic()
    failures = _failed_codes[client_host]
    while failures and now - failures[0] > CODE_WINDOW_SECONDS:
        failures.popleft()
    if len(failures) >= CODE_ATTEMPTS:
        raise DemoTokenError("Too many wrong codes. Wait a minute.")
    if hmac.compare_digest(candidate.encode(), config.DEMO_OPERATOR_CODE.encode()):
        return True
    failures.append(now)
    return False


def candidate_user_id(session_id: str) -> str:
    """One synthetic candidate per session, the same on every reload."""
    return f"{CANDIDATE_PREFIX}{session_id.replace('-', '')[:16]}"


def issue_token(user_id: str) -> tuple[str, int]:
    """A token for `user_id` and the time it stops working."""
    now = int(time.time())
    expires = now + TOKEN_TTL_SECONDS
    token = jwt.encode(
        {"iss": ISSUER, "sub": user_id, "iat": now, "exp": expires},
        config.DEMO_AUTH_SECRET,
        algorithm="HS256",
    )
    return token, expires


def user_id_from_token(token: str) -> str:
    """The user a demo token proves, or raise DemoTokenError."""
    if not enabled():
        raise DemoTokenError("Demo sign-in is off")
    try:
        claims = jwt.decode(
            token,
            config.DEMO_AUTH_SECRET,
            # Named, so a token that picks its own algorithm is refused.
            algorithms=["HS256"],
            issuer=ISSUER,
            options={"require": ["exp", "iat", "sub", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise DemoTokenError(str(exc)) from exc
    subject = claims["sub"]
    if subject != OPERATOR_ID and not str(subject).startswith(CANDIDATE_PREFIX):
        raise DemoTokenError("Not a demo user")
    return subject
