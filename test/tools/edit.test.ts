import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { ToolSession } from "../../src/tools/index.ts";
import { errorOf, ok, provideFs, tempWorkspace } from "./harness.ts";

test("edit requires a prior read, replaces one match, and leaves the file alone on failure", async () => {
  const cwd = tempWorkspace();
  const session: ToolSession = { reads: new Set() };
  const file = join(cwd, "sum.js");
  writeFileSync(file, "export function sum(nums) {\n  return nums.length - 1;\n}\n");
  try {
    const unread = await errorOf(
      {
        name: "edit",
        arguments: { path: "sum.js", old_string: "nums.length - 1", new_string: "nums.length" },
      },
      cwd,
      session,
    );
    assert.match(unread, /read_file on sum\.js/);
    assert.match(readFileSync(file, "utf8"), /length - 1/);

    await ok({ name: "read_file", arguments: { path: "sum.js" } }, cwd, session);

    const ambiguous = await errorOf(
      {
        name: "edit",
        arguments: { path: "sum.js", old_string: "n", new_string: "x" },
      },
      cwd,
      session,
    );
    assert.match(ambiguous, /multiple matches/);
    assert.match(readFileSync(file, "utf8"), /function sum/);

    const missing = await errorOf(
      {
        name: "edit",
        arguments: { path: "sum.js", old_string: "nope", new_string: "y" },
      },
      cwd,
      session,
    );
    assert.match(missing, /Could not find old_string/);

    const same = await errorOf(
      {
        name: "edit",
        arguments: { path: "sum.js", old_string: "nums", new_string: "nums" },
      },
      cwd,
      session,
    );
    assert.match(same, /identical/);

    const empty = await errorOf(
      {
        name: "edit",
        arguments: { path: "sum.js", old_string: "", new_string: "x" },
      },
      cwd,
      session,
    );
    assert.match(empty, /cannot be empty/);

    const edited = await ok(
      {
        name: "edit",
        arguments: {
          path: "./sum.js",
          old_string: "  return nums.length - 1;\n",
          new_string: "  return nums.length;\n",
        },
      },
      cwd,
      session,
    );
    assert.match(edited.output, /^- {2}return nums\.length - 1;/m);
    assert.match(edited.output, /^\+ {2}return nums\.length;/m);
    assert.equal(readFileSync(file, "utf8"), "export function sum(nums) {\n  return nums.length;\n}\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("edit replace_all changes every match, and a missing file is not created", async () => {
  const cwd = tempWorkspace();
  try {
    writeFileSync(join(cwd, "names.txt"), "a a\n");
    const replaced = await ok(
      {
        name: "edit",
        arguments: { path: "names.txt", old_string: "a", new_string: "b", replace_all: true },
      },
      cwd,
    );
    assert.match(replaced.output, /edited names\.txt/);
    assert.equal(readFileSync(join(cwd, "names.txt"), "utf8"), "b b\n");

    const created = await errorOf(
      {
        name: "edit",
        arguments: { path: "missing.txt", old_string: "a", new_string: "b" },
      },
      cwd,
    );
    assert.match(created, /File not found: missing\.txt/);
    assert.equal(
      await provideFs(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(join(cwd, "missing.txt"));
        }),
      ),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
