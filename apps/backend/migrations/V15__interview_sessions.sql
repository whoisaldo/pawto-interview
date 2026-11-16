-- V15: Interview sessions on top of rooms
--
-- An interview session is a room with a clock, a problem, an AI policy and an
-- interviewer's evidence notes. The room keeps the shared editor, chat and
-- runs; everything an interviewer adds lives in the tables below, so a plain
-- practice room is unchanged.

-- A practice run stops at the first failing test. An interview reports every
-- case by name, so the problem opts in to judging all of them.
ALTER TABLE problems ADD COLUMN judge_all_tests BOOLEAN NOT NULL DEFAULT FALSE;

-- What an interviewer needs beside a problem and a candidate must not be sent:
-- the plan for the session, the follow-up and the reference answer. Acceptance
-- criteria are the one field here that candidates do see.
CREATE TABLE interview_problem_guides (
  problem_id UUID PRIMARY KEY REFERENCES problems(id),
  summary TEXT NOT NULL,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance TEXT,
  interviewer_guide JSONB NOT NULL DEFAULT '{}'::jsonb,
  reference_code TEXT,
  recommended_duration_seconds INT NOT NULL DEFAULT 2700
    CHECK (recommended_duration_seconds BETWEEN 60 AND 14400)
);

CREATE TABLE interview_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  candidate_name TEXT NOT NULL CHECK (char_length(candidate_name) BETWEEN 1 AND 80),
  candidate_email TEXT CHECK (candidate_email IS NULL OR char_length(candidate_email) <= 254),
  problem_id UUID NOT NULL REFERENCES problems(id),
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
  -- The candidate's way in. Whoever redeems it first is the candidate.
  invite_code TEXT NOT NULL UNIQUE,
  candidate_user_id TEXT REFERENCES users(id),
  duration_seconds INT NOT NULL CHECK (duration_seconds BETWEEN 60 AND 14400),
  ai_policy TEXT NOT NULL CHECK (ai_policy IN ('allowed', 'disabled')),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'paused', 'ended')),
  -- Time used before the current stretch. While running, the stretch since
  -- running_since is added on read, so a pause costs one write, not a tick.
  elapsed_seconds INT NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
  running_since TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  held_back_revealed_at TIMESTAMPTZ,
  -- Per-session edits to the brief. NULL means the library's text.
  brief_statement TEXT CHECK (brief_statement IS NULL OR char_length(brief_statement) <= 8000),
  brief_criteria JSONB,
  brief_starter_code TEXT CHECK (brief_starter_code IS NULL OR octet_length(brief_starter_code) <= 65536),
  -- Seeded by app.interview_seed for a demonstration, and labelled as such.
  is_sample BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT interview_sessions_clock_matches_status
    CHECK ((status = 'running') = (running_since IS NOT NULL))
);

CREATE INDEX interview_sessions_created_at ON interview_sessions (created_at DESC);

-- Evidence, not a verdict: four things an interviewer can observe, each
-- 0, 1 or 2, or NULL when there was no chance to observe it. The
-- recommendation is typed by a person and starts undecided; nothing in the
-- schema or the code derives it from a run.
CREATE TABLE interview_evaluations (
  session_id UUID PRIMARY KEY REFERENCES interview_sessions(id),
  clarification_score SMALLINT CHECK (clarification_score BETWEEN 0 AND 2),
  clarification_note TEXT NOT NULL DEFAULT '' CHECK (char_length(clarification_note) <= 4000),
  verification_score SMALLINT CHECK (verification_score BETWEEN 0 AND 2),
  verification_note TEXT NOT NULL DEFAULT '' CHECK (char_length(verification_note) <= 4000),
  understanding_score SMALLINT CHECK (understanding_score BETWEEN 0 AND 2),
  understanding_note TEXT NOT NULL DEFAULT '' CHECK (char_length(understanding_note) <= 4000),
  ownership_score SMALLINT CHECK (ownership_score BETWEEN 0 AND 2),
  ownership_note TEXT NOT NULL DEFAULT '' CHECK (char_length(ownership_note) <= 4000),
  summary TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 8000),
  recommendation TEXT NOT NULL DEFAULT 'undecided'
    CHECK (recommendation IN ('undecided', 'advance', 'hold', 'decline')),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every question put to the assistant in a session, with what was attached
-- and what it cost. The interviewer reads this; it is how AI use is visible.
CREATE TABLE interview_ai_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES interview_sessions(id),
  conversation_id UUID NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  asked_as TEXT NOT NULL CHECK (asked_as IN ('interviewer', 'candidate')),
  question TEXT NOT NULL,
  -- [{"kind": "prompt" | "code" | "tests", "bytes": n}]: what the asker chose
  -- to attach. Nothing else about the session reaches the model.
  context JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_bytes INT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'cancelled', 'failed', 'timeout', 'truncated')),
  error TEXT,
  model TEXT,
  effort TEXT,
  input_tokens INT,
  output_tokens INT,
  cache_read_tokens INT,
  cache_write_tokens INT,
  cost_usd NUMERIC(12, 6),
  duration_ms INT,
  first_token_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX interview_ai_turns_session ON interview_ai_turns (session_id, created_at);

-- One question in flight per person, for the same reason as one run: the
-- check and the insert cannot be raced apart.
CREATE UNIQUE INDEX interview_ai_turns_one_in_flight_per_user
  ON interview_ai_turns (user_id)
  WHERE status = 'running';

-- Defaults for the new-interview form. One row, so there is nothing to pick.
CREATE TABLE interview_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  default_duration_seconds INT NOT NULL DEFAULT 2700
    CHECK (default_duration_seconds BETWEEN 60 AND 14400),
  default_ai_policy TEXT NOT NULL DEFAULT 'allowed'
    CHECK (default_ai_policy IN ('allowed', 'disabled')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO interview_settings (singleton) VALUES (TRUE);
