import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Data, Effect, Either, Option, ParseResult, Redacted, Schema } from "effect";
import { proxiedFetch, proxyUrl } from "./proxy.ts";
import { sessionConfig } from "./provider/xai.ts";
import { emptyStreak, llmTools, runLLMToolsInOrder, DOOM_LOOP_THRESHOLD, type Result } from "./tools/index.ts";

const LOOP_THRESHOLD = 30;

class LLMError extends Data.TaggedError("LLMError")<{
  readonly message: string;
}> {}

const FinishReason = Schema.Literal("stop", "length", "content_filter", "tool_calls");

const FunctionCall = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
  // Gemini thinking models attach this. Decoding keeps it; we still forward
  // the provider's original assistant message so unknown siblings survive too.
  extra_content: Schema.optional(Schema.Unknown),
});

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.Array(FunctionCall)),
});
type AssistantMessage = Schema.Schema.Type<typeof AssistantMessage>;

const Choice = Schema.Struct({
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  message: AssistantMessage,
  finish_reason: Schema.optional(Schema.NullOr(FinishReason)),
});

const ChatCompletion = Schema.Struct({
  id: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  object: Schema.Literal("chat.completion"),
  choices: Schema.Array(Choice),
});

type TranscriptMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string }
  | AssistantMessage;

type AppConfig = {
  readonly baseUrl: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly headers: Readonly<Record<string, string>>;
};

const loadConfig = Effect.gen(function* () {
  const session = yield* sessionConfig().pipe(
    Effect.mapError((error) => new LLMError({ message: error.message })),
  );
  return {
    baseUrl: session.baseUrl,
    model: session.model,
    apiKey: Redacted.make(session.apiKey),
    headers: session.headers,
  };
});

const preview = (text: string, max = 800): string => {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n...[${trimmed.length - max} more chars]`;
};

const log = (...args: unknown[]): void => {
  console.error(...args);
};

const retryAfterMs = (res: Response, body: string): number => {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  const match = body.match(/retry in ([\d.]+)\s*s/i);
  if (match?.[1]) return Math.ceil(Number(match[1]) * 1000);
  return 15_000;
};

const readBody = (res: Response) =>
  Effect.tryPromise({
    try: () => res.text(),
    catch: (cause) =>
      new LLMError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Schema drops unknown fields. The next request must send the original object. */
const originalAssistant = (json: unknown): AssistantMessage | undefined => {
  if (!isRecord(json) || !Array.isArray(json.choices)) return undefined;
  const choice = json.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  return choice.message as AssistantMessage;
};

const decodeCompletion = (json: unknown) =>
  Effect.gen(function* () {
    const completion = yield* Schema.decodeUnknown(ChatCompletion)(json).pipe(
      Effect.mapError(
        (error) => new LLMError({ message: ParseResult.TreeFormatter.formatErrorSync(error) }),
      ),
    );
    if (completion.choices.length === 0) {
      return yield* Effect.fail(new LLMError({ message: "choices must not be empty" }));
    }
    for (let i = 0; i < completion.choices.length; i++) {
      const choice = completion.choices[i];
      if (!choice || choice.index !== i) {
        return yield* Effect.fail(
          new LLMError({ message: `index must equal array position (${i})` }),
        );
      }
    }
    const assistant = originalAssistant(json);
    const choice = completion.choices[0];
    if (!assistant || !choice) {
      return yield* Effect.fail(new LLMError({ message: "LLM response is missing the assistant message" }));
    }
    return { choice, assistant };
  });

const postLLM = (dialog: readonly TranscriptMessage[], config: AppConfig) =>
  Effect.gen(function* () {
    const payload = JSON.stringify({
      model: config.model,
      messages: dialog,
      tools: llmTools,
      tool_choice: "auto",
    });
    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = yield* Effect.tryPromise({
        try: () =>
          proxiedFetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
              ...config.headers,
            },
            body: payload,
          }),
        catch: (cause) =>
          new LLMError({ message: cause instanceof Error ? cause.message : String(cause) }),
      });

      if (res.status === 429) {
        const body = yield* readBody(res);
        if (attempt === maxAttempts) {
          return yield* Effect.fail(
            new LLMError({
              message: `LLM request failed: ${res.status} ${res.statusText}\n${body.slice(0, 500)}`,
            }),
          );
        }
        const waitMs = retryAfterMs(res, body);
        log(`rate limited (429), waiting ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
        yield* Effect.sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = yield* readBody(res);
        return yield* Effect.fail(
          new LLMError({
            message: `LLM request failed: ${res.status} ${res.statusText}\n${body.slice(0, 500)}`,
          }),
        );
      }

      const json = yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (cause) =>
          new LLMError({ message: cause instanceof Error ? cause.message : String(cause) }),
      });
      return yield* decodeCompletion(json);
    }

    return yield* Effect.fail(new LLMError({ message: "LLM request failed after retries" }));
  });

const toolContent = (result: Result): string => (result.ok ? result.output : result.error);

const configureProxy = Effect.sync(() => {
  const proxy = proxyUrl();
  if (!proxy) return;
  log(`fetch via proxy ${proxy}`);
});

/** Run a shell command in the workspace and return its exit code. Output stays on the terminal. */
export const runWorkspaceCommand = (command: string, cwd: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<number>((resolvePromise, reject) => {
        const child = spawn("/bin/bash", ["-lc", command], { cwd, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => resolvePromise(code ?? 1));
      }),
    catch: (cause) => new LLMError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
};

const program = Effect.gen(function* () {
  yield* configureProxy;

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string", default: "fixtures/messages.json" },
      cwd: { type: "string" },
      test: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const config = yield* loadConfig;
  const prompt = positionals.join("\n");
  if (prompt.trim() === "") {
    return yield* Effect.fail(new LLMError({ message: "expected a non-empty prompt" }));
  }

  const fs = yield* FileSystem.FileSystem;
  const requestedCwd = resolve(values.cwd ?? process.cwd());
  const info = yield* fs.stat(requestedCwd).pipe(Effect.option);
  if (Option.isNone(info)) {
    return yield* Effect.fail(new LLMError({ message: `workspace does not exist: ${requestedCwd}` }));
  }
  if (info.value.type !== "Directory") {
    return yield* Effect.fail(new LLMError({ message: `workspace is not a directory: ${requestedCwd}` }));
  }
  const cwd = yield* fs.realPath(requestedCwd).pipe(
    Effect.mapError((error) => new LLMError({ message: error.message })),
  );
  const messages: TranscriptMessage[] = [
    {
      role: "system",
      content: [
        "You are a coding agent working in a local workspace.",
        `Workspace directory: ${cwd}`,
        "Tools: read_file, edit, write_file, grep, glob, and bash.",
        "Paths are relative to the workspace. bash already runs there; do not cd elsewhere.",
        "read_file returns at most 200 lines. Each line is prefixed with its number, a pipe, and a space (`12| `). That prefix is not part of the file. Use offset and limit to read further.",
        "edit changes an existing file by exact old_string. read_file that file first. old_string must match the file text exactly, once, unless replace_all is true. Do not copy the line-number prefix into old_string or new_string.",
        "write_file replaces a whole file or creates a new one, including parent directories. Prefer edit for files that already exist.",
        "Use grep and glob to search. Do not use bash for find or grep.",
        values.test
          ? `To run tests, call bash with command: ${values.test}`
          : "To run tests, call bash with command: node --test",
        "Keep editing and re-running tests until they pass, then stop.",
      ].join(" "),
    },
    { role: "user", content: prompt },
  ];

  log(`model=${config.model} cwd=${cwd} steps<=${LOOP_THRESHOLD}`);
  log(`user: ${preview(prompt, 200)}`);

  const testCommand = values.test;
  if (testCommand) {
    log(`\n=== tests before ===\n$ ${testCommand}`);
    const before = yield* runWorkspaceCommand(testCommand, cwd);
    log(`=== tests before exit ${before} ===`);
  }

  const outcome = yield* Effect.either(
    Effect.gen(function* () {
      const session = { reads: new Set<string>() };
      let streak = emptyStreak();
      let lastText = "";
      let i = 0;
      for (; i < LOOP_THRESHOLD; ++i) {
        log(`\n=== step ${i + 1} ===`);
        const turn = yield* postLLM(messages, config);
        const msg = turn.choice.message;

        log(`finish_reason=${turn.choice.finish_reason ?? "?"}`);
        if (msg.content) {
          lastText = msg.content;
          log(`assistant:\n${preview(msg.content)}`);
        }

        messages.push(turn.assistant);
        const toolCalls = msg.tool_calls ?? [];
        if (toolCalls.length === 0) break;

        for (const toolCall of toolCalls) {
          log(
            `tool ${toolCall.function.name} [${toolCall.id}]\n  args: ${preview(toolCall.function.arguments, 400)}`,
          );
        }

        const batch = yield* runLLMToolsInOrder(
          toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          })),
          cwd,
          session,
          streak,
        );
        streak = batch.streak;

        for (const { tool_call_id, result } of batch.results) {
          const content = toolContent(result);
          log(`result [${tool_call_id}] ok=${result.ok}\n${preview(content)}`);
          messages.push({ role: "tool", tool_call_id, content });
        }
        if (batch.stopped) {
          log(`stopped: repeated the same tool call ${DOOM_LOOP_THRESHOLD} times`);
          break;
        }
      }

      if (i >= LOOP_THRESHOLD) log(`stopped: hit LOOP_THRESHOLD=${LOOP_THRESHOLD}`);

      const outPath = resolve(values.out ?? "fixtures/messages.json");
      yield* fs.writeFileString(outPath, `${JSON.stringify(messages, null, 2)}\n`);
      log(
        `\n=== done steps=${Math.min(i + 1, LOOP_THRESHOLD)} messages=${messages.length} out=${outPath} ===`,
      );
      if (lastText) console.log(lastText);
    }),
  );

  if (testCommand) {
    log(`\n=== tests after ===\n$ ${testCommand}`);
    const after = yield* runWorkspaceCommand(testCommand, cwd);
    log(`=== tests after exit ${after} ===`);
    if (Either.isRight(outcome) && after !== 0) {
      return yield* Effect.fail(
        new LLMError({ message: `tests failed after the agent (exit ${after})` }),
      );
    }
  }
  if (Either.isLeft(outcome)) return yield* Effect.fail(outcome.left);
});

if (isMainModule()) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
}
