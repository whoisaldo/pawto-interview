"""Verification of Clerk session tokens.

Clerk signs session tokens with RS256 and publishes the matching public keys at
its issuer's JWKS endpoint. Tokens are therefore verified here, in process, and
nothing on the request path calls out to Clerk once the key set is cached.
"""

from __future__ import annotations

import time

import jwt
from anyio import to_thread
from jwt import PyJWKClient

from app.core import config, demo_auth
from app.core.config import CLERK_AUTHORIZED_PARTIES, CLERK_ISSUER, CLERK_SECRET_KEY

# Imported by the API and not the runner. An API that cannot check tokens, or
# read the profiles behind them, has no business starting. Demo mode has its
# own secrets and its own start-up check (app.core.demo_auth.validate_config).
if config.AUTH_MODE == "clerk":
    for _name, _value in (("CLERK_ISSUER", CLERK_ISSUER), ("CLERK_SECRET_KEY", CLERK_SECRET_KEY)):
        if not _value:
            raise RuntimeError(f"{_name} is not set. Copy .env.example to .env and fill it in.")

# Clerk issues short-lived tokens and its frontend SDK refreshes them, so this
# only has to absorb clock drift between us and Clerk.
_LEEWAY_SECONDS = 10

# Caches the key set internally, so this is one fetch every few minutes rather
# than one per request. The timeout bounds how long a slow Clerk can hold a
# worker thread.
# None in demo mode, where there is no Clerk instance and no token of its to check.
_jwks = PyJWKClient(f"{CLERK_ISSUER}/.well-known/jwks.json", timeout=5) if CLERK_ISSUER else None

# PyJWKClient refetches whenever a token names a key it has not seen, and the
# key id is whatever an unauthenticated caller writes in the header. Clerk
# rotates keys rarely, so one refetch a minute is plenty.
_REFETCH_INTERVAL_SECONDS = 60
_last_refetch = 0.0


def _signing_key(token: str) -> jwt.PyJWK:
    global _last_refetch
    if _jwks is None:
        raise jwt.PyJWKClientError("No Clerk issuer is configured")
    kid = jwt.get_unverified_header(token).get("kid")
    for key in _jwks.get_signing_keys():
        if key.key_id == kid:
            return key
    if time.monotonic() - _last_refetch < _REFETCH_INTERVAL_SECONDS:
        raise jwt.PyJWKClientError(f"Unknown signing key {kid!r}")
    _last_refetch = time.monotonic()
    return _jwks.get_signing_key(kid)


class TokenError(Exception):
    """A session token was absent, malformed, expired, or not issued to us."""


async def clerk_user_id(token: str) -> str:
    """Return the Clerk user id that `token` proves, or raise TokenError."""
    try:
        # On a cache miss this fetches over the network with a blocking client.
        signing_key = await to_thread.run_sync(_signing_key, token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=CLERK_ISSUER,
            leeway=_LEEWAY_SECONDS,
            # Clerk session tokens carry no `aud`. The `azp` check below is the
            # equivalent guard, so requiring an audience here would reject
            # every real token.
            options={"verify_aud": False, "require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc

    # `azp` is the origin Clerk minted the token for. Without this, a token
    # issued to any other application on the same Clerk instance would be
    # accepted here.
    azp = claims.get("azp")
    if azp not in CLERK_AUTHORIZED_PARTIES:
        raise TokenError(f"Token was issued to {azp!r}, which is not an allowed origin")

    return claims["sub"]


async def authenticated_user_id(token: str) -> str:
    """The user `token` proves, whichever way this API signs people in.

    The one place the mode is chosen. Every HTTP and websocket boundary calls
    this, so no route can accept a demo token while Clerk is in charge, or the
    other way round.
    """
    if demo_auth.enabled():
        try:
            return demo_auth.user_id_from_token(token)
        except demo_auth.DemoTokenError as exc:
            raise TokenError(str(exc)) from exc
    return await clerk_user_id(token)


def is_operator(user_id: str) -> bool:
    """Whether this user may run interviews: create them, see answers, score.

    In demo mode that is the one operator. With Clerk it is whoever
    INTERVIEW_OPERATOR_IDS lists, and nobody when the list is empty.
    """
    if demo_auth.enabled():
        return user_id == demo_auth.OPERATOR_ID
    return user_id in config.INTERVIEW_OPERATOR_IDS
