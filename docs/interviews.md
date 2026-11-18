# Interviews

An interview session is a room with one problem, an AI policy and an interviewer's evidence notes. The room keeps doing what a room does: the shared editor, chat, runs and replay. Everything an interviewer adds lives in its own tables, so a practice room is unchanged.

The web app's interview screens are under `/console` for interviewers and `/c/<invite code>` for candidates.

## Who is who

An interviewer creates sessions, starts, pauses and ends sessions, sees every test case and the reference answer, and scores what they saw. With Clerk, the interviewers are the user ids listed in `INTERVIEW_OPERATOR_IDS`. With the list empty, nobody is one. `is_operator` in `app/core/auth.py` is the only place that decides.

A candidate is whoever redeems a session's invite code first. The code is in the invite link and is the candidate's whole credential, so `InterviewService.create` draws it from the operating system's random source. A second person arriving with the same link is refused. An interviewer who opens it is refused too, so they cannot take the seat by accident.

Anyone else asking about a session is told it does not exist. A guessed id confirms nothing.

An interview room is closed to everyone but its participants. `room_participant` in `app/websocket/auth.py` checks this for both websockets, which a practice room does not need.

## Session states

Sessions are scheduled, running, paused or ended. The interviewer starts, pauses, resumes and ends them manually. Reset returns the session to Scheduled and hides held-back cases. Runs, assistant questions and evidence stay in the record.

The server still records session timestamps for existing API consumers and exports. The interview screens have no countdown or time limit controls.

A candidate can edit, run tests and ask Codex while the session is running. The server enforces this for runs and Codex. The editor applies its lock in the browser.

## Held-back cases

Two Sum is preselected for new interviews. Its statement, starter and reference solution are defined in `V18__two_sum_interview.sql`. A problem's hidden tests are the held-back cases in an interview. The judge runs them with every run. The candidate is shown the public examples with their output and is told how many cases are held back, and nothing else: not their inputs, not whether they passed, not how many failed. The interviewer sees all of it.

The interviewer can reveal the held-back cases once a run has been judged, and not before. The reveal is meant to follow an attempt.

Runs leave the server on several paths, and each one applies the same rule through `RunVisibility` in `app/services/interviews.py`: the interview's own run list, the room's run list and single run, the replay, and the room websocket. A broadcast reaches every seat, so it carries what the candidate may see, and the interviewer's screens read the rest over HTTP.

A problem opts in to having every case judged with the `judge_all_tests` column. See [judge and sandbox](judge-and-sandbox.md).

## Per-session wording

The interviewer can edit the brief, the acceptance criteria and the starter code for one session. The edits are stored on the session. The library problem is not changed, in line with [decision 0004](decisions/0004-problems-are-migrations.md), and every other session keeps the library's wording. An edit set back to the library's text is stored as no edit, so a later fix to the library still reaches the session.

The tests are never edited from the console. They are proven by a reference solution in CI, and a session that could change them would lose that.

Acceptance criteria, the interviewer's plan, the change request and the reference answer for a problem are in `interview_problem_guides`. Criteria are shown to candidates. The rest is for interviewers and has no route to a candidate's screen.

## The assistant

A session either allows AI or does not. The choice has no default in the API: `CreateInterviewRequest` requires it. Both sides see the policy in the room, and it is on every list and in every export.

With AI allowed, a participant can ask Codex from the room's sidebar. `app/assistant/cli.py` runs the signed-in Codex CLI in a dedicated directory. It passes the prompt on stdin and starts Codex with read-only sandboxing, no approvals, disabled shell execution, and disabled plugins, connectors, hooks and subagents. It skips user and project configuration. Cancel, timeout and the response-size limit stop the process group.

The web app receives status events and completed text messages as Codex emits them. The CLI reports token counts with the turn, and elapsed time is measured on the server. Per-turn dollar cost is unavailable through this connection.

Only what the asker ticks is attached to a question: the problem, the editor's text, the latest test results. The server builds the problem and the test results itself, so a candidate's attachment cannot include a held-back case before the reveal. The editor's text is the one part the browser supplies, because the server keeps no copy of the document, and it is sent only when its box is ticked.

Every question is stored in `interview_ai_turns` with what was attached, the configured model, tokens and time. The interviewer reads all of them. A candidate reads their own. The interviewer can see sanitized failure details.

The run belongs to a task of its own in the API process (`LiveTurn`), not to the request that asked. A browser that goes away cancels the run, and the turn is still recorded.

### Setting it up

Set the `CODEX_CLI_*` variables in `apps/backend/.env.example` for the executable, signed-in Codex home, model and isolated working directory. Settings includes a connection test.

## Evidence and export

The interviewer scores four things they can observe: requirement clarification, verification, understanding and tool ownership. Each is 0, 1 or 2, or left unobserved. Unobserved is stored as NULL and is not a zero. The definitions are `EVIDENCE` in `app/services/interviews.py`.

The recommendation is typed by the interviewer and starts as undecided. Nothing in the schema or the code derives it from a run. A candidate whose code passes every case has an empty evaluation until a person writes one, and `test_passing_every_test_recommends_nothing` holds that in place.

An evaluation exports as JSON or Markdown from `GET /api/interviews/{id}/evaluation/export`. The export lists the runs and the assistant use as facts beside the evidence, and states the AI policy.

## Demo mode

`AUTH_MODE=demo` replaces Clerk with a local stand-in, for a demonstration on one machine and its tailnet where nobody has accounts. The interviewer signs in with an access code. A candidate's invite link is their sign-in. Both get a short-lived token from the routes in `app/routes/demo.py`.

It is built so that it cannot become a way around real sign-in:

- It is off unless `AUTH_MODE` says demo, and then it needs two secrets of its own with no defaults.
- It refuses to start while the Clerk settings are present, so a deployment cannot be switched into it by one variable.
- It answers only callers on the networks in `DEMO_ALLOWED_NETWORKS`, by default this machine and the tailnet range. Behind a public reverse proxy every caller arrives from the proxy's address and is refused.
- Its tokens are HS256 and Clerk's are RS256. Each mode rejects the other's, and the demo routes are a 404 under Clerk.

`app/core/demo_auth.py` holds all of it. The production compose file and its env template do not mention demo mode, and `test_nothing_shipped_turns_demo_mode_on` keeps it that way.

To run a demonstration:

1. In the API's environment set `AUTH_MODE=demo`, `DEMO_AUTH_SECRET` and `DEMO_OPERATOR_CODE`, and leave `CLERK_ISSUER` and `CLERK_SECRET_KEY` empty.
2. Build the web app with `VITE_AUTH_MODE=demo`. That build has only the interview screens. The practice rooms sign in with Clerk and are left out.
3. Start the runner with `SANDBOX_IMAGE` set, as always.
4. Optionally run `python -m app.interview_seed` for a few sample sessions. They are flagged as samples and shown as such. Their runs are judged by the real runner, and no assistant conversation is made up.

## Where it lives

- Sessions, roles, masking and export: `app/services/interviews.py`, `app/dao/interviews.py`, `app/routes/interviews.py`.
- The assistant: `app/assistant/cli.py` for the process, `app/services/assistant.py` for policy and storage, `app/dao/ai_turns.py`.
- Demo sign-in: `app/core/demo_auth.py`, `app/services/demo.py`, `app/routes/demo.py`.
- The schema: `apps/backend/migrations/V15__interview_sessions.sql`.
- The console and the room: `apps/web/src/console/`. The room reuses the shared editor and the room websocket hook.

## Adding an interview problem

Add the problem as [CONTRIBUTING.md](../CONTRIBUTING.md) describes. A test may carry a `name`, which the interview screens show for each case. Then add a second migration that sets `judge_all_tests` for it and inserts its row in `interview_problem_guides`, as `V17__interview_guides.sql` does. If the guide has a reference answer, keep it identical to the file in `apps/backend/tests/solutions/`. `test_the_guide_reference_is_the_judged_solution` compares the two.
