"""Demo sign-in: an access code or an invite code, exchanged for a token.

Only reachable when AUTH_MODE is demo. app.core.demo_auth says what that mode
is for and what it refuses to do.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status

from app.core import demo_auth
from app.dao.interviews import InterviewDAO
from app.dao.users import UserDAO


def _signed_in(user: dict, role: str) -> dict:
    token, expires = demo_auth.issue_token(user["id"])
    return {
        "token": token,
        "expiresAt": datetime.fromtimestamp(expires, timezone.utc),
        "role": role,
        "user": user,
    }


class DemoService:
    def __init__(self, user_dao: UserDAO, interview_dao: InterviewDAO) -> None:
        self.user_dao = user_dao
        self.interview_dao = interview_dao

    async def operator_session(self, access_code: str, client_host: str) -> dict:
        """The access code for a token as the one demo interviewer."""
        try:
            matches = demo_auth.operator_code_matches(access_code, client_host)
        except demo_auth.DemoTokenError as exc:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
        if not matches:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="That access code is not right"
            )
        user = await self.user_dao.create(
            demo_auth.OPERATOR_ID, demo_auth.OPERATOR_EMAIL, demo_auth.OPERATOR_NAME
        )
        return _signed_in(user, "interviewer")

    async def candidate_session(self, invite_code: str) -> dict:
        """An invite code for a token as that session's candidate.

        The candidate is a synthetic user tied to the session, the same on
        every visit, so reloading the link returns to the same seat.
        """
        session = await self.interview_dao.get_by_invite(invite_code)
        if not session:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="This invite link is not valid"
            )
        user_id = demo_auth.candidate_user_id(str(session["id"]))
        user = await self.user_dao.create(user_id, f"{user_id}@demo.invalid", session["candidateName"])
        if not await self.interview_dao.bind_candidate(session["id"], user_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This invite has already been used by someone else",
            )
        return {**_signed_in(user, "candidate"), "sessionId": session["id"]}
