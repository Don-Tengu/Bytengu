import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { runWorkspaceCommand } from "../src/chat.ts";

test("runWorkspaceCommand returns the shell exit code", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-check-"));
  try {
    const code = await Effect.runPromise(runWorkspaceCommand("exit 3", cwd));
    assert.equal(code, 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
