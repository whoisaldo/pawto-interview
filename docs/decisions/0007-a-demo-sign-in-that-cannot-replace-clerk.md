# 0007. A demo sign-in that cannot replace Clerk

Status: accepted, 2026-11-15

## Context

The interview screens are shown in a class, on one machine reached over a tailnet. There is no Clerk instance for that, and a candidate in a demonstration has no account to sign in with. The usual answer, a flag that skips authentication, is how a test setting ends up open on the internet.

## Decision

`AUTH_MODE=demo` signs in an interviewer who holds an access code and a candidate who holds an invite link, with short-lived tokens the API signs itself (`app/core/demo_auth.py`). Clerk stays the default and the only mode a deployment uses.

Demo mode is built to fail closed:

- It needs two secrets of its own, with no defaults, and the API will not start without them.
- It will not start while the Clerk settings are present.
- It refuses any caller outside the networks in `DEMO_ALLOWED_NETWORKS`, which default to the machine itself and the tailnet range. Behind a reverse proxy every caller comes from the proxy and is refused.
- Demo tokens and Clerk tokens use different algorithms and are each rejected by the other mode. The demo routes are a 404 under Clerk.

Every route still requires a token. Demo mode changes who issues it, not whether one is needed.

## Consequences

- A demonstration needs no accounts and no network path to Clerk.
- The web app is built for one mode or the other. A demo build has only the interview screens, since the practice rooms use Clerk's components.
- There is one interviewer in demo mode, and anyone holding the access code is that interviewer.
- The network rule depends on the API seeing the caller's real address. That is true when it is bound to the tailnet address, and deliberately false behind a proxy.
