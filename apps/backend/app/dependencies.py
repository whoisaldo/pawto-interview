from __future__ import annotations

import logging

import asyncpg
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.auth import TokenError, authenticated_user_id, is_operator
from app.dao.ai_turns import AiTurnDAO
from app.dao.events import EventDAO
from app.dao.interviews import InterviewDAO
from app.dao.problems import ProblemDAO
from app.dao.room_members import RoomMemberDAO
from app.dao.room_updates import RoomUpdateDAO
from app.dao.rooms import RoomDAO
from app.dao.submissions import SubmissionDAO
from app.dao.users import UserDAO
from app.services.assistant import AssistantService
from app.services.demo import DemoService
from app.services.interviews import InterviewService, RunVisibility
from app.services.problems import ProblemService
from app.services.rooms import RoomService
from app.services.submissions import SubmissionService
from app.services.users import UserService


logger = logging.getLogger(__name__)

# auto_error=False so a missing header lands on our own 401 below rather than
# FastAPI's bare 403.
_bearer = HTTPBearer(auto_error=False)


async def current_user_id(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """The signed-in user id behind this request."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return await authenticated_user_id(credentials.credentials)
    except TokenError as exc:
        # The reason can name the JWKS URL or a network error; it is ours to read.
        logger.info("Rejected token: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def current_operator_id(user_id: str = Depends(current_user_id)) -> str:
    """The caller, if they may run interviews."""
    if not is_operator(user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an interviewer can do that",
        )
    return user_id


def get_pool(request: Request) -> asyncpg.Pool:
    return request.app.state.db_pool


def get_user_service(request: Request) -> UserService:
    return UserService(UserDAO(get_pool(request)))


def get_problem_service(request: Request) -> ProblemService:
    return ProblemService(ProblemDAO(get_pool(request)))


def get_room_service(request: Request) -> RoomService:
    pool = get_pool(request)
    return RoomService(
        room_dao=RoomDAO(pool),
        room_member_dao=RoomMemberDAO(pool),
        problem_dao=ProblemDAO(pool),
        user_dao=UserDAO(pool),
        room_update_dao=RoomUpdateDAO(pool),
        event_dao=EventDAO(pool),
        submission_dao=SubmissionDAO(pool),
        visibility=get_run_visibility(request),
    )


def get_submission_service(request: Request) -> SubmissionService:
    pool = get_pool(request)
    return SubmissionService(
        submission_dao=SubmissionDAO(pool),
        room_dao=RoomDAO(pool),
        room_member_dao=RoomMemberDAO(pool),
        problem_dao=ProblemDAO(pool),
        user_dao=UserDAO(pool),
        interview_dao=InterviewDAO(pool),
        visibility=get_run_visibility(request),
    )


def get_run_visibility(request: Request) -> RunVisibility:
    pool = get_pool(request)
    return RunVisibility(InterviewDAO(pool), ProblemDAO(pool))


def get_interview_service(request: Request) -> InterviewService:
    pool = get_pool(request)
    return InterviewService(
        interview_dao=InterviewDAO(pool),
        problem_dao=ProblemDAO(pool),
        user_dao=UserDAO(pool),
        submission_dao=SubmissionDAO(pool),
    )


def get_assistant_service(request: Request) -> AssistantService:
    pool = get_pool(request)
    return AssistantService(
        hub=request.app.state.assistant_hub,
        interviews=get_interview_service(request),
        interview_dao=InterviewDAO(pool),
        problem_dao=ProblemDAO(pool),
        submission_dao=SubmissionDAO(pool),
        turn_dao=AiTurnDAO(pool),
        announce=request.app.state.room_chat_manager.broadcast,
    )


def get_demo_service(request: Request) -> DemoService:
    pool = get_pool(request)
    return DemoService(UserDAO(pool), InterviewDAO(pool))
