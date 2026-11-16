from __future__ import annotations

import json
from uuid import UUID

import asyncpg

# The clock is read, never ticked: time used so far is what was banked at the
# last pause plus the stretch since running_since. NOW() comes back with the
# row so a client can correct for its own clock.
SELECT_SESSION = """
    SELECT s.id, s.title, s.candidate_name, s.candidate_email, s.problem_id, s.room_id,
           s.invite_code, s.candidate_user_id, s.duration_seconds, s.ai_policy, s.status,
           s.running_since, s.started_at, s.ended_at, s.held_back_revealed_at,
           s.brief_statement, s.brief_criteria, s.brief_starter_code, s.is_sample,
           s.created_by, s.created_at, s.updated_at,
           s.elapsed_seconds + CASE
               WHEN s.status = 'running'
               THEN FLOOR(EXTRACT(EPOCH FROM NOW() - s.running_since))::int
               ELSE 0
           END AS elapsed_now,
           NOW() AS server_now,
           p.slug AS problem_slug, p.title AS problem_title, p.difficulty AS problem_difficulty
    FROM interview_sessions s
    JOIN problems p ON p.id = s.problem_id
"""

# What the list shows beside each session: its runs, its assistant use and
# its evaluation, each read in the same statement so a row cannot disagree
# with itself.
SELECT_SESSION_WITH_ACTIVITY = f"""
    SELECT base.*, runs.run_count, runs.last_run_at, judged.last_status, judged.last_result,
           turns.turn_count, turns.cost_usd AS ai_cost_usd, turns.input_tokens AS ai_input_tokens,
           turns.output_tokens AS ai_output_tokens,
           e.session_id IS NOT NULL AS has_evaluation,
           e.clarification_score, e.verification_score, e.understanding_score, e.ownership_score,
           e.recommendation, e.updated_at AS evaluation_updated_at
    FROM ({SELECT_SESSION}) base
    CROSS JOIN LATERAL (
        SELECT COUNT(*) AS run_count, MAX(created_at) AS last_run_at
        FROM submissions WHERE room_id = base.room_id
    ) runs
    LEFT JOIN LATERAL (
        SELECT status AS last_status, result AS last_result
        FROM submissions
        WHERE room_id = base.room_id AND status NOT IN ('pending', 'running')
        ORDER BY created_at DESC
        LIMIT 1
    ) judged ON TRUE
    CROSS JOIN LATERAL (
        SELECT COUNT(*) AS turn_count, COALESCE(SUM(cost_usd), 0) AS cost_usd,
               -- Everything sent to the model. With prompt caching most of a
               -- prompt is counted under the cache columns, not input_tokens.
               COALESCE(SUM(
                   COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)
               ), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM interview_ai_turns WHERE session_id = base.id
    ) turns
    LEFT JOIN interview_evaluations e ON e.session_id = base.id
"""

DIMENSIONS = ("clarification", "verification", "understanding", "ownership")

# The only columns an update may name. Keys come from code, never a request.
UPDATABLE = {
    "title": "title",
    "candidateName": "candidate_name",
    "candidateEmail": "candidate_email",
    "problemId": "problem_id",
    "durationSeconds": "duration_seconds",
    "aiPolicy": "ai_policy",
    "briefStatement": "brief_statement",
    "briefCriteria": "brief_criteria",
    "briefStarterCode": "brief_starter_code",
}


def _map_session(row: asyncpg.Record) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "candidateName": row["candidate_name"],
        "candidateEmail": row["candidate_email"],
        "problemId": row["problem_id"],
        "problemSlug": row["problem_slug"],
        "problemTitle": row["problem_title"],
        "problemDifficulty": row["problem_difficulty"],
        "roomId": row["room_id"],
        "inviteCode": row["invite_code"],
        "candidateUserId": row["candidate_user_id"],
        "durationSeconds": row["duration_seconds"],
        "aiPolicy": row["ai_policy"],
        "status": row["status"],
        "elapsedSeconds": row["elapsed_now"],
        "runningSince": row["running_since"],
        "startedAt": row["started_at"],
        "endedAt": row["ended_at"],
        "heldBackRevealedAt": row["held_back_revealed_at"],
        "briefStatement": row["brief_statement"],
        "briefCriteria": json.loads(row["brief_criteria"]) if row["brief_criteria"] else None,
        "briefStarterCode": row["brief_starter_code"],
        "isSample": row["is_sample"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "serverNow": row["server_now"],
    }


def _map_session_with_activity(row: asyncpg.Record) -> dict:
    session = _map_session(row)
    session["activity"] = {
        "runCount": row["run_count"],
        "lastRunAt": row["last_run_at"],
        "lastStatus": row["last_status"],
        "lastResult": json.loads(row["last_result"]) if row["last_result"] else None,
        "aiTurns": row["turn_count"],
        "aiCostUsd": float(row["ai_cost_usd"]),
        "aiInputTokens": row["ai_input_tokens"],
        "aiOutputTokens": row["ai_output_tokens"],
    }
    session["evaluationSummary"] = (
        {
            "scores": {dimension: row[f"{dimension}_score"] for dimension in DIMENSIONS},
            "recommendation": row["recommendation"],
            "updatedAt": row["evaluation_updated_at"],
        }
        if row["has_evaluation"]
        else None
    )
    return session


def _map_evaluation(row: asyncpg.Record) -> dict:
    return {
        "sessionId": row["session_id"],
        "evidence": {
            dimension: {"score": row[f"{dimension}_score"], "note": row[f"{dimension}_note"]}
            for dimension in DIMENSIONS
        },
        "summary": row["summary"],
        "recommendation": row["recommendation"],
        "updatedBy": row["updated_by"],
        "updatedByName": row["updated_by_name"],
        "updatedAt": row["updated_at"],
    }


def _map_guide(row: asyncpg.Record) -> dict:
    return {
        "problemId": row["problem_id"],
        "summary": row["summary"],
        "acceptanceCriteria": json.loads(row["acceptance_criteria"]),
        "provenance": row["provenance"],
        "interviewerGuide": json.loads(row["interviewer_guide"]),
        "referenceCode": row["reference_code"],
        "recommendedDurationSeconds": row["recommended_duration_seconds"],
    }


class InterviewDAO:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    async def create(
        self,
        *,
        title: str,
        candidate_name: str,
        candidate_email: str | None,
        problem_id: UUID,
        room_id: str,
        room_name: str,
        invite_code: str,
        duration_seconds: int,
        ai_policy: str,
        brief_statement: str | None,
        brief_criteria: list[str] | None,
        brief_starter_code: str | None,
        created_by: str,
        is_sample: bool = False,
    ) -> dict:
        """Create the session and the unlisted room behind it, together.

        One transaction, so there is never a session without its room or a
        stray room no session points at.
        """
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO rooms (id, name, description, created_by, visibility, advertised, current_problem_id)
                    VALUES ($1, $2, 'Interview session', $3, 'unlisted', FALSE, $4)
                    """,
                    room_id,
                    room_name,
                    created_by,
                    problem_id,
                )
                session_id = await conn.fetchval(
                    """
                    INSERT INTO interview_sessions
                      (title, candidate_name, candidate_email, problem_id, room_id, invite_code,
                       duration_seconds, ai_policy, brief_statement, brief_criteria, brief_starter_code,
                       created_by, is_sample)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
                    RETURNING id
                    """,
                    title,
                    candidate_name,
                    candidate_email,
                    problem_id,
                    room_id,
                    invite_code,
                    duration_seconds,
                    ai_policy,
                    brief_statement,
                    json.dumps(brief_criteria) if brief_criteria is not None else None,
                    brief_starter_code,
                    created_by,
                    is_sample,
                )
        return await self.get(session_id)

    async def get(self, session_id: UUID) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(f"{SELECT_SESSION} WHERE s.id = $1", session_id)
        return _map_session(row) if row else None

    async def get_with_activity(self, session_id: UUID) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(f"{SELECT_SESSION_WITH_ACTIVITY} WHERE base.id = $1", session_id)
        return _map_session_with_activity(row) if row else None

    async def get_by_invite(self, invite_code: str) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(f"{SELECT_SESSION} WHERE s.invite_code = $1", invite_code)
        return _map_session(row) if row else None

    async def get_by_room(self, room_id: str) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(f"{SELECT_SESSION} WHERE s.room_id = $1", room_id)
        return _map_session(row) if row else None

    async def list_all(self, limit: int) -> list[dict]:
        query = f"{SELECT_SESSION_WITH_ACTIVITY} ORDER BY base.created_at DESC LIMIT $1"
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query, limit)
        return [_map_session_with_activity(row) for row in rows]

    async def update(self, session_id: UUID, changes: dict) -> dict | None:
        """Set the named fields. `changes` is keyed by the names in UPDATABLE."""
        assignments, values = [], []
        for key, value in changes.items():
            column = UPDATABLE[key]
            if column == "brief_criteria":
                value = json.dumps(value) if value is not None else None
                assignments.append(f"{column} = ${len(values) + 2}::jsonb")
            else:
                assignments.append(f"{column} = ${len(values) + 2}")
            values.append(value)
        if not assignments:
            return await self.get(session_id)
        query = f"""
            UPDATE interview_sessions SET {", ".join(assignments)}, updated_at = NOW()
            WHERE id = $1
            RETURNING id
        """
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                updated = await conn.fetchval(query, session_id, *values)
                if updated and "problemId" in changes:
                    # The room's editor and runs follow the session's problem.
                    await conn.execute(
                        """
                        UPDATE rooms SET current_problem_id = $2
                        WHERE id = (SELECT room_id FROM interview_sessions WHERE id = $1)
                        """,
                        session_id,
                        changes["problemId"],
                    )
        return await self.get(session_id) if updated else None

    async def start(self, session_id: UUID) -> bool:
        """Start, or resume from a pause. False if the session is in neither state."""
        query = """
            UPDATE interview_sessions
            SET status = 'running', running_since = NOW(),
                started_at = COALESCE(started_at, NOW()), updated_at = NOW()
            WHERE id = $1 AND status IN ('scheduled', 'paused')
        """
        return await self._changed(query, session_id)

    async def pause(self, session_id: UUID) -> bool:
        query = """
            UPDATE interview_sessions
            SET status = 'paused',
                elapsed_seconds = elapsed_seconds + FLOOR(EXTRACT(EPOCH FROM NOW() - running_since))::int,
                running_since = NULL, updated_at = NOW()
            WHERE id = $1 AND status = 'running'
        """
        return await self._changed(query, session_id)

    async def end(self, session_id: UUID) -> bool:
        query = """
            UPDATE interview_sessions
            SET status = 'ended',
                elapsed_seconds = elapsed_seconds + CASE
                    WHEN status = 'running'
                    THEN FLOOR(EXTRACT(EPOCH FROM NOW() - running_since))::int
                    ELSE 0
                END,
                running_since = NULL, ended_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND status IN ('running', 'paused')
        """
        return await self._changed(query, session_id)

    async def reset(self, session_id: UUID) -> bool:
        """Back to the start: the clock, the status and the reveal.

        Runs, assistant turns and notes stay. They are a record of what
        happened, and a reset is not a way to make them not have happened.
        """
        query = """
            UPDATE interview_sessions
            SET status = 'scheduled', elapsed_seconds = 0, running_since = NULL,
                started_at = NULL, ended_at = NULL, held_back_revealed_at = NULL, updated_at = NOW()
            WHERE id = $1 AND status <> 'scheduled'
        """
        return await self._changed(query, session_id)

    async def set_revealed(self, session_id: UUID, revealed: bool) -> bool:
        query = """
            UPDATE interview_sessions
            SET held_back_revealed_at = CASE WHEN $2 THEN COALESCE(held_back_revealed_at, NOW()) END,
                updated_at = NOW()
            WHERE id = $1
        """
        return await self._changed(query, session_id, revealed)

    async def bind_candidate(self, session_id: UUID, user_id: str) -> bool:
        """Make `user_id` the candidate, unless someone else already is."""
        query = """
            UPDATE interview_sessions SET candidate_user_id = $2, updated_at = NOW()
            WHERE id = $1 AND (candidate_user_id IS NULL OR candidate_user_id = $2)
        """
        return await self._changed(query, session_id, user_id)

    async def has_samples(self) -> bool:
        async with self.pool.acquire() as conn:
            return bool(await conn.fetchval("SELECT EXISTS(SELECT 1 FROM interview_sessions WHERE is_sample)"))

    async def set_sample_history(self, session_id: UUID, elapsed_seconds: int, minutes_ago: int) -> bool:
        """Make a seeded session look like one that ran and ended. Sample rows only."""
        query = """
            UPDATE interview_sessions
            SET status = 'ended', elapsed_seconds = $2::int, running_since = NULL,
                ended_at = NOW() - make_interval(mins => $3::int),
                started_at = NOW() - make_interval(mins => $3::int, secs => $2::int)
            WHERE id = $1 AND is_sample
        """
        return await self._changed(query, session_id, elapsed_seconds, minutes_ago)

    async def _changed(self, query: str, *args) -> bool:
        async with self.pool.acquire() as conn:
            tag = await conn.execute(query, *args)
        return tag.rsplit(" ", 1)[1] != "0"

    async def has_judged_run(self, room_id: str) -> bool:
        query = """
            SELECT EXISTS(
                SELECT 1 FROM submissions WHERE room_id = $1 AND status NOT IN ('pending', 'running')
            )
        """
        async with self.pool.acquire() as conn:
            return bool(await conn.fetchval(query, room_id))

    # Evaluations

    async def get_evaluation(self, session_id: UUID) -> dict | None:
        query = """
            SELECT e.*, u.name AS updated_by_name
            FROM interview_evaluations e
            JOIN users u ON u.id = e.updated_by
            WHERE e.session_id = $1
        """
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(query, session_id)
        return _map_evaluation(row) if row else None

    async def save_evaluation(
        self, session_id: UUID, evidence: dict, summary: str, recommendation: str, updated_by: str
    ) -> dict:
        columns = [f"{dimension}_{field}" for dimension in DIMENSIONS for field in ("score", "note")]
        values = [evidence[dimension][field] for dimension in DIMENSIONS for field in ("score", "note")]
        placeholders = ", ".join(f"${index + 2}" for index in range(len(columns)))
        base = len(columns) + 2
        query = f"""
            INSERT INTO interview_evaluations
              (session_id, {", ".join(columns)}, summary, recommendation, updated_by)
            VALUES ($1, {placeholders}, ${base}, ${base + 1}, ${base + 2})
            ON CONFLICT (session_id) DO UPDATE SET
              {", ".join(f"{column} = EXCLUDED.{column}" for column in columns)},
              summary = EXCLUDED.summary, recommendation = EXCLUDED.recommendation,
              updated_by = EXCLUDED.updated_by, updated_at = NOW()
        """
        async with self.pool.acquire() as conn:
            await conn.execute(query, session_id, *values, summary, recommendation, updated_by)
        return await self.get_evaluation(session_id)

    # Settings

    async def get_settings(self) -> dict:
        query = "SELECT default_duration_seconds, default_ai_policy, updated_at FROM interview_settings"
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(query)
        return {
            "defaultDurationSeconds": row["default_duration_seconds"],
            "defaultAiPolicy": row["default_ai_policy"],
            "updatedAt": row["updated_at"],
        }

    async def save_settings(self, duration_seconds: int, ai_policy: str) -> dict:
        query = """
            UPDATE interview_settings
            SET default_duration_seconds = $1, default_ai_policy = $2, updated_at = NOW()
        """
        async with self.pool.acquire() as conn:
            await conn.execute(query, duration_seconds, ai_policy)
        return await self.get_settings()

    # The problem library, as an interviewer sees it

    async def get_guide(self, problem_id: UUID) -> dict | None:
        query = "SELECT * FROM interview_problem_guides WHERE problem_id = $1"
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(query, problem_id)
        return _map_guide(row) if row else None

    async def list_guides(self) -> dict[UUID, dict]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch("SELECT * FROM interview_problem_guides")
        return {row["problem_id"]: _map_guide(row) for row in rows}

    async def list_problem_tests(self) -> dict[UUID, list[dict]]:
        """Every problem's full test list. For interviewers only."""
        async with self.pool.acquire() as conn:
            rows = await conn.fetch("SELECT id, tests FROM problems")
        return {row["id"]: json.loads(row["tests"]) for row in rows}

    async def session_counts_by_problem(self) -> dict[UUID, int]:
        query = "SELECT problem_id, COUNT(*) AS sessions FROM interview_sessions GROUP BY problem_id"
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query)
        return {row["problem_id"]: row["sessions"] for row in rows}

    # The judge, seen from outside

    async def judge_queue(self) -> dict:
        """How much is waiting on the runner and when it last finished a run.

        The API cannot see the runner process. A queue that is not draining
        is how a stopped runner shows.
        """
        query = """
            SELECT
              COUNT(*) FILTER (WHERE status IN ('pending', 'running')) AS waiting,
              EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE status IN ('pending', 'running')))
                AS oldest_waiting_seconds,
              MAX(created_at) FILTER (WHERE status NOT IN ('pending', 'running')) AS last_judged_at
            FROM submissions
        """
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(query)
        oldest = row["oldest_waiting_seconds"]
        return {
            "waiting": row["waiting"],
            "oldestWaitingSeconds": int(oldest) if oldest is not None else None,
            "lastJudgedAt": row["last_judged_at"],
        }
