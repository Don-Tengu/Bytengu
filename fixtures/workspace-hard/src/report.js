import { sum } from "./sum.js";
import { mean } from "./mean.js";

export function report(nums) {
  return `n=${nums.length} sum=${sum(nums)} mean=${mean(nums)}`;
}
