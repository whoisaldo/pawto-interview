-- V16: Add the Actual Output or Placeholder problem

INSERT INTO problems (slug, title, difficulty, time_limit_ms, mem_limit_mb, statement, starter_code, tests)
VALUES (
  'actual-grader-output',
  'Actual Output or Placeholder?',
  'easy',
  2000,
  256,
  $$A gradebook keeps one record for each grading run. Some records are placeholders, inserted when a workflow ended without a real grader run: they carry error details and a default max_score, but nothing the grader produced. Given a record result, a dict or None when there is no record, return True only when the grader produced actual output. Do not modify result.

Actual output is any one of these: at least one row in grader_result_tests, whether or not that test passed; a lint_output log with at least one non-whitespace character; at least one row in grader_result_output, even when the row itself is empty.

errors, max_score, empty lists, None fields and missing fields do not count on their own. Records use the field types shown in the examples, and validating their shape is out of scope.

Input: one line holding the record as JSON, or null. No input at all means there is no record.
Output: true or false.$$,
  $starter$import json
import sys
from typing import Optional


class Solution:
    def hasActualGraderOutput(self, result: Optional[dict]) -> bool:
        """
        Deliberately broken teaching variant, not production Pawtograder code.
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
        return bool(
            result.get("grader_result_tests") is not None
            or result.get("lint_output")
            or result.get("grader_result_output") is not None
            or result.get("errors") is not None
        )


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
$starter$,
  $$[
    {"name": "null result", "input": "null\n", "expected": "false", "hidden": false},
    {"name": "actual test row", "input": "{\"grader_result_tests\": [{\"name\": \"test 1\"}]}\n", "expected": "true", "hidden": false},
    {"name": "lint log", "input": "{\"lint_output\": \"Build completed\"}\n", "expected": "true", "hidden": false},
    {"name": "captured stderr row", "input": "{\"grader_result_output\": [{\"stderr\": \"failure details\"}]}\n", "expected": "true", "hidden": false},
    {"name": "missing result", "input": "", "expected": "false", "hidden": true},
    {"name": "empty object", "input": "{}\n", "expected": "false", "hidden": true},
    {"name": "empty arrays", "input": "{\"grader_result_tests\": [], \"grader_result_output\": []}\n", "expected": "false", "hidden": true},
    {"name": "whitespace log", "input": "{\"lint_output\": \" \\n\\t \"}\n", "expected": "false", "hidden": true},
    {"name": "error metadata only", "input": "{\"errors\": {\"message\": \"workflow cancelled\"}}\n", "expected": "false", "hidden": true},
    {"name": "placeholder with default max score", "input": "{\"grader_result_tests\": [], \"lint_output\": \" \", \"grader_result_output\": [], \"errors\": {\"message\": \"runner never started\"}, \"max_score\": 100}\n", "expected": "false", "hidden": true},
    {"name": "errors plus actual output", "input": "{\"errors\": {\"message\": \"partial failure\"}, \"grader_result_output\": [{}]}\n", "expected": "true", "hidden": true},
    {"name": "null optional fields", "input": "{\"grader_result_tests\": null, \"lint_output\": null, \"grader_result_output\": null}\n", "expected": "false", "hidden": true}
  ]$$::jsonb
);
