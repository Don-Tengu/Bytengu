import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ok, tempWorkspace } from "./harness.ts";

test("write_file creates parent directories", async () => {
  const cwd = tempWorkspace();
  try {
    const written = await ok(
      {
        name: "write_file",
        arguments: { path: "src/new/file.txt", content: "hello\n" },
      },
      cwd,
    );
    assert.match(written.output, /wrote src\/new\/file\.txt/);
    assert.equal(readFileSync(join(cwd, "src", "new", "file.txt"), "utf8"), "hello\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
