from __future__ import annotations

import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import PlainTextResponse, StreamingResponse

from app.core import config
from app.dependencies import (
    current_operator_id,
    current_user_id,
    get_assistant_service,
    get_interview_service,
)
from app.schemas.interviews import (
    AskRequest,
    CreateInterviewRequest,
    EvaluationRequest,
    JoinRequest,
    RevealRequest,
    SettingsRequest,
    UpdateInterviewRequest,
)
from app.services.assistant import AssistantService
from app.services.interviews import (
    EVIDENCE,
    RECOMMENDATIONS,
    SCORE_LABELS,
    UNOBSERVED,
    InterviewService,
    export_markdown,
)

router = APIRouter(prefix="/interviews", tags=["interviews"])

# Responses here are built by the services as plain dicts rather than response
# models: what a session returns depends on who is asking, and the service is
# the one place that decides it.


async def _announce(request: Request, room_id: str, session_id, what: str) -> None:
    """Tell the room something about its session changed, so screens refetch."""
    await request.app.state.room_chat_manager.broadcast(
        room_id, {"type": "interview", "sessionId": session_id, "what": what}
    )


# Interviewer only. Declared before the /{session_id} routes so their fixed
# paths are not read as ids.


@router.get("")
async def list_interviews(
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> list[dict]:
    return await service.list_sessions()


@router.post("")
async def create_interview(
    payload: CreateInterviewRequest,
    operator_id: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.create(operator_id, payload)


@router.get("/problems")
async def problem_library(
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> list[dict]:
    return await service.library()


@router.get("/rubric")
async def rubric(_: str = Depends(current_operator_id)) -> dict:
    return {
        "evidence": EVIDENCE,
        "scores": [{"value": value, "label": label} for value, label in SCORE_LABELS.items()],
        "unobserved": UNOBSERVED,
        "recommendations": [{"value": value, "label": label} for value, label in RECOMMENDATIONS.items()],
    }


@router.get("/settings")
async def get_settings(
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.settings()


@router.put("/settings")
async def save_settings(
    payload: SettingsRequest,
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.save_settings(payload)


@router.get("/system")
async def system_status(
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
    assistant: AssistantService = Depends(get_assistant_service),
) -> dict:
    """What the interviewer's console depends on, and whether each part is up."""
    return {
        "authMode": config.AUTH_MODE,
        "judge": await service.judge_queue(),
        "assistant": assistant.hub.describe(),
    }


@router.post("/assistant/test")
async def test_assistant(
    _: str = Depends(current_operator_id),
    assistant: AssistantService = Depends(get_assistant_service),
) -> dict:
    return await assistant.test()


@router.post("/join")
async def join_interview(
    payload: JoinRequest,
    caller_id: str = Depends(current_user_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.join(payload.inviteCode, caller_id)


# One session


@router.get("/{session_id}")
async def get_interview(
    session_id: UUID,
    caller_id: str = Depends(current_user_id),
    service: InterviewService = Depends(get_interview_service),
    assistant: AssistantService = Depends(get_assistant_service),
) -> dict:
    view = await service.view(session_id, caller_id)
    session = await service.get_session(session_id)
    view["assistant"] = await assistant.availability_for(session, view["role"])
    return view


@router.get("/{session_id}/summary")
async def get_interview_summary(
    session_id: UUID,
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.get_summary(session_id)


@router.patch("/{session_id}")
async def update_interview(
    session_id: UUID,
    payload: UpdateInterviewRequest,
    request: Request,
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    summary = await service.update(session_id, payload)
    await _announce(request, summary["roomId"], session_id, "session")
    return summary


@router.post("/{session_id}/{action}")
async def change_interview_state(
    session_id: UUID,
    action: Literal["start", "pause", "end", "reset"],
    request: Request,
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    summary = await service.transition(session_id, action)
    await _announce(request, summary["roomId"], session_id, "session")
    return summary


@router.put("/{session_id}/held-back")
async def reveal_held_back(
    session_id: UUID,
    payload: RevealRequest,
    request: Request,
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    summary = await service.reveal(session_id, payload.revealed)
    await _announce(request, summary["roomId"], session_id, "session")
    return summary


@router.get("/{session_id}/runs")
async def list_runs(
    session_id: UUID,
    caller_id: str = Depends(current_user_id),
    service: InterviewService = Depends(get_interview_service),
) -> list[dict]:
    return await service.runs(session_id, caller_id)


@router.get("/{session_id}/runs/{run_id}")
async def get_run(
    session_id: UUID,
    run_id: UUID,
    caller_id: str = Depends(current_user_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.run(session_id, run_id, caller_id)


@router.get("/{session_id}/evaluation")
async def get_evaluation(
    session_id: UUID,
    _: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.evaluation(session_id)


@router.put("/{session_id}/evaluation")
async def save_evaluation(
    session_id: UUID,
    payload: EvaluationRequest,
    operator_id: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
) -> dict:
    return await service.save_evaluation(session_id, payload, operator_id)


@router.get("/{session_id}/evaluation/export")
async def export_evaluation(
    session_id: UUID,
    format: Literal["json", "markdown"] = Query(default="json"),
    operator_id: str = Depends(current_operator_id),
    service: InterviewService = Depends(get_interview_service),
    assistant: AssistantService = Depends(get_assistant_service),
):
    turns = await assistant.turns(session_id, operator_id)
    document = await service.export(session_id, turns)
    name = f"evaluation-{session_id}"
    if format == "markdown":
        return PlainTextResponse(
            export_markdown(document),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}.md"'},
        )
    return PlainTextResponse(
        json.dumps(jsonable_encoder(document), indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{name}.json"'},
    )


# The assistant


@router.get("/{session_id}/assistant/turns")
async def list_turns(
    session_id: UUID,
    caller_id: str = Depends(current_user_id),
    assistant: AssistantService = Depends(get_assistant_service),
) -> list[dict]:
    return await assistant.turns(session_id, caller_id)


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(jsonable_encoder(data))}\n\n"


@router.post("/{session_id}/assistant/turns")
async def ask_assistant(
    session_id: UUID,
    payload: AskRequest,
    caller_id: str = Depends(current_user_id),
    assistant: AssistantService = Depends(get_assistant_service),
) -> StreamingResponse:
    """Ask one question and read the answer as it is written.

    Every refusal (AI off, not set up, not running, too large) is an ordinary
    error response before any stream starts. Once the stream has started it
    always ends with a `done` event carrying the stored turn, whatever
    happened to the answer.
    """
    turn, live, role = await assistant.ask(session_id, caller_id, payload)

    async def stream():
        try:
            yield _sse("turn", assistant.turn_view(turn, role))
            async for item in live.stream():
                if item["event"] == "done":
                    yield _sse("done", assistant.turn_view(item["turn"], role))
                else:
                    yield _sse(item["event"], item["data"])
        finally:
            # A reader that has gone is a cancel: nobody is waiting for the
            # rest, and the CLI should not keep spending on it.
            live.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/{session_id}/assistant/turns/{turn_id}/cancel")
async def cancel_turn(
    session_id: UUID,
    turn_id: UUID,
    caller_id: str = Depends(current_user_id),
    assistant: AssistantService = Depends(get_assistant_service),
) -> dict:
    return await assistant.cancel(session_id, turn_id, caller_id)
