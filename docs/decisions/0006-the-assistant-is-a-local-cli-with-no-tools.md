# 0006. The assistant is a local CLI with no tools

Status: accepted, 2026-11-15

## Context

Some interviews allow the candidate to use AI, and the interviewer wants to see how they use it. The assistant has to be the real model, since a stand-in would teach nothing about how someone works with one. The people running TandemCode for a class already have a Claude Code CLI signed in on the host and no API key to hand to the server.

Running a coding agent's CLI from a web request is dangerous by default. Such a CLI can read files and run commands, and the text it is given comes from whoever is typing in the browser.

## Decision

The API answers a question by starting the configured Claude CLI once, in `app/assistant/cli.py`, and nothing else starts it.

- The arguments are a fixed list plus a model name and an effort that are validated at start-up. The question and everything attached to it go in on stdin.
- The CLI is started with an empty tool list, no MCP servers, no saved session, and in a mode that ignores the profile's own instructions, skills, plugins and hooks. With no tools it can only return text.
- It runs in one configured directory, with a short list of inherited variables, under a deadline and an output cap. Cancelling, timing out or exceeding the cap kills its process group.
- It will not run against a profile directory listed as reserved, and it will not run with no profile named.
- Asking is refused unless the session allows AI and the asker is part of it. A candidate may ask only while the session runs.
- There is one model. If it cannot answer, the turn fails and says so.

Every question is stored with what was attached and what it cost.

## Consequences

- No API key is held by the server. The price is a process per question and a dependency on a CLI's flags and output format, which `tests/fake_claude.py` stands in for in the test suite.
- A person in a session with AI allowed can spend the host account's quota, up to the per-session and concurrency limits in `app/services/assistant.py`.
- The assistant cannot read the repository, run the candidate's code or see a held-back case. Giving it tools would be a new decision, not a flag.
- A hosted deployment would more likely call the model's API directly. The policy and storage in `app/services/assistant.py` do not depend on how the answer is produced.
