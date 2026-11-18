-- V19: Add the Tasks API problem
--
-- A small FastAPI app with a POST that hands every task the same id and
-- answers 200, plus missing 404s, a DELETE that crashes on an unknown id and
-- no check on blank titles. Each test sends a few requests through the app on
-- asyncio and compares status and JSON for every response.
--
-- Runs import FastAPI, so the judge's image is apps/backend/sandbox/Dockerfile
-- rather than plain python. The harness needs no threads, which the judge's
-- process limit does not allow.

INSERT INTO problems (slug, title, difficulty, time_limit_ms, mem_limit_mb, statement, starter_code, tests)
VALUES (
  'tasks-api',
  'Tasks API',
  'easy',
  10000,
  256,
  $brief$A small FastAPI service keeps a to-do list in memory, and its tests fail. Fix the handlers so the API works as described.

- `POST /tasks` with a JSON body `{"title": ..., "done": ...}` creates a task. `done` is optional and defaults to false. It answers 201 with the stored task.
- `GET /tasks` answers with every task, oldest first.
- `GET /tasks/{id}` answers with one task.
- `DELETE /tasks/{id}` removes the task and answers 204 with no body.

Each test sends a few requests, one per line, and checks the status and JSON body of every response.$brief$,
  $starter$from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class TaskIn(BaseModel):
    title: str
    done: bool = False


tasks: dict[int, dict] = {}
next_id = 1


@app.get("/tasks")
async def list_tasks():
    return list(tasks.values())


@app.post("/tasks")
async def create_task(task: TaskIn):
    task_id = next_id
    tasks[task_id] = {"id": task_id, "title": task.title, "done": task.done}
    return tasks[task_id]


@app.get("/tasks/{task_id}")
async def get_task(task_id: int):
    return tasks.get(task_id)


@app.delete("/tasks/{task_id}")
async def delete_task(task_id: int):
    tasks.pop(task_id)
    return {"deleted": task_id}


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
$starter$,
  $tests$[
    {"name": "Create, then read it back", "input": "POST /tasks {\"title\": \"Write the brief\"}\nGET /tasks/1\nGET /tasks\n", "expected": "201 {\"done\": false, \"id\": 1, \"title\": \"Write the brief\"}\n200 {\"done\": false, \"id\": 1, \"title\": \"Write the brief\"}\n200 [{\"done\": false, \"id\": 1, \"title\": \"Write the brief\"}]", "hidden": false},
    {"name": "Two tasks get their own ids", "input": "POST /tasks {\"title\": \"Draft\"}\nPOST /tasks {\"title\": \"Review\", \"done\": true}\nGET /tasks\n", "expected": "201 {\"done\": false, \"id\": 1, \"title\": \"Draft\"}\n201 {\"done\": true, \"id\": 2, \"title\": \"Review\"}\n200 [{\"done\": false, \"id\": 1, \"title\": \"Draft\"}, {\"done\": true, \"id\": 2, \"title\": \"Review\"}]", "hidden": false},
    {"name": "Unknown id", "input": "GET /tasks/7\nDELETE /tasks/7\n", "expected": "404 {\"detail\": \"Task not found\"}\n404 {\"detail\": \"Task not found\"}", "hidden": true},
    {"name": "Delete, then read", "input": "POST /tasks {\"title\": \"Ship it\"}\nDELETE /tasks/1\nGET /tasks/1\nGET /tasks\n", "expected": "201 {\"done\": false, \"id\": 1, \"title\": \"Ship it\"}\n204\n404 {\"detail\": \"Task not found\"}\n200 []", "hidden": true},
    {"name": "Ids are not reused after a delete", "input": "POST /tasks {\"title\": \"A\"}\nPOST /tasks {\"title\": \"B\"}\nDELETE /tasks/2\nPOST /tasks {\"title\": \"C\"}\nGET /tasks\n", "expected": "201 {\"done\": false, \"id\": 1, \"title\": \"A\"}\n201 {\"done\": false, \"id\": 2, \"title\": \"B\"}\n204\n201 {\"done\": false, \"id\": 3, \"title\": \"C\"}\n200 [{\"done\": false, \"id\": 1, \"title\": \"A\"}, {\"done\": false, \"id\": 3, \"title\": \"C\"}]", "hidden": true},
    {"name": "Missing or blank title", "input": "POST /tasks {\"title\": \"   \"}\nPOST /tasks {}\nPOST /tasks {\"title\": \"Real\"}\nGET /tasks\n", "expected": "422\n422\n201 {\"done\": false, \"id\": 1, \"title\": \"Real\"}\n200 [{\"done\": false, \"id\": 1, \"title\": \"Real\"}]", "hidden": true}
  ]$tests$::jsonb
);
