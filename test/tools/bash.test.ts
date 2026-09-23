import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { runTool } from "../../src/tools/index.ts";
import { ok, provideFs, tempWorkspace } from "./harness.ts";

test("bash reports a non-zero exit as output", async () => {
  const cwd = tempWorkspace();
  try {
    const result = await ok({ name: "bash", arguments: { command: "exit 3" } }, cwd);
    assert.match(result.output, /^exit 3/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash timeout is tool output, not a crash", async () => {
  const cwd = tempWorkspace();
  try {
    const result = await provideFs(runTool({ name: "bash", arguments: { command: "sleep 2" } }, cwd, 200));
    assert.match(result.output, /timed out after 200ms/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("oversized bash output keeps a preview and the full text", async () => {
  const cwd = tempWorkspace();
  try {
    const result = await ok(
      { name: "bash", arguments: { command: `node -e 'process.stdout.write("x".repeat(21000))'` } },
      cwd,
    );
    const text = result.output;
    assert.match(text, /truncated/);
    const full = /full output: ([^\s\]]+)/.exec(text)?.[1];
    assert.ok(full);
    assert.ok(readFileSync(full, "utf8").includes("x".repeat(21000)));
    rmSync(full, { force: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
