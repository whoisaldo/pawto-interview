-- V17: Interviewer guides for three problems
--
-- The guide for actual-grader-output carries the seven-minute plan, the
-- change request and the reference answer for the AI-allowed interview
-- exercise. Its reference is the same text as tests/solutions/, which the
-- test suite judges against every case and compares with this row.

UPDATE problems SET judge_all_tests = TRUE WHERE slug = 'actual-grader-output';

INSERT INTO interview_problem_guides
  (problem_id, summary, acceptance_criteria, provenance, interviewer_guide, reference_code, recommended_duration_seconds)
SELECT id,
  $$Tell real grader output from a placeholder record. The starter passes every public example and is still wrong.$$,
  $criteria$[
  "Returns true when grader_result_tests has at least one row, whether or not that test passed.",
  "Returns true when lint_output contains at least one non-whitespace character.",
  "Returns true when grader_result_output has at least one row, even if that row is empty.",
  "Returns false when only errors, max_score, empty lists, null fields or missing fields are present.",
  "Returns false when there is no record.",
  "Leaves the input record unchanged."
]$criteria$::jsonb,
  $provenance$Teaching exercise derived from the Pawtograder helper graderResultsHasAutograderTestsOrOutput.

Source repository: https://github.com/pawtograder/platform.git
Pinned commit: 146759bee573b633fa7dd8850d8c73194e8bdb0e
Source file: lib/submissionHasGraderOutput.ts

The starter is a deliberately broken variant written for teaching. It is not a claim that Pawtograder has this defect.

This is a Python teaching port of the same contract. The source is TypeScript and TandemCode's judge runs Python. JavaScript treats an empty array as truthy; the port keeps that defect by testing whether a list is present instead of whether it has rows, so the starter fails the same four held-back cases as the JavaScript teaching variant.

A dependency-free Node version of the exercise (candidate.mjs, reference.mjs, cases.mjs and run.mjs) is kept with the source materials and runs without this app.$provenance$,
  $guide${
  "timeline": [
    {
      "minutes": 1,
      "phase": "Clarify",
      "detail": "The candidate restates the contract and asks what counts as output. Listen for questions about empty lists, whitespace-only logs and errors-only records before any code changes."
    },
    {
      "minutes": 2,
      "phase": "AI-assisted diagnosis",
      "detail": "The candidate chooses what to attach and what to ask. Note whether they check the assistant's claims against the contract or accept them as given."
    },
    {
      "minutes": 2,
      "phase": "Edit and test",
      "detail": "The starter already passes all four public examples, so a green run is not evidence of a fix. Watch for cases the candidate writes or reasons through on their own."
    },
    {
      "minutes": 1,
      "phase": "Explain a boundary case",
      "detail": "Ask why a whitespace-only log, or an empty list, must be false. Reveal the held-back cases after their attempt and discuss any that fail."
    },
    {
      "minutes": 1,
      "phase": "Change request",
      "detail": "Give the change request below and ask how the design should change."
    }
  ],
  "changeRequest": {
    "prompt": "Errors-only records should now be shown in a separate diagnostic view, without counting as actual automated-check output. How would you change the design?",
    "listenFor": [
      "Keeps hasActualGraderOutput as it is and adds a second predicate for diagnostics, instead of widening the first.",
      "Explains why one broad boolean would be wrong for both jobs: the points line must stay hidden for a placeholder, and the diagnostic view must show it.",
      "Says which caller uses which predicate, and adds cases for errors-only and errors-plus-output records."
    ]
  },
  "heldBackNote": "Held-back cases stay hidden from the candidate until you reveal them, and can only be revealed after a judged attempt. The discussion is then about whether their reasoning transferred, not about guessing tests.",
  "extension": "The source file also exports submissionHasGraderOutput, which counts errors on purpose for a different part of the interface. Keeping the two apart is a useful extension if the candidate finishes early."
}$guide$::jsonb,
  $reference$import json
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
$reference$,
  420
FROM problems WHERE slug = 'actual-grader-output';

INSERT INTO interview_problem_guides
  (problem_id, summary, acceptance_criteria, provenance, interviewer_guide, reference_code, recommended_duration_seconds)
SELECT id,
  $$A warm-up with a clear brute force and a one-pass answer.$$,
  $criteria$[
  "Returns the two indices whose values add up to target, smaller index first.",
  "Works when the two values are equal and when values are negative.",
  "Does not use the same element twice.",
  "Runs in one pass over the list for the hidden large inputs."
]$criteria$::jsonb,
  NULL,
  $guide${
  "timeline": [
    {
      "minutes": 3,
      "phase": "Clarify",
      "detail": "Duplicates, negatives and whether exactly one answer exists."
    },
    {
      "minutes": 10,
      "phase": "Solve",
      "detail": "A brute force first is fine. Ask for its cost before they optimise."
    },
    {
      "minutes": 5,
      "phase": "Verify",
      "detail": "Ask which input would break a solution that reuses one element."
    },
    {
      "minutes": 2,
      "phase": "Follow-up",
      "detail": "Give the change request below."
    }
  ],
  "changeRequest": {
    "prompt": "The list is now sorted and too large to copy. What changes?",
    "listenFor": [
      "Two pointers from both ends, with constant extra memory.",
      "Says what the sorted order buys and what the hash map cost."
    ]
  },
  "heldBackNote": "Hidden tests cover equal values and negatives. Reveal them after a judged attempt."
}$guide$::jsonb,
  NULL,
  1200
FROM problems WHERE slug = 'two-sum';

INSERT INTO interview_problem_guides
  (problem_id, summary, acceptance_criteria, provenance, interviewer_guide, reference_code, recommended_duration_seconds)
SELECT id,
  $$Sorting plus a sweep, with boundary cases worth talking through.$$,
  $criteria$[
  "Merges every pair of overlapping intervals, including ones that only touch at an endpoint.",
  "Returns the merged intervals sorted by start.",
  "Handles a single interval and intervals given out of order."
]$criteria$::jsonb,
  NULL,
  $guide${
  "timeline": [
    {
      "minutes": 4,
      "phase": "Clarify",
      "detail": "Whether touching intervals merge, and whether the input is sorted."
    },
    {
      "minutes": 14,
      "phase": "Solve",
      "detail": "Sort by start, then sweep. Ask why sorting by end would not work."
    },
    {
      "minutes": 5,
      "phase": "Verify",
      "detail": "Ask for the case where one interval contains the next."
    },
    {
      "minutes": 2,
      "phase": "Follow-up",
      "detail": "Give the change request below."
    }
  ],
  "changeRequest": {
    "prompt": "Intervals now arrive one at a time and the merged list must stay current. What changes?",
    "listenFor": [
      "Inserts into a sorted structure and merges only with neighbours.",
      "Compares the cost of each insert with re-sorting everything."
    ]
  },
  "heldBackNote": "Hidden tests cover containment and unsorted input. Reveal them after a judged attempt."
}$guide$::jsonb,
  NULL,
  1500
FROM problems WHERE slug = 'merge-intervals';
