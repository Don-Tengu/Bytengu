import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLAN_MODE_INSTRUCTION } from "../../src/chat.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratch =
  process.env.BYTENGU_GOAL_SCRATCH ??
  "/var/folders/07/jzg98jx95f55080d8g0k15140000gn/T/grok-goal-091cce656311/implementer";

const FAKE_KEY = "sk-bytengu-fake-key-9f3c2a7b";
const SENTINEL = "bytengu-sentinel-9f3c2a7b";
const ORIGINAL = `${SENTINEL}\n`;
const ASSISTANT = "Change notes.txt. Check it by reading the file.";
const BASH_COMMAND = "printf 'CHANGED\\n' > notes.txt";
const REFUSAL = {
  edit: "plan mode does not allow edit",
  write_file: "plan mode does not allow write_file",
  bash: "plan mode does not allow bash",
} as const;

const childEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BYTENGU_NO_RG: "1" };
  for (const key of [
    "XAI_API_KEY",
    "BYTENGU_BASE_URL",
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

const runChat = (args: readonly string[], home: string, baseUrl: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = childEnv(home);
    env.BYTENGU_BASE_URL = baseUrl;
    const child = spawn("bun", ["--no-env-file", "src/chat.ts", ...args], {
      cwd: repoRoot,
      env,
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
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

type Scripted = { readonly status: number; readonly body: unknown };
type StoredRequest = { model?: unknown; messages?: Array<{ role?: string; content?: string | null }> };

type ServerState = {
  readonly hits: () => number;
  readonly authorization: () => string;
  readonly model: () => string;
  readonly systems: () => string[];
  readonly reset: () => void;
};

const withServer = async <A>(script: readonly Scripted[], run: (baseUrl: string, state: ServerState) => Promise<A>) => {
  let hits = 0;
  let authorization = "";
  let model = "";
  const systems: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      const path = req.url?.split("?")[0] ?? "";
      if (path !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
      let parsed: StoredRequest = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as StoredRequest;
      } catch {
        parsed = {};
      }
      model = typeof parsed.model === "string" ? parsed.model : "";
      const system = parsed.messages?.find((message) => message.role === "system")?.content;
      if (typeof system === "string") systems.push(system);
      const spec = script[hits];
      hits += 1;
      if (!spec) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected completion request" }));
        return;
      }
      const body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
      res.writeHead(spec.status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no port");
  try {
    return await run(`http://127.0.0.1:${address.port}/v1`, {
      hits: () => hits,
      authorization: () => authorization,
      model: () => model,
      systems: () => systems.slice(),
      reset: () => {
        hits = 0;
        systems.length = 0;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

const completion = (content: string | null, tools: ReturnType<typeof toolCall>[] = []): Scripted => ({
  status: 200,
  body: {
    id: "cmpl-test",
    model: "grok-4.7",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: tools.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content,
          ...(tools.length > 0 ? { tool_calls: tools } : {}),
        },
      },
    ],
  },
});

const writeAuth = (home: string) => {
  const dir = join(home, ".bytengu");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    `${JSON.stringify({ default: "xai", providers: { xai: { type: "api", key: FAKE_KEY } } }, null, 2)}\n`,
  );
};

const writeScratch = (name: string, text: string) => {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, name), text.endsWith("\n") ? text : `${text}\n`);
};

const redact = (text: string) => text.split(FAKE_KEY).join("[redacted]");

const planTools = [
  toolCall("r1", "read_file", { path: "notes.txt" }),
  toolCall("g1", "grep", { pattern: SENTINEL, path: "notes.txt" }),
  toolCall("gl1", "glob", { pattern: "*.txt" }),
  toolCall("e1", "edit", { path: "notes.txt", old_string: SENTINEL, new_string: "CHANGED" }),
  toolCall("w1", "write_file", { path: "other.txt", content: "new file" }),
  toolCall("b1", "bash", { command: BASH_COMMAND }),
];

const planScript = [completion(null, planTools), completion(ASSISTANT)];

type AuditRow = { time: string; profile: string; cwd: string; tool: string; ok: boolean; reason: string };

const auditRows = (home: string): AuditRow[] => {
  const path = join(home, ".bytengu", "audit.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRow);
};

const toolContents = (transcript: string) => {
  const messages = JSON.parse(transcript) as Array<{ role?: string; content?: string }>;
  return messages.filter((message) => message.role === "tool").map((message) => message.content ?? "");
};

const prepareWorkspace = (cwd: string, body: string) => {
  writeFileSync(join(cwd, ".git"), "");
  writeFileSync(join(cwd, "notes.txt"), body);
  rmSync(join(cwd, "other.txt"), { force: true });
};

test("plan mode reads, names a change, and leaves the workspace untouched", async () => {
  const notes: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "bytengu-plan-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-plan-cwd-"));
  const out = join(home, "messages.json");
  writeAuth(home);
  prepareWorkspace(cwd, ORIGINAL);
  const root = realpathSync(cwd);
  const args = ["--mode", "plan", "--cwd", cwd, "--out", out, "Say what to change."];
  try {
    await withServer(planScript, async (baseUrl, state) => {
      for (const label of ["1", "2", "json"] as const) {
        state.reset();
        prepareWorkspace(cwd, ORIGINAL);
        rmSync(out, { force: true });
        const launchArgs = label === "json" ? ["--format", "json", ...args] : args;
        const result = await runChat(launchArgs, home, baseUrl);
        const transcript = existsSync(out) ? readFileSync(out, "utf8") : undefined;
        const bytes = readFileSync(join(cwd, "notes.txt"), "utf8");
        const rows = auditRows(home);
        const system = state.systems()[0] ?? "";
        notes.push(
          [
            `case=plan launch=${label} code=${result.code} hits=${state.hits()} bytes=${JSON.stringify(bytes)} other=${existsSync(join(cwd, "other.txt"))}`,
            `systemHasPlan=${system.includes(PLAN_MODE_INSTRUCTION)}`,
            "system:",
            system,
            "stdout:",
            redact(result.stdout),
            "stderr:",
            redact(result.stderr),
            "audit:",
            redact(rows.map((row) => JSON.stringify(row)).join("\n")),
            "----",
          ].join("\n"),
        );

        assert.equal(result.code, 0);
        assert.equal(state.hits(), 2);
        assert.equal(state.model(), "grok-4.7");
        assert.equal(state.authorization(), `Bearer ${FAKE_KEY}`);
        assert.equal(bytes, ORIGINAL);
        assert.equal(existsSync(join(cwd, "other.txt")), false);
        assert.match(result.stderr, /profile=workspace-write/);
        assert.match(result.stderr, /mode=plan/);
        assert.match(system, /name which files to change/);
        assert.match(system, /how to check/);
        assert.match(system, /Do not modify files/);
        assert.equal(system.includes(PLAN_MODE_INSTRUCTION), true);

        assert.ok(transcript);
        const contents = toolContents(transcript);
        assert.deepEqual(
          contents.map((content) => content.includes("plan mode does not allow")),
          [false, false, false, true, true, true],
        );
        assert.equal(contents[0]?.includes(SENTINEL), true);
        assert.equal(contents[1]?.includes(SENTINEL), true);
        assert.match(contents[2] ?? "", /notes\.txt/);
        assert.equal(contents[3], REFUSAL.edit);
        assert.equal(contents[4], REFUSAL.write_file);
        assert.equal(contents[5], REFUSAL.bash);

        const fresh = rows.slice(label === "1" ? 0 : label === "2" ? 6 : 12);
        assert.deepEqual(
          fresh.map((row) => [row.tool, row.ok, row.reason, row.profile, row.cwd]),
          [
            ["read_file", true, "clean", "workspace-write", root],
            ["grep", true, "clean", "workspace-write", root],
            ["glob", true, "clean", "workspace-write", root],
            ["edit", false, "clean", "workspace-write", root],
            ["write_file", false, "clean", "workspace-write", root],
            ["bash", false, "clean", "workspace-write", root],
          ],
        );
        const auditText = fresh.map((row) => JSON.stringify(row)).join("\n");
        assert.equal(auditText.includes(SENTINEL), false);
        assert.equal(auditText.includes("old_string"), false);
        assert.equal(auditText.includes("printf"), false);
        assert.equal(auditText.includes(FAKE_KEY), false);
        assert.equal(auditText.includes("arguments"), false);
        for (const row of fresh) {
          assert.deepEqual(Object.keys(row).sort(), ["cwd", "ok", "profile", "reason", "time", "tool"]);
        }

        if (label === "json") {
          const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string; name?: string; ok?: boolean; text?: string; reason?: string; step?: number });
          assert.deepEqual(
            lines.map((line) => line.type),
            ["step", "tool", "tool", "tool", "tool", "tool", "tool", "step", "assistant", "done"],
          );
          assert.equal(lines.at(-2)?.text, ASSISTANT);
          assert.equal(lines.at(-1)?.reason, "clean");
          assert.equal(result.stdout.includes(SENTINEL), false);
          assert.equal(result.stdout.includes("printf"), false);
        } else {
          assert.equal(result.stdout, `${ASSISTANT}\n`);
        }
      }
    });
    writeScratch("plan-mode.log", notes.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("omitting --mode still edits the file", async () => {
  const notes: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "bytengu-default-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-default-cwd-"));
  const out = join(home, "messages.json");
  writeAuth(home);
  const before = "alpha\n";
  const script = [
    completion(null, [
      toolCall("r1", "read_file", { path: "notes.txt" }),
      toolCall("e1", "edit", { path: "notes.txt", old_string: "alpha", new_string: "beta" }),
    ]),
    completion("Edited notes.txt."),
  ];
  const args = ["--cwd", cwd, "--out", out, "Edit notes.txt."];
  try {
    await withServer(script, async (baseUrl, state) => {
      for (const launch of [1, 2]) {
        state.reset();
        prepareWorkspace(cwd, before);
        rmSync(out, { force: true });
        const result = await runChat(args, home, baseUrl);
        const bytes = readFileSync(join(cwd, "notes.txt"), "utf8");
        const system = state.systems()[0] ?? "";
        notes.push(
          [
            `case=default launch=${launch} code=${result.code} hits=${state.hits()} before=${JSON.stringify(before)} after=${JSON.stringify(bytes)}`,
            `systemHasPlan=${system.includes("Plan mode:")}`,
            "stdout:",
            result.stdout,
            "----",
          ].join("\n"),
        );
        assert.equal(result.code, 0);
        assert.equal(state.hits(), 2);
        assert.equal(bytes, "beta\n");
        assert.equal(result.stdout, "Edited notes.txt.\n");
        assert.equal(system.includes(PLAN_MODE_INSTRUCTION), false);
        assert.doesNotMatch(result.stderr, /mode=plan/);
        assert.match(result.stderr, /profile=workspace-write/);
        assert.equal(args.includes("--mode"), false);
      }
    });
    writeScratch("default-mode.log", notes.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("plan mode refuses bash under full, read-only still refuses, and an unknown mode exits 1", async () => {
  const notes: string[] = [];
  const nopeOut = join(scratch, "nope-transcript.json");
  rmSync(nopeOut, { force: true });
  const home = mkdtempSync(join(tmpdir(), "bytengu-mode-edge-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-mode-edge-cwd-"));
  writeAuth(home);
  prepareWorkspace(cwd, ORIGINAL);
  const fullScript = [completion(null, [toolCall("b1", "bash", { command: BASH_COMMAND })]), completion(ASSISTANT)];
  const readOnlyScript = [
    completion(null, [
      toolCall("r1", "read_file", { path: "notes.txt" }),
      toolCall("e1", "edit", { path: "notes.txt", old_string: SENTINEL, new_string: "CHANGED" }),
      toolCall("b1", "bash", { command: BASH_COMMAND }),
    ]),
    completion(ASSISTANT),
  ];
  try {
    await withServer(fullScript, async (baseUrl, state) => {
      prepareWorkspace(cwd, ORIGINAL);
      const out = join(home, "full.json");
      const result = await runChat(
        ["--mode", "plan", "--profile", "full", "--cwd", cwd, "--out", out, "Do not run bash."],
        home,
        baseUrl,
      );
      const bytes = readFileSync(join(cwd, "notes.txt"), "utf8");
      const transcript = readFileSync(out, "utf8");
      notes.push(
        [
          `case=plan-full code=${result.code} hits=${state.hits()} bytes=${JSON.stringify(bytes)}`,
          "stdout:",
          result.stdout,
          "stderr:",
          redact(result.stderr),
          "tool:",
          toolContents(transcript).join("\n"),
          "----",
        ].join("\n"),
      );
      assert.equal(result.code, 0);
      assert.equal(bytes, ORIGINAL);
      assert.equal(toolContents(transcript)[0], REFUSAL.bash);
      assert.match(result.stderr, /profile=full/);
      assert.match(result.stderr, /mode=plan/);
    });

    await withServer(readOnlyScript, async (baseUrl, state) => {
      prepareWorkspace(cwd, ORIGINAL);
      const out = join(home, "readonly.json");
      const result = await runChat(
        ["--mode", "plan", "--profile", "read-only", "--cwd", cwd, "--out", out, "Do not edit."],
        home,
        baseUrl,
      );
      const bytes = readFileSync(join(cwd, "notes.txt"), "utf8");
      const contents = toolContents(readFileSync(out, "utf8"));
      notes.push(
        [
          `case=plan-read-only code=${result.code} hits=${state.hits()} bytes=${JSON.stringify(bytes)}`,
          "tools:",
          contents.join("\n"),
          "----",
        ].join("\n"),
      );
      assert.equal(result.code, 0);
      assert.equal(bytes, ORIGINAL);
      assert.equal(contents[1], REFUSAL.edit);
      assert.equal(contents[2], REFUSAL.bash);
      assert.equal(contents.join("\n").includes("profile read-only does not allow"), false);
    });

    await withServer([], async (baseUrl, state) => {
      for (const launch of [1, 2]) {
        state.reset();
        rmSync(nopeOut, { force: true });
        const result = await runChat(
          ["--mode", "nope", "--format", "json", "--out", nopeOut, "hello"],
          home,
          baseUrl,
        );
        notes.push(
          [
            `case=unknown-mode launch=${launch} code=${result.code} hits=${state.hits()} transcript=${existsSync(nopeOut)}`,
            "stdout:",
            result.stdout,
            "stderr:",
            result.stderr,
            "----",
          ].join("\n"),
        );
        assert.equal(result.code, 1);
        assert.equal(state.hits(), 0);
        assert.equal(result.stdout, '{"type":"done","reason":"error"}\n');
        assert.match(result.stderr, /unknown mode: nope/);
        assert.equal(existsSync(nopeOut), false);
      }
    });
    writeScratch("mode-edges.log", notes.join("\n"));
  } finally {
    rmSync(nopeOut, { force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("AGENTS.md names --mode plan and the unchanged editing run", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /--mode plan/);
  assert.match(agents, /Omitting `--mode` keeps that editing run/);
  assert.match(agents, /`edit`, `write_file`, and `bash` still run/);
});
