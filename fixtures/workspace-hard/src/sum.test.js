import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "./sum.js";

test("sum([]) === 0", () => {
  assert.equal(sum([]), 0);
});

test("sum([5]) === 5", () => {
  assert.equal(sum([5]), 5);
});

test("sum([1, 2, 3]) === 6", () => {
  assert.equal(sum([1, 2, 3]), 6);
});
