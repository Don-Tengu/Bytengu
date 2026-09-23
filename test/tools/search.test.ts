import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { errorOf, ok, tempWorkspace } from "./harness.ts";

test("glob paths stay relative when the workspace path is a symlink", async () => {
  const real = tempWorkspace();
  const linkParent = tempWorkspace();
  const link = join(linkParent, "work");
  try {
    writeFileSync(join(real, "a.txt"), "hello\n");
    symlinkSync(real, link);
    const listed = await ok({ name: "glob", arguments: { pattern: "*.txt" } }, link);
    assert.equal(listed.output.trim(), "a.txt");
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test("grep and glob stay inside the workspace", async () => {
  const cwd = tempWorkspace();
  const outside = tempWorkspace();
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "sum.js"), "export function sum(nums) {\n  return nums;\n}\n");
    writeFileSync(join(cwd, "src", "sum.test.js"), "test('sum')\n");
    writeFileSync(join(outside, "secret.txt"), "export function sum(secret)\n");
    symlinkSync(join(outside, "secret.txt"), join(cwd, "src", "leak.js"));

    const grep = await ok({ name: "grep", arguments: { pattern: "function sum", path: "src" } }, cwd);
    const grepText = grep.output;
    assert.match(grepText, /src\/sum\.js:1:export function sum/);
    assert.doesNotMatch(grepText, /secret|leak/);

    const glob = await ok({ name: "glob", arguments: { pattern: "**/*.js" } }, cwd);
    const globText = glob.output;
    assert.match(globText, /src\/sum\.js/);
    assert.match(globText, /src\/sum\.test\.js/);
    assert.doesNotMatch(globText, /secret/);

    const escaped = await errorOf({ name: "grep", arguments: { pattern: "sum", path: ".." } }, cwd);
    assert.match(escaped, /path escapes workspace/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("grep falls back to a workspace walk when ripgrep is disabled", async () => {
  const cwd = tempWorkspace();
  const previous = process.env.BYTENGU_NO_RG;
  process.env.BYTENGU_NO_RG = "1";
  try {
    writeFileSync(join(cwd, "only.txt"), "needle\n");
    const found = await ok({ name: "grep", arguments: { pattern: "needle" } }, cwd);
    assert.match(found.output, /only\.txt:1:needle/);
    const oneFile = await ok({ name: "grep", arguments: { pattern: "needle", path: "only.txt" } }, cwd);
    assert.match(oneFile.output, /only\.txt:1:needle/);
    const files = await ok({ name: "glob", arguments: { pattern: "*.txt" } }, cwd);
    assert.match(files.output, /only\.txt/);
  } finally {
    if (previous === undefined) delete process.env.BYTENGU_NO_RG;
    else process.env.BYTENGU_NO_RG = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
