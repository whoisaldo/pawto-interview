"""Sign-in for demo mode. Every route here is a 404 unless AUTH_MODE is demo.

These are the only routes that hand out a token without one, so they sit
outside /api and are mounted on their own.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core import demo_auth
from app.dependencies import get_demo_service
from app.schemas.interviews import DemoCandidateRequest, DemoOperatorRequest
from app.services.demo import DemoService


async def demo_only() -> None:
    if not demo_auth.enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


router = APIRouter(prefix="/demo", tags=["demo"], dependencies=[Depends(demo_only)])


@router.get("/status")
async def demo_status() -> dict:
    return {"mode": "demo"}


@router.post("/operator-session")
async def operator_session(
    payload: DemoOperatorRequest,
    request: Request,
    service: DemoService = Depends(get_demo_service),
) -> dict:
    client = request.client.host if request.client else ""
    return await service.operator_session(payload.accessCode, client)


@router.post("/candidate-session")
async def candidate_session(
    payload: DemoCandidateRequest,
    service: DemoService = Depends(get_demo_service),
) -> dict:
    return await service.candidate_session(payload.inviteCode)
