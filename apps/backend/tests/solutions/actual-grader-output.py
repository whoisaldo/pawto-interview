import json
import sys
from typing import Optional


class Solution:
    def hasActualGraderOutput(self, result: Optional[dict]) -> bool:
        """
        Reference answer to the teaching variant. Keep out of the candidate view.
        Python teaching port of graderResultsHasAutograderTestsOrOutput in
        https://github.com/pawtograder/platform/blob/146759bee573b633fa7dd8850d8c73194e8bdb0e/lib/submissionHasGraderOutput.ts

        Contract: return True only for at least one test row, a lint/build
        log with non-whitespace text, or at least one captured
        stdout/stderr row. Error metadata alone does not count. None,
        missing fields and empty lists do not count. Do not modify result.
        Inputs follow that shape; validating untrusted input is out of scope.
        """
        if not result:
            return False
        if len(result.get("grader_result_tests") or []) > 0:
            return True
        if len((result.get("lint_output") or "").strip()) > 0:
            return True
        if len(result.get("grader_result_output") or []) > 0:
            return True
        return False


# Reads the input, calls your solution and prints the result.
# You do not need to change anything below this line.
raw = sys.stdin.read()
record = json.loads(raw) if raw.strip() else None
before = json.dumps(record, sort_keys=True)
answer = Solution().hasActualGraderOutput(record)
if json.dumps(record, sort_keys=True) != before:
    print("input was modified")
elif answer is True:
    print("true")
elif answer is False:
    print("false")
else:
    print(f"not a bool: {answer!r}")
