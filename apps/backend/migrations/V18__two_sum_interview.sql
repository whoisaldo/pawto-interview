UPDATE problems SET
  statement = $brief$Given a list of integers nums and an integer target, find two entries whose sum is target. Return their zero-based indices in ascending order.

There is exactly one valid pair. Each index may be used once.$brief$,
  starter_code = $starter$from typing import List


class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        # Write your solution here.
        return []


if __name__ == "__main__":
    nums = list(map(int, input().split()))
    target = int(input())
    print(*Solution().twoSum(nums, target))
$starter$,
  judge_all_tests = TRUE
WHERE slug = 'two-sum';

UPDATE interview_problem_guides SET
  summary = 'Find two indices whose values add up to the target.',
  acceptance_criteria = '[
    "Use different indices, even when the two values are equal.",
    "Handle negative numbers.",
    "Explain the time and space complexity of your solution."
  ]'::jsonb,
  reference_code = $reference$from typing import List


class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for index, number in enumerate(nums):
            complement = target - number
            if complement in seen:
                return [seen[complement], index]
            seen[number] = index
        return []


if __name__ == "__main__":
    nums = list(map(int, input().split()))
    target = int(input())
    print(*Solution().twoSum(nums, target))
$reference$
WHERE problem_id = (SELECT id FROM problems WHERE slug = 'two-sum');
