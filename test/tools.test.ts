import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import {
  decodeToolCall,
  emptyStreak,
  llmTools,
  runLLMToolsInOrder,
  runTool,
  type ToolCall,
  type ToolSession,
} from "../src/tools/index.ts";

const provideFs = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const tempWorkspace = (): string => mkdtempSync(join(tmpdir(), "bytengu-tools-"));

const ok = (call: ToolCall, cwd: string, session?: ToolSession) =>
  provideFs(runTool(call, cwd, 5_000, session));

const errorOf = (call: ToolCall, cwd: string, session?: ToolSession) =>
  provideFs(
    runTool(call, cwd, 5_000, session).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    ),
  );

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

test("bash reports a non-zero exit as output", async () => {
  const cwd = tempWorkspace();
  try {
    const result = await ok({ name: "bash", arguments: { command: "exit 3" } }, cwd);
    assert.match(result.output, /^exit 3/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("tool calls in one message run in order, and the third identical call does not run", async () => {
  const cwd = tempWorkspace();
  try {
    const log = join(cwd, "order.txt");
    const session: ToolSession = { reads: new Set() };
    const ordered = await provideFs(
      runLLMToolsInOrder(
        [
          { id: "1", name: "bash", arguments: JSON.stringify({ command: `echo a >> '${log}' && sleep 0.3` }) },
          { id: "2", name: "bash", arguments: JSON.stringify({ command: `echo b >> '${log}'` }) },
        ],
        cwd,
        session,
        emptyStreak(),
        5_000,
      ),
    );
    assert.equal(ordered.stopped, false);
    assert.equal(readFileSync(log, "utf8"), "a\nb\n");

    const repeatLog = join(cwd, "repeat.txt");
    const command = JSON.stringify({ command: `echo x >> '${repeatLog}'` });
    const repeated = await provideFs(
      runLLMToolsInOrder(
        [
          { id: "1", name: "bash", arguments: command },
          { id: "2", name: "bash", arguments: command },
          { id: "3", name: "bash", arguments: command },
          { id: "4", name: "bash", arguments: command },
        ],
        cwd,
        session,
        emptyStreak(),
        5_000,
      ),
    );
    assert.equal(repeated.stopped, true);
    assert.equal(readFileSync(repeatLog, "utf8"), "x\nx\n");
    assert.match(repeated.results[2]?.result.ok === false ? repeated.results[2].result.error : "", /repeated 3 times/);
    assert.match(repeated.results[3]?.result.ok === false ? repeated.results[3].result.error : "", /not executed/);
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

test("tool schemas advertise edit and keep read_file's extra fields optional", async () => {
  const edit = llmTools.find((item) => item.function.name === "edit");
  assert.ok(edit);
  const parameters = edit.function.parameters as { required?: string[]; properties?: Record<string, unknown> };
  assert.deepEqual(parameters.required?.slice().sort(), ["new_string", "old_string", "path"]);
  assert.ok(parameters.properties?.replace_all);

  const decoded = await provideFs(decodeToolCall({ name: "read_file", arguments: { path: "notes.txt" } }));
  assert.equal(decoded.name, "read_file");
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
