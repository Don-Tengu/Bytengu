import { sum } from "./sum.js";

export function mean(nums) {
  if (nums.length === 0) return 0;
  return sum(nums) / nums.length;
}
