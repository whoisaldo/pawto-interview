#!/usr/bin/env python3
"""A stand-in for the Codex CLI, for the wrapper's tests.

It speaks the same JSONL lines, does what `behavior.json` in its config
directory says, and writes down how it was started, so a test can check what
the wrapper handed it without any model being called.
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

prompt = sys.stdin.read()
record = {
    "argv": sys.argv[1:],
    "stdin": prompt,
    "env": dict(os.environ),
    "cwd": os.getcwd(),
    "pid": os.getpid(),
}


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def delta(text):
    emit({"type": "item.completed", "item": {"type": "agent_message", "text": text}})


def complete():
    emit({
        "type": "turn.completed",
        "usage": {"input_tokens": 331, "output_tokens": 45, "cached_input_tokens": 7, "cache_write_input_tokens": 3},
    })


mode = behavior["mode"]
if mode in ("slow", "flood"):
    # A grandchild that outlives this process unless the whole group is killed.
    beat = os.path.join(home, "heartbeat")
    child = subprocess.Popen(
        [sys.executable, "-c", f"import time\nwhile True:\n    open({beat!r}, 'a').write('x')\n    time.sleep(0.02)\n"]
    )
    record["grandchild"] = child.pid

with open(os.path.join(home, "record.json"), "w") as handle:
    json.dump(record, handle)

emit({"type": "thread.started", "thread_id": "fixture"})
emit({"type": "turn.started"})

if mode == "answer":
    sys.stdout.write("this line is not json\n")
    emit({"type": "item.completed", "item": {"type": "reasoning", "text": "This should not reach the caller."}})
    for piece in behavior.get("pieces", ["Check the empty list case."]):
        delta(piece)
    complete()
elif mode == "whole":
    delta("A whole answer.")
    complete()
elif mode == "slow":
    delta("Thinking about it")
    time.sleep(120)
elif mode == "flood":
    while True:
        delta("x" * 1000)
elif mode == "empty":
    complete()
elif mode == "error":
    emit({"type": "turn.failed", "error": {"message": "API Error: 401 token=sk-test-abcdefghijklmnopqrstuvwxyz0123456789 rejected"}})
elif mode == "crash":
    sys.stderr.write("fatal: could not reach provider, Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n")
    sys.exit(3)
