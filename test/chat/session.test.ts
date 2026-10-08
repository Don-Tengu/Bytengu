import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratch =
  process.env.BYTENGU_GOAL_SCRATCH ??
  "/var/folders/07/jzg98jx95f55080d8g0k15140000gn/T/grok-goal-2f16605ce8a5/implementer";

const FAKE_KEY = "sk-bytengu-fake-key-9f3c2a7b";
const SENTINEL = "session-sentinel-4c8e1a";
const FIRST_PROMPT = "Read notes.txt and tell me the sentinel.";
const FIRST_ANSWER = "The file has the sentinel.";
const SECOND_PROMPT = "What did that file say?";
const SECOND_ANSWER = "Continuing from the sentinel.";
const FRESH_PROMPT = "Start over from nothing.";
const FRESH_ANSWER = "Starting blank.";
const OTHER_PROMPT = "Continue in the other folder.";
const OTHER_ANSWER = "Other folder, new talk.";
const EMPTY_PROMPT = "Brand new continue.";
const EMPTY_ANSWER = "No earlier session.";

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

type Posted = {
  role?: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { name?: string } }>;
};

type ServerState = {
  readonly hits: () => number;
  readonly requests: () => Posted[][];
  readonly reset: () => void;
};

const withServer = async <A>(script: readonly Scripted[], run: (baseUrl: string, state: ServerState) => Promise<A>) => {
  let hits = 0;
  const requests: Posted[][] = [];
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
      let messages: Posted[] = [];
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Posted[] };
        messages = parsed.messages ?? [];
      } catch {
        messages = [];
      }
      requests.push(messages);
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
      requests: () => requests.map((messages) => messages.slice()),
      reset: () => {
        hits = 0;
        requests.length = 0;
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

const findFrom = (messages: readonly Posted[], from: number, pred: (message: Posted) => boolean): number => {
  for (let index = from; index < messages.length; index++) {
    const message = messages[index];
    if (message && pred(message)) return index;
  }
  return -1;
};

const userContents = (messages: readonly Posted[]) =>
  messages.filter((message) => message.role === "user").map((message) => message.content);

const readThenAnswer = [completion(null, [toolCall("r1", "read_file", { path: "notes.txt" })]), completion(FIRST_ANSWER)];

test("continue posts the stored conversation after the transcript file is gone", async () => {
  const notes: string[] = [];
  try {
    for (const round of [1, 2]) {
      const home = mkdtempSync(join(tmpdir(), "bytengu-session-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "bytengu-session-cwd-"));
      const out1 = join(home, "first.json");
      const out2 = join(home, "second.json");
      writeAuth(home);
      writeFileSync(join(cwd, "notes.txt"), `${SENTINEL}\n`);
      try {
        await withServer([...readThenAnswer, completion(SECOND_ANSWER)], async (baseUrl, state) => {
          const first = await runChat(["--cwd", cwd, "--out", out1, FIRST_PROMPT], home, baseUrl);
          rmSync(out1, { force: true });
          const second = await runChat(
            ["--continue", "--cwd", cwd, "--out", out2, SECOND_PROMPT],
            home,
            baseUrl,
          );
          const posted = state.requests();
          const continued = posted[2] ?? [];
          const user1 = findFrom(continued, 0, (message) => message.role === "user" && message.content === FIRST_PROMPT);
          const call = findFrom(
            continued,
            user1 + 1,
            (message) =>
              message.role === "assistant" &&
              (message.tool_calls ?? []).some((tool) => tool.function?.name === "read_file"),
          );
          const tool = findFrom(
            continued,
            call + 1,
            (message) => message.role === "tool" && (message.content ?? "").includes(SENTINEL),
          );
          const answer = findFrom(
            continued,
            tool + 1,
            (message) => message.role === "assistant" && message.content === FIRST_ANSWER,
          );
          const user2 = findFrom(
            continued,
            answer + 1,
            (message) => message.role === "user" && message.content === SECOND_PROMPT,
          );
          const dbPath = join(home, ".bytengu", "bytengu.db");
          notes.push(
            [
              `round=${round} firstCode=${first.code} secondCode=${second.code} hits=${state.hits()}`,
              `out1=${existsSync(out1)} out2=${existsSync(out2)} dbMode=${(statSync(dbPath).mode & 0o777).toString(8)}`,
              `indexes user1=${user1} call=${call} tool=${tool} answer=${answer} user2=${user2}`,
              "stdout:",
              second.stdout,
              "continued:",
              JSON.stringify(continued),
              "----",
            ].join("\n"),
          );
          assert.equal(first.code, 0);
          assert.equal(first.stdout, `${FIRST_ANSWER}\n`);
          assert.equal(existsSync(out1), false);
          assert.equal(second.code, 0);
          assert.equal(second.stdout, `${SECOND_ANSWER}\n`);
          assert.equal(state.hits(), 3);
          assert.equal(existsSync(out2), true);
          assert.equal(existsSync(dbPath), true);
          assert.equal(dbPath.startsWith(cwd), false);
          assert.equal(statSync(dbPath).mode & 0o777, 0o600);
          assert.ok(user1 >= 0);
          assert.ok(call > user1);
          assert.ok(tool > call);
          assert.ok(answer > tool);
          assert.ok(user2 > answer);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  } finally {
    writeScratch("session-continue.log", notes.join("\n"));
  }
});

test("a fresh run drops the previous prompt, and another workspace does not see it", async () => {
  const notes: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "bytengu-session-fresh-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "bytengu-session-fresh-cwd-"));
  const other = mkdtempSync(join(tmpdir(), "bytengu-session-other-cwd-"));
  const out1 = join(home, "first.json");
  const outFresh = join(home, "fresh.json");
  const outOther = join(home, "other.json");
  writeAuth(home);
  writeFileSync(join(cwd, "notes.txt"), `${SENTINEL}\n`);
  try {
    await withServer(
      [...readThenAnswer, completion(FRESH_ANSWER), completion(OTHER_ANSWER)],
      async (baseUrl, state) => {
        const first = await runChat(["--cwd", cwd, "--out", out1, FIRST_PROMPT], home, baseUrl);
        const fresh = await runChat(["--cwd", cwd, "--out", outFresh, FRESH_PROMPT], home, baseUrl);
        const elsewhere = await runChat(
          ["--continue", "--cwd", other, "--out", outOther, OTHER_PROMPT],
          home,
          baseUrl,
        );
        const posted = state.requests();
        const freshMessages = posted[2] ?? [];
        const otherMessages = posted[3] ?? [];
        notes.push(
          [
            `first=${first.code} fresh=${fresh.code} other=${elsewhere.code} hits=${state.hits()}`,
            `freshUsers=${JSON.stringify(userContents(freshMessages))}`,
            `otherUsers=${JSON.stringify(userContents(otherMessages))}`,
            "fresh:",
            JSON.stringify(freshMessages),
            "other:",
            JSON.stringify(otherMessages),
            "----",
          ].join("\n"),
        );
        assert.equal(first.code, 0);
        assert.equal(fresh.code, 0);
        assert.equal(fresh.stdout, `${FRESH_ANSWER}\n`);
        assert.deepEqual(userContents(freshMessages), [FRESH_PROMPT]);
        assert.equal(JSON.stringify(freshMessages).includes(FIRST_PROMPT), false);
        assert.equal(elsewhere.code, 0);
        assert.equal(elsewhere.stdout, `${OTHER_ANSWER}\n`);
        assert.equal(JSON.stringify(otherMessages).includes(FIRST_PROMPT), false);
        assert.deepEqual(userContents(otherMessages), [OTHER_PROMPT]);
      },
    );
    writeScratch("session-fresh.log", notes.join("\n"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("continue with no stored session starts a new conversation and exits 0", async () => {
  const notes: string[] = [];
  try {
    for (const round of [1, 2]) {
      const home = mkdtempSync(join(tmpdir(), "bytengu-session-empty-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "bytengu-session-empty-cwd-"));
      const out = join(home, "empty.json");
      writeAuth(home);
      try {
        await withServer([completion(EMPTY_ANSWER)], async (baseUrl, state) => {
          const result = await runChat(["--continue", "--cwd", cwd, "--out", out, EMPTY_PROMPT], home, baseUrl);
          const messages = state.requests()[0] ?? [];
          notes.push(
            [
              `round=${round} code=${result.code} hits=${state.hits()}`,
              "stdout:",
              result.stdout,
              `users=${JSON.stringify(userContents(messages))}`,
              "----",
            ].join("\n"),
          );
          assert.equal(result.code, 0);
          assert.equal(result.stdout, `${EMPTY_ANSWER}\n`);
          assert.equal(state.hits(), 1);
          assert.deepEqual(userContents(messages), [EMPTY_PROMPT]);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  } finally {
    writeScratch("session-empty.log", notes.join("\n"));
  }
});

test("AGENTS.md names --continue and the editing run when --mode is omitted", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /--continue/);
  assert.match(agents, /continues the latest session for that workspace/);
  assert.match(agents, /Omitting `--continue` starts a new conversation/);
  assert.match(agents, /Omitting `--mode` keeps that editing run/);
  assert.match(agents, /`0` — clean stop/);
  assert.match(agents, /`1` — startup or model error/);
  assert.match(agents, /`2` — the loop reached the 30-step cap/);
  assert.match(agents, /`3` — the same tool name and arguments was repeated 3 times/);
  assert.match(agents, /--mode plan/);
});
