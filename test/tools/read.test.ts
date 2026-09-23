import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { errorOf, ok, tempWorkspace } from "./harness.ts";

test("read_file pages by line and refuses a path outside the workspace", async () => {
  const cwd = tempWorkspace();
  try {
    writeFileSync(join(cwd, "notes.txt"), ["one", "two", "three", "four"].join("\n"));
    const text = (
      await ok({ name: "read_file", arguments: { path: "notes.txt", offset: 2, limit: 2 } }, cwd)
    ).output;
    assert.match(text, /notes\.txt lines 2-3 of 4/);
    assert.match(text, /2\| two/);
    assert.match(text, /3\| three/);
    assert.doesNotMatch(text, /one/);
    assert.match(text, /Pass offset 4 to continue/);

    writeFileSync(join(cwd, "empty.txt"), "");
    const empty = (await ok({ name: "read_file", arguments: { path: "empty.txt" } }, cwd)).output;
    assert.match(empty, /empty\.txt lines 0-0 of 0/);

    const escaped = await errorOf({ name: "read_file", arguments: { path: "../secret.txt" } }, cwd);
    assert.match(escaped, /path escapes workspace/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("read_file lists one directory level, directories first", async () => {
  const cwd = tempWorkspace();
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "a.txt"), "a");
    writeFileSync(join(cwd, "src", "b.txt"), "b");
    const text = (await ok({ name: "read_file", arguments: { path: "." } }, cwd)).output;
    assert.match(text, /directory, entries 1-2 of 2/);
    assert.match(text, /dir src\nfile a\.txt/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("read_file does not follow a symlink out of the workspace", async () => {
  const cwd = tempWorkspace();
  const outside = tempWorkspace();
  try {
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    symlinkSync(join(outside, "secret.txt"), join(cwd, "leak.txt"));
    symlinkSync(outside, join(cwd, "outside-dir"));
    const error = await errorOf({ name: "read_file", arguments: { path: "leak.txt" } }, cwd);
    assert.match(error, /path escapes workspace/);
    const throughDir = await errorOf(
      { name: "write_file", arguments: { path: "outside-dir/planted.txt", content: "nope\n" } },
      cwd,
    );
    assert.match(throughDir, /path escapes workspace/);
    assert.equal(existsSync(join(outside, "planted.txt")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
