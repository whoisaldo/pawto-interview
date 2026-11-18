#!/usr/bin/env python3
"""A stand-in for `codex app-server`, for the wrapper's tests.

It answers the same JSON-RPC requests over stdio, does what `behavior.json` in
its config directory says, and writes down how it was started and what it was
sent, so a test can check what the wrapper handed it without any model being
called.
"""

import json
import os
import subprocess
import sys
import time

home = os.environ.get("CODEX_HOME", "")
behavior = {"mode": "answer"}
try:
    with open(os.path.join(home, "behavior.json")) as handle:
        behavior.update(json.load(handle))
except OSError:
    pass

record = {
    "argv": sys.argv[1:],
    "requests": [],
    "env": dict(os.environ),
    "cwd": os.getcwd(),
    "pid": os.getpid(),
}
THREAD = "thread-fixture"
mode = behavior["mode"]


def save():
    with open(os.path.join(home, "record.json"), "w") as handle:
        json.dump(record, handle)


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def notify(method, **params):
    emit({"method": method, "params": params})


def delta(text, item="msg-1"):
    notify("item/agentMessage/delta", threadId=THREAD, turnId="turn-1", itemId=item, delta=text)


def completed_item(text, item="msg-1"):
    notify("item/completed", threadId=THREAD, turnId="turn-1", item={"type": "agentMessage", "id": item, "text": text})


def finish(status="completed", error=None):
    notify("thread/tokenUsage/updated", threadId=THREAD, turnId="turn-1", tokenUsage={
        "total": {"totalTokens": 376, "inputTokens": 331, "cachedInputTokens": 7, "cacheWriteInputTokens": 3,
                  "outputTokens": 45, "reasoningOutputTokens": 0},
        "last": {}, "modelContextWindow": None,
    })
    notify("turn/completed", threadId=THREAD, turn={"id": "turn-1", "status": status, "error": error})


if mode in ("slow", "flood"):
    # A grandchild that outlives this process unless the whole group is killed.
    beat = os.path.join(home, "heartbeat")
    child = subprocess.Popen(
        [sys.executable, "-c", f"import time\nwhile True:\n    open({beat!r}, 'a').write('x')\n    time.sleep(0.02)\n"]
    )
    record["grandchild"] = child.pid
save()

if mode == "crash":
    sys.stderr.write("fatal: could not reach provider, Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n")
    sys.exit(3)


def run_turn(prompt):
    if mode == "answer":
        sys.stdout.write("this line is not json\n")
        notify("item/reasoning/summaryTextDelta", threadId=THREAD, delta="This should not reach the caller.")
        pieces = behavior.get("pieces", ["Check the empty list case."])
        for piece in pieces:
            delta(piece)
        completed_item("".join(pieces))
        finish()
    elif mode == "whole":
        completed_item("A whole answer.")
        finish()
    elif mode == "two":
        delta("First part.", item="a")
        completed_item("First part.", item="a")
        delta("Second part.", item="b")
        completed_item("Second part.", item="b")
        finish()
    elif mode == "other-thread":
        notify("item/agentMessage/delta", threadId="someone-else", turnId="t", itemId="x", delta="Not yours.")
        delta("Yours.")
        finish()
    elif mode == "asks":
        # A server request, as for an approval. The wrapper must refuse it.
        emit({"id": 99, "method": "item/commandExecution/requestApproval", "params": {"threadId": THREAD}})
        reply = json.loads(sys.stdin.readline())
        record["approval_reply"] = reply
        save()
        delta("Answered without it.")
        finish()
    elif mode == "slow":
        delta("Thinking about it")
        time.sleep(120)
    elif mode == "flood":
        while True:
            delta("x" * 1000)
    elif mode == "empty":
        finish()
    elif mode == "error":
        notify("error", threadId=THREAD, turnId="turn-1", willRetry=False,
               error={"message": "API Error: 401 token=sk-test-abcdefghijklmnopqrstuvwxyz0123456789 rejected"})
        finish(status="failed", error={"message": "API Error: 401 token=sk-test-abcdefghijklmnopqrstuvwxyz0123456789 rejected"})


for line in sys.stdin:
    request = json.loads(line)
    record["requests"].append(request)
    save()
    method, ident = request.get("method"), request.get("id")
    if method == "initialize":
        emit({"id": ident, "result": {"userAgent": "fake"}})
        notify("remoteControl/status/changed", status="disabled")
    elif method == "mcpServerStatus/list":
        servers = [{"name": "configured", "serverInfo": None, "tools": {}}]
        if mode == "mcp-running":
            servers.append({"name": "live", "serverInfo": {"name": "Live"}, "tools": {"run": {"name": "run"}}})
        emit({"id": ident, "result": {"data": servers}})
    elif method == "thread/start":
        # What the assistant was told, under the names the API tests read.
        record["system"] = request["params"].get("baseInstructions")
        save()
        if mode == "refused":
            emit({"id": ident, "error": {"code": -32600, "message": "model not available, key=abcdefghijklmnopqrstuvwxyz0123456789"}})
            continue
        emit({"id": ident, "result": {"thread": {"id": THREAD}, "model": request["params"]["model"]}})
        notify("thread/started", thread={"id": THREAD})
    elif method == "turn/start":
        record["stdin"] = request["params"]["input"][0]["text"]
        save()
        emit({"id": ident, "result": {"turn": {"id": "turn-1"}}})
        notify("turn/started", threadId=THREAD, turn={"id": "turn-1"})
        run_turn(request["params"]["input"][0]["text"])
