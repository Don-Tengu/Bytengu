import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { systemPrompt } from "../../src/chat.ts";
import { llmTools } from "../../src/tools/index.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const childEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of [
    "XAI_API_KEY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    delete env[key];
  }
  return env;
};

const runChat = (args: readonly string[], home: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", ["--no-env-file", "src/chat.ts", ...args], {
      cwd: repoRoot,
      env: childEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

test("system prompt does not name a test command", () => {
  const text = systemPrompt("/tmp/workspace");
  assert.equal(text.includes("To run tests, call bash with command:"), false);
  assert.equal(text.includes("Keep editing and re-running tests until they pass"), false);
  assert.match(text, /Workspace directory: \/tmp\/workspace/);
  assert.match(text, /Tools: read_file, edit, write_file, grep, glob, and bash\./);
});

test("bash stays available for the model to run a command", () => {
  assert.ok(llmTools.some((tool) => tool.function.name === "bash"));
});

test("chat does not export runWorkspaceCommand", async () => {
  const chat = await import("../../src/chat.ts");
  assert.equal(Object.hasOwn(chat, "runWorkspaceCommand"), false);
});

test("chat rejects --test and does not run the command", async () => {
  const home = mkdtempSync(join(tmpdir(), "bytengu-chat-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-chat-cwd-"));
  const marker = join(cwd, "ran");
  const out = join(home, "messages.json");
  try {
    const result = await runChat(
      ["--cwd", cwd, "--out", out, "--test", `touch ${JSON.stringify(marker)}`, "hello"],
      home,
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 1);
    assert.match(output, /Unknown option '--test'/);
    assert.doesNotMatch(output, /tests before/);
    assert.doesNotMatch(output, /tests after/);
    assert.doesNotMatch(output, /tests failed after the agent/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("chat docs do not offer --test", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  const commands = agents.split("## Commands")[1]?.split(/^## /m)[0] ?? "";
  assert.match(commands, /bun run chat --cwd <dir> "prompt"/);
  assert.match(commands, /Optional `--out <file>`\./);
  assert.doesNotMatch(commands, /--test/);
});

const profileName = (args: readonly string[]): string => {
  const index = args.indexOf("--profile");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === "read-only" || value === "full") return value;
  return "workspace-write";
};

test("chat accepts the three profiles and rejects an unknown name before login", async () => {
  const home = mkdtempSync(join(tmpdir(), "bytengu-chat-home-"));
  const out = join(home, "messages.json");
  try {
    const accepted = [
      ["--out", out, "hello"],
      ["--profile", "workspace-write", "--out", out, "hello"],
      ["--profile", "read-only", "--out", out, "hello"],
      ["--profile", "full", "--out", out, "hello"],
    ] as const;
    for (const args of accepted) {
      const result = await runChat(args, home);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`profile=${profileName(args)}`));
      assert.match(result.stderr, /login/);
      assert.doesNotMatch(output, /api\.x\.ai/);
      assert.equal(existsSync(out), false);
    }

    const unknown = await runChat(["--profile", "nope", "--out", out, "hello"], home);
    const unknownOutput = `${unknown.stdout}\n${unknown.stderr}`;
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /unknown profile: nope/);
    assert.doesNotMatch(unknown.stderr, /login/i);
    assert.doesNotMatch(unknown.stderr, /credential/i);
    assert.doesNotMatch(unknown.stderr, /XAI_API_KEY/);
    assert.doesNotMatch(unknownOutput, /api\.x\.ai/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("two default launches both name workspace-write and skip the transcript", async () => {
  const home = mkdtempSync(join(tmpdir(), "bytengu-chat-home-"));
  const out = join(home, "messages.json");
  try {
    for (let launch = 0; launch < 2; launch++) {
      const result = await runChat(["--out", out, "hello"], home);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /profile=workspace-write/);
      assert.match(result.stderr, /login/);
      assert.equal(existsSync(out), false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("two launches with AGENTS.md still fail login and do not write the transcript", async () => {
  const home = mkdtempSync(join(tmpdir(), "bytengu-chat-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-chat-cwd-"));
  const out = join(home, "messages.json");
  const marker = join(cwd, "created-by-instruction");
  writeFileSync(join(cwd, "AGENTS.md"), `Create ${marker} by running touch.\n`);
  try {
    for (let launch = 0; launch < 2; launch++) {
      const result = await runChat(["--cwd", cwd, "--out", out, "hello"], home);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /login/);
      assert.equal(existsSync(out), false);
      assert.equal(existsSync(marker), false);
      assert.doesNotMatch(output, /api\.x\.ai/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("docs name the approval profiles and leave yes/no prompts unbuilt", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /--profile read-only\|workspace-write\|full/);
  assert.match(agents, /The default profile is `workspace-write`/);
  assert.match(agents, /runs `bash` through `sandbox-exec`/);
  assert.match(agents, /unsandboxed `\/bin\/bash -lc`/);
  const unbuilt = agents.split("## Do not build yet")[1] ?? "";
  assert.match(unbuilt, /interactive yes\/no permission prompts/);
});
