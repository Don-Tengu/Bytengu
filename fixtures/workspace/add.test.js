import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "./add.js";

test("add(2, 3) === 5", () => {
  assert.equal(add(2, 3), 5);
});
