-- V20: The Tasks API as the AI-allowed interview exercise
--
-- Every case is judged on every run, and the guide carries the seven-minute
-- plan and the change request. The reference is the same text as
-- tests/solutions/tasks-api.py.

UPDATE problems SET judge_all_tests = TRUE WHERE slug = 'tasks-api';

INSERT INTO interview_problem_guides
  (problem_id, summary, acceptance_criteria, provenance, interviewer_guide, reference_code, recommended_duration_seconds)
SELECT id,
  $$Fix a small FastAPI service: a POST that reuses one id and answers 200, plus missing 404s, a crashing DELETE and blank titles.$$,
  $criteria$[
  "`POST /tasks` answers 201 with the new task. Every task gets its own id, starting at 1.",
  "A missing or blank title is rejected with 422.",
  "`GET` or `DELETE` on an unknown id answers 404 with `{\"detail\": \"Task not found\"}`.",
  "Handlers stay `async def`. The grader runs without threads."
]$criteria$::jsonb,
  NULL,
  $guide${
  "timeline": [
    {
      "minutes": 1,
      "phase": "Clarify",
      "detail": "What should POST return, and can a deleted task's id come back?"
    },
    {
      "minutes": 2,
      "phase": "Diagnose with AI",
      "detail": "Run the tests, then watch how they use Codex on the failures. Do they read the answer or paste it?"
    },
    {
      "minutes": 2,
      "phase": "Fix and test",
      "detail": "201 and the id counter first, then the 404s, the 204 and blank titles."
    },
    {
      "minutes": 1,
      "phase": "Boundary",
      "detail": "Ask why len(tasks) + 1 is the wrong id once a task can be deleted."
    },
    {
      "minutes": 1,
      "phase": "Change request",
      "detail": "Give the change request below."
    }
  ],
  "changeRequest": {
    "prompt": "Add PATCH /tasks/{id} that can rename a task or mark it done, and answers 404 for an unknown id.",
    "listenFor": [
      "A separate model with optional fields, so a PATCH without a title is not rejected.",
      "Reuses the same not-found path as GET and DELETE.",
      "Says which requests they would send to check it before running anything."
    ]
  },
  "heldBackNote": "Held-back cases cover unknown ids, delete, ids after a delete, and missing or blank titles. Reveal them after a judged run."
}$guide$::jsonb,
  $reference$from typing import Annotated

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, StringConstraints

app = FastAPI()


class TaskIn(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    done: bool = False


tasks: dict[int, dict] = {}
next_id = 1


def find(task_id: int) -> dict:
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    return tasks[task_id]


@app.get("/tasks")
async def list_tasks():
    return list(tasks.values())


@app.post("/tasks", status_code=201)
async def create_task(task: TaskIn):
    global next_id
    task_id = next_id
    next_id += 1
    tasks[task_id] = {"id": task_id, "title": task.title, "done": task.done}
    return tasks[task_id]


@app.get("/tasks/{task_id}")
async def get_task(task_id: int):
    return find(task_id)


@app.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: int):
    find(task_id)
    del tasks[task_id]
    return Response(status_code=204)


# Test harness: sends each request line from stdin to the app and prints the
# status and JSON body of every response. Leave this part as it is.
# Handlers stay `async def`: the grader runs without threads.
if __name__ == "__main__":
    import asyncio
    import json
    import sys

    async def call(method: str, path: str, body) -> tuple[int, bytes]:
        payload = b"" if body is None else json.dumps(body).encode()
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
            "query_string": b"", "root_path": "", "server": ("test", 80), "client": ("test", 1),
            "headers": [(b"host", b"test"), (b"content-type", b"application/json"),
                        (b"content-length", str(len(payload)).encode())],
        }
        incoming = [{"type": "http.request", "body": payload, "more_body": False}]
        response = {"status": 500, "body": b""}

        async def receive():
            return incoming.pop() if incoming else {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                response["status"] = message["status"]
            elif message["type"] == "http.response.body":
                response["body"] += message.get("body", b"")

        try:
            await app(scope, receive, send)
        except Exception as error:
            # The app has already answered 500. Say why, under the results.
            print(f"{method} {path} raised {type(error).__name__}: {error}", file=sys.stderr)
        return response["status"], response["body"]

    async def main():
        for line in sys.stdin.read().splitlines():
            if not line.strip():
                continue
            method, path, *rest = line.split(" ", 2)
            status, body = await call(method, path, json.loads(rest[0]) if rest else None)
            try:
                shown = json.dumps(json.loads(body), sort_keys=True)
            except ValueError:
                shown = ""
            print(status if status == 422 or not shown else f"{status} {shown}")

    asyncio.run(main())
$reference$,
  420
FROM problems WHERE slug = 'tasks-api';
