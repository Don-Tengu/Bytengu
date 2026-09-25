import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
