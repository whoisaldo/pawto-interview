from __future__ import annotations

import json
from uuid import UUID

import asyncpg

SELECT_TURN = """
    SELECT t.id, t.session_id, t.conversation_id, t.user_id, t.asked_as, t.question, t.context,
           t.prompt_bytes, t.answer, t.status, t.error, t.model, t.effort, t.input_tokens,
           t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.cost_usd, t.duration_ms,
           t.first_token_ms, t.created_at, t.finished_at, u.name AS user_name
    FROM interview_ai_turns t
    JOIN users u ON u.id = t.user_id
"""


def _map_turn(row: asyncpg.Record) -> dict:
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "conversationId": row["conversation_id"],
        "userId": row["user_id"],
        "userName": row["user_name"],
        "askedAs": row["asked_as"],
        "question": row["question"],
        "context": json.loads(row["context"]),
        "promptBytes": row["prompt_bytes"],
        "answer": row["answer"],
        "status": row["status"],
        "error": row["error"],
        "model": row["model"],
        "effort": row["effort"],
        "usage": {
            "inputTokens": row["input_tokens"],
            "outputTokens": row["output_tokens"],
            "cacheReadTokens": row["cache_read_tokens"],
            "cacheWriteTokens": row["cache_write_tokens"],
            "costUsd": float(row["cost_usd"]) if row["cost_usd"] is not None else None,
            "durationMs": row["duration_ms"],
            "firstTokenMs": row["first_token_ms"],
        },
        "createdAt": row["created_at"],
        "finishedAt": row["finished_at"],
    }


class AiTurnDAO:
    """Questions put to the assistant, and what came back."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def start(
        self,
        *,
        session_id: UUID,
        conversation_id: UUID,
        user_id: str,
        asked_as: str,
        question: str,
        context: list[dict],
        prompt_bytes: int,
        model: str,
        effort: str | None,
        max_per_session: int,
    ) -> dict | None:
        """Record a question as running, or None if the session has used its turns.

        Raises UniqueViolationError when this person already has one running:
        the partial unique index is what makes that hold under parallel
        requests.
        """
        query = """
            INSERT INTO interview_ai_turns
              (session_id, conversation_id, user_id, asked_as, question, context, prompt_bytes, model, effort)
            SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9
            WHERE (SELECT COUNT(*) FROM interview_ai_turns WHERE session_id = $1) < $10
            RETURNING id
        """
        async with self.pool.acquire() as conn:
            turn_id = await conn.fetchval(
                query,
                session_id,
                conversation_id,
                user_id,
                asked_as,
                question,
                json.dumps(context),
                prompt_bytes,
                model,
                effort,
                max_per_session,
            )
        return await self.get(turn_id) if turn_id else None

    async def finish(
        self,
        turn_id: UUID,
        *,
        status: str,
        answer: str,
        error: str | None,
        model: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        cache_read_tokens: int | None,
        cache_write_tokens: int | None,
        cost_usd: float | None,
        duration_ms: int | None,
        first_token_ms: int | None,
    ) -> dict | None:
        query = """
            UPDATE interview_ai_turns
            SET status = $2, answer = $3, error = $4, model = COALESCE($5, model),
                input_tokens = $6, output_tokens = $7, cache_read_tokens = $8, cache_write_tokens = $9,
                cost_usd = $10, duration_ms = $11, first_token_ms = $12, finished_at = NOW()
            WHERE id = $1 AND status = 'running'
        """
        async with self.pool.acquire() as conn:
            await conn.execute(
                query,
                turn_id,
                status,
                # Postgres refuses NUL in text, and a turn that cannot be
                # stored would stay "running" and block its asker for good.
                answer.replace("\x00", ""),
                error,
                model,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                cost_usd,
                duration_ms,
                first_token_ms,
            )
        return await self.get(turn_id)

    async def get(self, turn_id: UUID) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(f"{SELECT_TURN} WHERE t.id = $1", turn_id)
        return _map_turn(row) if row else None

    async def list_for_session(self, session_id: UUID) -> list[dict]:
        query = f"{SELECT_TURN} WHERE t.session_id = $1 ORDER BY t.created_at ASC, t.id ASC"
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query, session_id)
        return [_map_turn(row) for row in rows]

    async def count_for_session(self, session_id: UUID) -> int:
        query = "SELECT COUNT(*) FROM interview_ai_turns WHERE session_id = $1"
        async with self.pool.acquire() as conn:
            return await conn.fetchval(query, session_id)

    async def conversation(self, conversation_id: UUID, user_id: str) -> list[dict]:
        """The answered turns of one person's conversation, oldest first."""
        query = f"""
            {SELECT_TURN}
            WHERE t.conversation_id = $1 AND t.user_id = $2 AND t.status IN ('completed', 'truncated')
            ORDER BY t.created_at ASC, t.id ASC
        """
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query, conversation_id, user_id)
        return [_map_turn(row) for row in rows]

    async def fail_running(self, reason: str) -> int:
        """Settle turns a previous API process left running.

        The process that owned their CLI is gone, so nothing will ever finish
        them, and each one would block its asker's next question.
        """
        query = """
            UPDATE interview_ai_turns
            SET status = 'failed', error = $1, finished_at = NOW()
            WHERE status = 'running'
        """
        async with self.pool.acquire() as conn:
            tag = await conn.execute(query, reason)
        return int(tag.rsplit(" ", 1)[1])
