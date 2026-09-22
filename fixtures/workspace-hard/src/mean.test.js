import assert from "node:assert/strict";
import { test } from "node:test";
import { mean } from "./mean.js";

test("mean([]) === 0", () => {
  assert.equal(mean([]), 0);
});

test("mean([2, 4, 6]) === 4", () => {
  assert.equal(mean([2, 4, 6]), 4);
});
