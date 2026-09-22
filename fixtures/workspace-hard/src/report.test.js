import assert from "node:assert/strict";
import { test } from "node:test";
import { report } from "./report.js";

test('report([2, 4, 6]) === "n=3 sum=12 mean=4"', () => {
  assert.equal(report([2, 4, 6]), "n=3 sum=12 mean=4");
});
