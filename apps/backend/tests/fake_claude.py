#!/usr/bin/env python3
"""A stand-in for the Claude CLI, for the wrapper's tests.

It speaks the same stream-json lines, does what `behavior.json` in its config
directory says, and writes down how it was started, so a test can check what
the wrapper handed it without any model being called.
"""

import json
import os
import subprocess
import sys
import time

home = os.environ.get("CLAUDE_CONFIG_DIR", "")
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
    emit({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}})


def result(text, **extra):
    emit(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": text,
            "total_cost_usd": 0.0125,
            "duration_ms": 432,
            "usage": {
                "input_tokens": 321,
                "output_tokens": 45,
                "cache_read_input_tokens": 7,
                "cache_creation_input_tokens": 3,
            },
            "modelUsage": {behavior.get("answered_by", "fake-model-1"): {}},
            **extra,
        }
    )


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

emit({"type": "system", "subtype": "ui_invalidate", "event": "ui.render"})
emit({"type": "system", "subtype": "init", "model": "fake-model-1", "tools": []})

if mode == "answer":
    sys.stdout.write("this line is not json\n")
    emit({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hm"}}})
    for piece in behavior.get("pieces", ["Check ", "the empty ", "list case."]):
        delta(piece)
    result("".join(behavior.get("pieces", ["Check ", "the empty ", "list case."])))
elif mode == "whole":
    # No partial messages: only the final result carries the answer.
    result("A whole answer.")
elif mode == "slow":
    delta("Thinking about it")
    time.sleep(120)
elif mode == "flood":
    while True:
        delta("x" * 1000)
elif mode == "error":
    result("API Error: 401 token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 rejected", is_error=True)
elif mode == "crash":
    sys.stderr.write("fatal: could not reach gateway, Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF\n")
    sys.exit(3)
