from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, WebSocket, WebSocketDisconnect, WebSocketException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core import config, demo_auth
from app.core import logging as access_logging
from app.core.config import CORS_ORIGINS, RUN_MIGRATIONS_ON_STARTUP
from app.dao.ai_turns import AiTurnDAO
from app.dao.events import EventDAO
from app.dao.room_members import RoomMemberDAO
from app.dao.room_updates import RoomUpdateDAO
from app.database import create_pool
from app.dependencies import current_user_id
from app.migrate import migrate
from app.routes.demo import router as demo_router
from app.routes.interviews import router as interviews_router
from app.routes.problems import router as problems_router
from app.routes.rooms import router as rooms_router
from app.routes.submissions import router as submissions_router
from app.routes.users import router as users_router
from app.services.assistant import AssistantHub
from app.websocket.auth import Participant, room_participant
from app.websocket.room_chat import RoomChatManager
from app.websocket.verdicts import VerdictListener
from app.websocket.yjs import YjsRelayManager

logging.basicConfig(level=logging.INFO)
access_logging.install()


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if demo_auth.enabled():
        # Refuses to start rather than run a stand-in sign-in half configured.
        demo_auth.validate_config()
        logger.warning(
            "AUTH_MODE=demo: local stand-in sign-in for %s only. Not for a deployment.",
            ", ".join(config.DEMO_ALLOWED_NETWORKS),
        )
    if RUN_MIGRATIONS_ON_STARTUP:
        await migrate()
    app.state.db_pool = await create_pool()
    app.state.room_chat_manager = RoomChatManager(EventDAO(app.state.db_pool))
    app.state.yjs_relay_manager = YjsRelayManager(RoomUpdateDAO(app.state.db_pool))
    # A full replay is tens of megabytes in memory while it is built; a few at
    # a time keeps a burst of requests from taking the API down.
    app.state.replay_slots = asyncio.Semaphore(2)
    verdicts = app.state.verdict_listener = VerdictListener(app.state.db_pool, app.state.room_chat_manager)
    await verdicts.start()
    hub = app.state.assistant_hub = AssistantHub()
    # Whatever CLI a previous process was running died with it.
    await AiTurnDAO(app.state.db_pool).fail_running("The server restarted before this answer finished")
    try:
        yield
    finally:
        # Before the pool closes: each stopped run still has its row to write.
        await hub.shutdown()
        await verdicts.stop()
        await app.state.db_pool.close()


app = FastAPI(title="TandemCode Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # The assistant's refusals say why in a header the web app reads.
    expose_headers=["X-Assistant-State"],
)


class DemoNetworkGuard:
    """In demo mode, answer only this machine and its tailnet.

    Outermost, so a caller from anywhere else never reaches a route. With
    Clerk in charge it does nothing. Behind a public reverse proxy every
    caller arrives from the proxy's address, which is not on the list, so a
    deployment switched to demo mode by mistake serves nobody.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] in ("http", "websocket") and demo_auth.enabled():
            client = scope.get("client")
            if not demo_auth.client_allowed(client[0] if client else None):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": status.WS_1008_POLICY_VIOLATION})
                else:
                    refusal = JSONResponse(
                        {"detail": "Demo mode only answers this machine and its tailnet"},
                        status_code=status.HTTP_403_FORBIDDEN,
                    )
                    await refusal(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(DemoNetworkGuard)

# One place decides that the API is authenticated. A resource router added
# below inherits it and cannot be left open by omission.
api_router = APIRouter(prefix="/api", dependencies=[Depends(current_user_id)])
api_router.include_router(users_router)
api_router.include_router(problems_router)
api_router.include_router(rooms_router)
api_router.include_router(submissions_router)
api_router.include_router(interviews_router)

app.include_router(api_router)
# Demo sign-in hands out tokens, so it cannot sit behind the token check.
# Each of its routes is a 404 unless AUTH_MODE is demo.
app.include_router(demo_router)


@app.get("/health")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/room/{room_id}")
async def room_websocket(
    websocket: WebSocket,
    room_id: str,
    participant: Participant = Depends(room_participant),
) -> None:
    manager: RoomChatManager = websocket.app.state.room_chat_manager
    room_member_dao = RoomMemberDAO(websocket.app.state.db_pool)

    # join() is inside the try so that a failure part-way through still unwinds
    # through leave() and takes the presence row with it.
    try:
        await manager.join(websocket, room_id, participant, room_member_dao)
        while True:
            await manager.relay_chat(room_id, websocket, await websocket.receive_text())
    except WebSocketDisconnect:
        pass
    finally:
        await manager.leave(websocket, room_id, room_member_dao)


@app.websocket("/ws/yjs/{room_id}")
async def yjs_websocket(
    websocket: WebSocket,
    room_id: str,
    participant: Participant = Depends(room_participant),
) -> None:
    manager: YjsRelayManager = websocket.app.state.yjs_relay_manager
    await manager.connect(
        websocket, room_id, participant.user_id, RoomMemberDAO(websocket.app.state.db_pool)
    )

    try:
        while True:
            message = await websocket.receive()
            # receive() hands back the raw ASGI message, so the disconnect frame
            # arrives as a value rather than an exception. Without this check the
            # loop would call receive() again and raise RuntimeError.
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await manager.relay_bytes(room_id, websocket, message["bytes"])
            elif message.get("text") is not None:
                # y-websocket only speaks binary; text would be relayed unchecked.
                raise WebSocketException(code=status.WS_1003_UNSUPPORTED_DATA, reason="Binary frames only")
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, room_id)
