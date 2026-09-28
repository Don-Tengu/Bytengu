import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratch =
  process.env.BYTENGU_GOAL_SCRATCH ??
  "/var/folders/07/jzg98jx95f55080d8g0k15140000gn/T/grok-goal-da9b1f62a458/implementer";

const FAKE_KEY = "sk-bytengu-fake-key-9f3c2a7b";
const SENTINEL = "bytengu-sentinel-9f3c2a7b";
const STEP_CAP = 30;
const REPEATED = "stopped: the same tool call was repeated 3 times";

const childEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
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

const runChat = (args: readonly string[], home: string, baseUrl: string, timeoutMs = 15_000) =>
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
    }, timeoutMs);
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

type ServerState = {
  readonly hits: () => number;
  readonly authorization: () => string;
  readonly model: () => string;
  readonly reset: () => void;
};

const withServer = async <A>(script: readonly Scripted[], run: (baseUrl: string, state: ServerState) => Promise<A>) => {
  let hits = 0;
  let authorization = "";
  let model = "";
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
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
        model = typeof parsed.model === "string" ? parsed.model : "";
      } catch {
        model = "";
      }
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
      reset: () => {
        hits = 0;
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

const modelFailure: Scripted = { status: 500, body: { error: "upstream closed" } };

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

type Launch = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly hits: number;
  readonly model: string;
  readonly authorization: string;
  readonly transcript: string | undefined;
};

const workspace = () => {
  const home = mkdtempSync(join(tmpdir(), "bytengu-headless-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-headless-cwd-"));
  const out = join(home, "messages.json");
  return { home, cwd, out };
};

const runTwice = async (
  home: string,
  script: readonly Scripted[],
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<[Launch, Launch]> => {
  const launches: Launch[] = [];
  await withServer(script, async (baseUrl, state) => {
    for (let launch = 0; launch < 2; launch++) {
      state.reset();
      const outFlag = args[args.indexOf("--out") + 1];
      if (outFlag) rmSync(outFlag, { force: true });
      const result = await runChat(args, home, baseUrl, timeoutMs);
      const transcript = outFlag && existsSync(outFlag) ? readFileSync(outFlag, "utf8") : undefined;
      launches.push({
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        hits: state.hits(),
        model: state.model(),
        authorization: state.authorization(),
        transcript,
      });
    }
  });
  const first = launches[0];
  const second = launches[1];
  if (!first || !second) throw new Error("expected two launches");
  return [first, second];
};

const assertStable = (launches: readonly Launch[], code: number, hits: number, transcript: boolean) => {
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.code, code);
    assert.equal(launch.hits, hits);
    assert.equal(launch.transcript !== undefined, transcript);
    assert.equal(launch.stdout.includes(FAKE_KEY), false);
    assert.equal(launch.stderr.includes(FAKE_KEY), false);
    assert.equal(launch.stdout.includes("api.x.ai"), false);
    assert.equal(launch.stderr.includes("api.x.ai"), false);
    if (hits > 0) {
      assert.equal(launch.model, "grok-4.7");
      assert.equal(launch.authorization, `Bearer ${FAKE_KEY}`);
    }
  }
  assert.equal(launches[0]?.code, launches[1]?.code);
};

const noteLaunch = (label: string, launch: number, item: Launch): string =>
  [
    `case=${label} launch=${launch} code=${item.code} hits=${item.hits} transcript=${item.transcript !== undefined} model=${item.model || "-"} authMatched=${item.hits === 0 ? "n/a" : item.authorization === `Bearer ${FAKE_KEY}`}`,
    "stdout:",
    redact(item.stdout),
    "stderr:",
    redact(item.stderr),
    "transcript:",
    item.transcript === undefined ? "(absent)" : redact(item.transcript),
    "----",
  ].join("\n");

const messagesOf = (transcript: string | undefined) => {
  assert.ok(transcript);
  const parsed = JSON.parse(transcript) as Array<{ role?: string; content?: string }>;
  assert.ok(Array.isArray(parsed));
  return parsed;
};

const readCall = (id: string, path: string) => toolCall(id, "read_file", { path });

test("headless exit codes are stable and the transcript follows the stop", async () => {
  const notes: string[] = [];
  const { home, cwd, out } = workspace();
  writeFileSync(join(cwd, "notes.txt"), `${SENTINEL}\n`);
  writeAuth(home);
  try {
    const clean = await runTwice(home, [completion("All done.")], ["--cwd", cwd, "--out", out, "hello"]);
    assertStable(clean, 0, 1, true);
    for (const launch of clean) {
      const messages = messagesOf(launch.transcript);
      assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
      assert.equal(messages.some((message) => message.role === "tool"), false);
      assert.equal(launch.stdout, "All done.\n");
    }
    notes.push(noteLaunch("clean", 1, clean[0]), noteLaunch("clean", 2, clean[1]));

    const failedTool = await runTwice(
      home,
      [completion(null, [readCall("c1", "missing.txt")]), completion("Recovered.")],
      ["--cwd", cwd, "--out", out, "hello"],
    );
    assertStable(failedTool, 0, 2, true);
    for (const launch of failedTool) {
      const messages = messagesOf(launch.transcript);
      const tools = messages.filter((message) => message.role === "tool");
      assert.equal(tools.length, 1);
      assert.match(tools[0]?.content ?? "", /File not found/);
      assert.equal(launch.stdout, "Recovered.\n");
    }
    notes.push(noteLaunch("tool-failure-then-clean", 1, failedTool[0]), noteLaunch("tool-failure-then-clean", 2, failedTool[1]));

    const repeated = await runTwice(
      home,
      [completion("Stopped here.", [readCall("c1", "notes.txt"), readCall("c2", "notes.txt"), readCall("c3", "notes.txt")])],
      ["--cwd", cwd, "--out", out, "hello"],
    );
    assertStable(repeated, 3, 1, true);
    assert.notEqual(repeated[0]?.code, 0);
    assert.notEqual(repeated[0]?.code, 1);
    assert.notEqual(repeated[0]?.code, 2);
    for (const launch of repeated) {
      const tools = messagesOf(launch.transcript).filter((message) => message.role === "tool");
      assert.equal(tools.length, 3);
      assert.match(tools[0]?.content ?? "", new RegExp(SENTINEL));
      assert.match(tools[1]?.content ?? "", new RegExp(SENTINEL));
      assert.equal(tools[2]?.content, REPEATED);
      assert.equal(tools[2]?.content.includes(SENTINEL), false);
      assert.equal(launch.stdout, "Stopped here.\n");
      assert.equal(launch.stdout.includes(SENTINEL), false);
      assert.equal(launch.stderr.includes(SENTINEL), false);
    }
    notes.push(noteLaunch("repeated-tool", 1, repeated[0]), noteLaunch("repeated-tool", 2, repeated[1]));

    const stepScript = Array.from({ length: STEP_CAP }, (_, index) =>
      completion(null, [readCall(`call-${index}`, `missing-${index}.txt`)]),
    );
    const capped = await runTwice(home, stepScript, ["--cwd", cwd, "--out", out, "hello"], 20_000);
    assertStable(capped, 2, STEP_CAP, true);
    assert.notEqual(capped[0]?.code, 0);
    assert.notEqual(capped[0]?.code, 1);
    assert.notEqual(capped[0]?.code, 3);
    for (const launch of capped) {
      const messages = messagesOf(launch.transcript);
      assert.equal(messages.filter((message) => message.role === "assistant").length, STEP_CAP);
      assert.equal(messages.filter((message) => message.role === "tool").length, STEP_CAP);
    }
    notes.push(noteLaunch("step-cap", 1, capped[0]), noteLaunch("step-cap", 2, capped[1]));

    const afterTurn = await runTwice(
      home,
      [completion("partial", [readCall("c1", "notes.txt")]), modelFailure],
      ["--cwd", cwd, "--out", out, "hello"],
    );
    assertStable(afterTurn, 1, 2, true);
    for (const launch of afterTurn) {
      const messages = messagesOf(launch.transcript);
      assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
      assert.equal(messages.some((message) => message.role === "tool"), true);
      assert.match(launch.stderr, /LLM request failed: 500/);
      assert.equal(launch.stdout.includes(SENTINEL), false);
      assert.equal(launch.stderr.includes(SENTINEL), false);
    }
    notes.push(noteLaunch("model-failure-after-turn", 1, afterTurn[0]), noteLaunch("model-failure-after-turn", 2, afterTurn[1]));

    const missingDir = join(home, "missing-workspace");
    const notDir = join(home, "not-a-directory");
    writeFileSync(notDir, "x");
    const preloop: Array<{ label: string; args: readonly string[]; stderr: RegExp; auth: boolean }> = [
      { label: "missing-workspace", args: ["--cwd", missingDir, "--out", out, "hello"], stderr: /workspace does not exist/, auth: true },
      { label: "workspace-not-directory", args: ["--cwd", notDir, "--out", out, "hello"], stderr: /workspace is not a directory/, auth: true },
      { label: "unknown-profile", args: ["--profile", "nope", "--out", out, "hello"], stderr: /unknown profile: nope/, auth: false },
      { label: "unknown-format", args: ["--format", "nope", "--out", out, "hello"], stderr: /unknown format: nope/, auth: false },
      { label: "empty-prompt", args: ["--cwd", cwd, "--out", out], stderr: /expected a non-empty prompt/, auth: true },
      { label: "missing-auth", args: ["--cwd", cwd, "--out", out, "hello"], stderr: /login/, auth: false },
    ];
    for (const item of preloop) {
      if (item.auth) writeAuth(home);
      else rmSync(join(home, ".bytengu", "auth.json"), { force: true });
      const launches = await runTwice(home, [], item.args);
      assertStable(launches, 1, 0, false);
      for (const launch of launches) {
        assert.match(launch.stderr, item.stderr);
        assert.equal(launch.stdout, "");
      }
      notes.push(noteLaunch(item.label, 1, launches[0]), noteLaunch(item.label, 2, launches[1]));
    }
  } finally {
    writeScratch("exit-codes.log", notes.join("\n"));
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

type HeadlessEvent = { type?: string; step?: number; name?: string; ok?: boolean; text?: string; reason?: string };

const eventsOf = (stdout: string): HeadlessEvent[] =>
  stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      assert.equal(typeof parsed, "object");
      assert.ok(parsed !== null);
      assert.equal(Array.isArray(parsed), false);
      return parsed as HeadlessEvent;
    });

test("json stdout is one event per line and human stdout stays the assistant text", async () => {
  const notes: string[] = [];
  const { home, cwd, out } = workspace();
  writeFileSync(join(cwd, "notes.txt"), `${SENTINEL}\n`);
  writeAuth(home);
  try {
    const cleanScript = [
      completion(null, [readCall("c1", "notes.txt"), readCall("c2", "missing.txt")]),
      completion("All done."),
    ];
    const humanClean = await runTwice(home, cleanScript, ["--cwd", cwd, "--out", out, "hello"]);
    assertStable(humanClean, 0, 2, true);
    const jsonClean = await runTwice(home, cleanScript, ["--format", "json", "--cwd", cwd, "--out", out, "hello"]);
    assertStable(jsonClean, 0, 2, true);
    const expectedClean: HeadlessEvent[] = [
      { type: "step", step: 1 },
      { type: "tool", name: "read_file", ok: true },
      { type: "tool", name: "read_file", ok: false },
      { type: "step", step: 2 },
      { type: "assistant", text: "All done." },
      { type: "done", reason: "clean" },
    ];
    for (const launch of humanClean) {
      assert.equal(launch.stdout, "All done.\n");
      assert.equal(launch.stdout.split("\n").filter((line) => line.length > 0).length, 1);
      assert.throws(() => JSON.parse(launch.stdout));
      assert.equal(launch.stdout.includes(SENTINEL), false);
      assert.equal(launch.stderr.includes(SENTINEL), false);
      assert.match(messagesOf(launch.transcript).map((message) => message.content).join("\n"), new RegExp(SENTINEL));
    }
    for (const launch of jsonClean) {
      assert.deepEqual(eventsOf(launch.stdout), expectedClean);
      assert.equal(launch.stdout.includes(SENTINEL), false);
      assert.equal(launch.stderr.includes(SENTINEL), false);
      assert.match(messagesOf(launch.transcript).map((message) => message.content).join("\n"), new RegExp(SENTINEL));
      const events = eventsOf(launch.stdout);
      const lastTool = events.findLastIndex((event) => event.type === "tool");
      const assistant = events.findIndex((event) => event.type === "assistant");
      assert.ok(lastTool > events.findIndex((event) => event.type === "step"));
      assert.ok(assistant > lastTool);
      assert.equal(events.at(-1)?.type, "done");
      assert.equal(events.at(-1)?.reason, "clean");
    }
    assert.deepEqual(eventsOf(jsonClean[0]?.stdout ?? ""), eventsOf(jsonClean[1]?.stdout ?? ""));
    notes.push(
      noteLaunch("human-clean", 1, humanClean[0]),
      noteLaunch("human-clean", 2, humanClean[1]),
      noteLaunch("json-clean", 1, jsonClean[0]),
      noteLaunch("json-clean", 2, jsonClean[1]),
    );

    const doomScript = [
      completion("Stopped here.", [readCall("c1", "notes.txt"), readCall("c2", "notes.txt"), readCall("c3", "notes.txt")]),
    ];
    const humanDoom = await runTwice(home, doomScript, ["--cwd", cwd, "--out", out, "hello"]);
    assertStable(humanDoom, 3, 1, true);
    const jsonDoom = await runTwice(home, doomScript, ["--format", "json", "--cwd", cwd, "--out", out, "hello"]);
    assertStable(jsonDoom, 3, 1, true);
    const expectedDoom: HeadlessEvent[] = [
      { type: "step", step: 1 },
      { type: "tool", name: "read_file", ok: true },
      { type: "tool", name: "read_file", ok: true },
      { type: "tool", name: "read_file", ok: false },
      { type: "assistant", text: "Stopped here." },
      { type: "done", reason: "repeated-tool" },
    ];
    for (const launch of humanDoom) {
      assert.equal(launch.stdout, "Stopped here.\n");
      assert.throws(() => JSON.parse(launch.stdout));
      assert.equal(launch.stdout.includes(SENTINEL), false);
      assert.equal(launch.stderr.includes(SENTINEL), false);
    }
    for (const launch of jsonDoom) {
      assert.deepEqual(eventsOf(launch.stdout), expectedDoom);
      assert.equal(launch.stdout.includes(SENTINEL), false);
      assert.equal(launch.stderr.includes(SENTINEL), false);
      assert.equal(launch.code, jsonDoom[0]?.code);
      assert.equal(eventsOf(launch.stdout).at(-1)?.reason, "repeated-tool");
    }
    notes.push(
      noteLaunch("human-repeated", 1, humanDoom[0]),
      noteLaunch("human-repeated", 2, humanDoom[1]),
      noteLaunch("json-repeated", 1, jsonDoom[0]),
      noteLaunch("json-repeated", 2, jsonDoom[1]),
    );

    const noStep = await runTwice(home, [], ["--format", "json", "--profile", "nope", "--out", out, "hello"]);
    assertStable(noStep, 1, 0, false);
    for (const launch of noStep) {
      assert.deepEqual(eventsOf(launch.stdout), [{ type: "done", reason: "error" }]);
      assert.equal(launch.stdout, `${JSON.stringify({ type: "done", reason: "error" })}\n`);
      assert.match(launch.stderr, /unknown profile: nope/);
      assert.doesNotMatch(launch.stderr, /profile=/);
      assert.equal(launch.stdout.includes(FAKE_KEY), false);
    }
    notes.push(noteLaunch("json-no-step", 1, noStep[0]), noteLaunch("json-no-step", 2, noStep[1]));
  } finally {
    writeScratch("json-events.log", notes.join("\n"));
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("audit log appends one line per tool call and skips a run with no tools", async () => {
  const { home, cwd, out } = workspace();
  writeFileSync(join(cwd, "notes.txt"), `${SENTINEL}\n`);
  writeAuth(home);
  const audit = join(home, ".bytengu", "audit.log");
  const authPath = join(home, ".bytengu", "auth.json");
  const authBefore = readFileSync(authPath, "utf8");
  const root = realpathSync(cwd);
  try {
    const once = async (script: readonly Scripted[], args: readonly string[]) => {
      let launch: Launch | undefined;
      await withServer(script, async (baseUrl, state) => {
        rmSync(out, { force: true });
        const result = await runChat(args, home, baseUrl);
        launch = {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          hits: state.hits(),
          model: state.model(),
          authorization: state.authorization(),
          transcript: existsSync(out) ? readFileSync(out, "utf8") : undefined,
        };
      });
      if (!launch) throw new Error("missing launch");
      return launch;
    };

    const successAndFailure = await once(
      [completion(null, [readCall("c1", "notes.txt"), readCall("c2", "missing.txt")]), completion("Noted.")],
      ["--profile", "read-only", "--cwd", cwd, "--out", out, "hello"],
    );
    assert.equal(successAndFailure.code, 0);
    assert.equal(successAndFailure.stdout.includes(SENTINEL), false);
    assert.equal(successAndFailure.stderr.includes(SENTINEL), false);
    const afterFirst = readFileSync(audit, "utf8");

    const repeated = await once(
      [completion("Stopped here.", [readCall("c1", "notes.txt"), readCall("c2", "notes.txt"), readCall("c3", "notes.txt")])],
      ["--format", "json", "--profile", "workspace-write", "--cwd", cwd, "--out", out, "hello"],
    );
    assert.equal(repeated.code, 3);
    assert.equal(eventsOf(repeated.stdout).at(-1)?.reason, "repeated-tool");
    assert.equal(repeated.stdout.includes(SENTINEL), false);
    const tools = messagesOf(repeated.transcript).filter((message) => message.role === "tool");
    assert.equal(tools[2]?.content, REPEATED);
    const afterSecond = readFileSync(audit, "utf8");
    assert.ok(afterSecond.startsWith(afterFirst));
    assert.notEqual(afterSecond, afterFirst);

    const quiet = await once([completion("Quiet.")], ["--cwd", cwd, "--out", out, "hello"]);
    assert.equal(quiet.code, 0);
    assert.equal(readFileSync(audit, "utf8"), afterSecond);

    const names = readdirSync(join(home, ".bytengu")).sort();
    assert.deepEqual(names, ["audit.log", "auth.json"]);
    assert.equal(statSync(audit).mode & 0o777, 0o600);
    assert.equal(readFileSync(authPath, "utf8"), authBefore);
    assert.equal(authBefore.includes(FAKE_KEY), true);
    assert.equal(afterSecond.includes(FAKE_KEY), false);
    assert.equal(afterSecond.includes(SENTINEL), false);
    assert.equal(afterSecond.includes("notes.txt"), false);
    assert.equal(afterSecond.includes("arguments"), false);

    const rows = afterSecond
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { time: string; profile: string; cwd: string; tool: string; ok: boolean; reason: string });
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["cwd", "ok", "profile", "reason", "time", "tool"]);
      assert.equal(Number.isNaN(Date.parse(row.time)), false);
      assert.equal(row.cwd, root);
      assert.equal(row.tool, "read_file");
    }
    assert.deepEqual(
      rows.map((row) => [row.profile, row.ok, row.reason]),
      [
        ["read-only", true, "clean"],
        ["read-only", false, "clean"],
        ["workspace-write", true, "repeated-tool"],
        ["workspace-write", true, "repeated-tool"],
        ["workspace-write", false, "repeated-tool"],
      ],
    );
    assert.equal(rows[4]?.ok, false);
    assert.equal(rows[4]?.reason, "repeated-tool");

    writeScratch("audit.log", `mode=${(statSync(audit).mode & 0o777).toString(8)}\n${afterSecond}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("agents docs state the format switch, exit table, and audit path", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /--format human\|json/);
  assert.match(agents, /The default format is `human`/);
  assert.match(agents, /stdout is the final assistant text/);
  assert.match(agents, /`~\/\.bytengu\/audit\.log`/);
  assert.match(agents, /`0600`/);
  assert.match(agents, /`0` — clean stop/);
  assert.match(agents, /`1` — startup or model error/);
  assert.match(agents, /`2` — the loop reached the 30-step cap/);
  assert.match(agents, /`3` — the same tool name and arguments was repeated 3 times/);
  assert.match(agents, /done\.reason/);
});
