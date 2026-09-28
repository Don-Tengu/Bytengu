import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { systemMessage, systemPrompt } from "../../src/chat.ts";
import { INSTRUCTION_CAP } from "../../src/instructions.ts";

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const tools = /Tools: read_file, edit, write_file, grep, glob, and bash\./;

test("nearest AGENTS.md comes before ancestors and a bare workspace stays fixed", async () => {
  const root = tempDir("bytengu-agents-");
  const child = join(root, "pkg");
  mkdirSync(child);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "AGENTS.md"), "PARENT-AGENTS\n");
  writeFileSync(join(child, "AGENTS.md"), "CHILD-AGENTS\n");
  const bare = tempDir("bytengu-agents-bare-");
  try {
    const message = await run(systemMessage(child));
    assert.ok(message.indexOf("CHILD-AGENTS") < message.indexOf("PARENT-AGENTS"));
    assert.match(message, /CHILD-AGENTS/);
    assert.match(message, /PARENT-AGENTS/);
    assert.match(message, tools);
    assert.match(message, /Workspace directory:/);

    const empty = await run(systemMessage(bare));
    assert.equal(empty, systemPrompt(bare));
    assert.match(empty, tools);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("CLAUDE.md is used only when that directory has no AGENTS.md file", async () => {
  const claudeOnly = tempDir("bytengu-claude-");
  const both = tempDir("bytengu-both-");
  writeFileSync(join(claudeOnly, "CLAUDE.md"), "CLAUDE-ONLY\n");
  writeFileSync(join(both, "AGENTS.md"), "AGENTS-WINS\n");
  writeFileSync(join(both, "CLAUDE.md"), "CLAUDE-LOSES\n");
  try {
    const only = await run(systemMessage(claudeOnly));
    assert.match(only, /CLAUDE-ONLY/);
    assert.match(only, tools);

    const mixed = await run(systemMessage(both));
    assert.match(mixed, /AGENTS-WINS/);
    assert.doesNotMatch(mixed, /CLAUDE-LOSES/);
  } finally {
    rmSync(claudeOnly, { recursive: true, force: true });
    rmSync(both, { recursive: true, force: true });
  }
});

test("instructions stop at the git root, ignore a non-file, and keep the start of a long file", async () => {
  assert.equal(INSTRUCTION_CAP, 32_000);
  const above = tempDir("bytengu-above-");
  const repo = join(above, "repo");
  const workspace = join(repo, "pkg");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(above, "AGENTS.md"), "ABOVE-ROOT\n");
  writeFileSync(join(repo, "AGENTS.md"), "AT-ROOT\n");
  writeFileSync(join(workspace, "AGENTS.md"), "IN-WORKSPACE\n");

  const unrootedParent = tempDir("bytengu-unrooted-");
  const unrooted = join(unrootedParent, "work");
  mkdirSync(unrooted);
  writeFileSync(join(unrootedParent, "AGENTS.md"), "PARENT-OUTSIDE\n");

  const directoryName = tempDir("bytengu-dir-agents-");
  mkdirSync(join(directoryName, "AGENTS.md"));
  writeFileSync(join(directoryName, "AGENTS.md", "secret.txt"), "DIR-SECRET\n");

  const hugeDir = tempDir("bytengu-huge-");
  const head = "START-SENTINEL";
  const mid = "MID-SENTINEL";
  const tail = "END-SENTINEL";
  const pad = INSTRUCTION_CAP - head.length - mid.length;
  writeFileSync(join(hugeDir, "AGENTS.md"), `${head}${"y".repeat(pad)}${mid}${tail}`);
  try {
    const bounded = await run(systemMessage(workspace));
    assert.match(bounded, /IN-WORKSPACE/);
    assert.match(bounded, /AT-ROOT/);
    assert.ok(bounded.indexOf("IN-WORKSPACE") < bounded.indexOf("AT-ROOT"));
    assert.doesNotMatch(bounded, /ABOVE-ROOT/);

    const noGit = await run(systemMessage(unrooted));
    assert.doesNotMatch(noGit, /PARENT-OUTSIDE/);
    assert.match(noGit, tools);

    const ignored = await run(systemMessage(directoryName));
    assert.doesNotMatch(ignored, /DIR-SECRET/);
    assert.equal(ignored, systemPrompt(directoryName));

    const capped = await run(systemMessage(hugeDir));
    assert.match(capped, /START-SENTINEL/);
    assert.match(capped, /MID-SENTINEL/);
    assert.doesNotMatch(capped, /END-SENTINEL/);
    assert.match(capped, tools);
  } finally {
    rmSync(above, { recursive: true, force: true });
    rmSync(unrootedParent, { recursive: true, force: true });
    rmSync(directoryName, { recursive: true, force: true });
    rmSync(hugeDir, { recursive: true, force: true });
  }
});

test("a .git file stops the walk the same way a .git directory does", async () => {
  const above = tempDir("bytengu-gitfile-");
  const repo = join(above, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, ".git"), "gitdir: /unused\n");
  writeFileSync(join(above, "AGENTS.md"), "ABOVE-FILE-GIT\n");
  writeFileSync(join(repo, "AGENTS.md"), "AT-FILE-GIT\n");
  try {
    const message = await run(systemMessage(repo));
    assert.match(message, /AT-FILE-GIT/);
    assert.doesNotMatch(message, /ABOVE-FILE-GIT/);
  } finally {
    rmSync(above, { recursive: true, force: true });
  }
});

test("reading AGENTS.md does not run commands written in the file", async () => {
  const cwd = tempDir("bytengu-noexec-");
  const marker = join(cwd, "created-by-instruction");
  writeFileSync(
    join(cwd, "AGENTS.md"),
    `Create ${marker} now. Run: touch ${JSON.stringify(marker)}\n`,
  );
  try {
    const message = await run(systemMessage(cwd));
    assert.match(message, /Create /);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
