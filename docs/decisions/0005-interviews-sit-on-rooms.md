# 0005. Interviews sit on rooms

Status: accepted, 2026-11-15

## Context

An interview needs what a practice room already has: a shared editor, runs in a sandbox, chat and a replay. It also needs things a room does not have. One person runs it and the other is assessed, so the two must not see the same things. The problem has cases the candidate is not shown. There is a clock, and a record of what the interviewer observed.

## Decision

An interview session is a row that points at a room. The room is created with the session, unlisted, and keeps its two websockets unchanged. The session adds the clock, the AI policy, per-session wording and the evidence notes in tables of their own.

What each seat may see is decided in the API, in one place, `app/services/interviews.py`. Runs leave the API on several paths that practice rooms already use. Each of them asks `RunVisibility` first, and a broadcast carries only what the candidate may see. The room socket gains one event, `interview`, which carries no data and tells both sides to read the session again over HTTP.

A problem's hidden tests are the interview's held-back cases. No second kind of test was added.

The server does not end a session when its time is used up. It reports how far over the session is, and the interviewer ends it.

## Consequences

- A practice room is untouched, and an interview gets the editor, the sandbox and the replay without a second implementation.
- The candidate's browser never receives a held-back result before the reveal, on any path. A new path that returns runs has to go through `RunVisibility` too, and the tests in `test_interview_runs.py` name the paths that exist today.
- The editor's lock while a session is paused is in the browser only. The relay keeps no document ([0003](0003-the-server-relays-the-editor.md)) and does not know who may type. Runs and the assistant are refused by the server.
- The library problem cannot be edited from the console ([0004](0004-problems-are-migrations.md)). An interviewer edits the wording for one session, and the tests stay as CI proved them.
- Interviewers are a list of user ids in the environment. A team that needs roles per interview, or more than one organisation, will outgrow that.
