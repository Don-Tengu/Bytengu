import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Config, Data, Effect, ParseResult, Redacted, Schema } from "effect";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { llmTools, runLLMTool, type Result } from "./tools.ts";

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
};

const loadConfig = Effect.gen(function* () {
  return {
    baseUrl: yield* Config.string("BASE_URL"),
    apiKey: yield* Config.redacted("API_KEY"),
    model: yield* Config.string("MODEL"),
  } satisfies AppConfig;
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
          fetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
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
  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!proxyUrl) return;
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  log(`fetch via proxy ${proxyUrl}`);
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
    },
    allowPositionals: true,
    strict: true,
  });

  const config = yield* loadConfig;
  const prompt = positionals.join("\n");
  if (prompt.trim() === "") {
    return yield* Effect.fail(new LLMError({ message: "expected a non-empty prompt" }));
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const messages: TranscriptMessage[] = [
    {
      role: "system",
      content: [
        "You are a coding agent working in a local git-less workspace.",
        `Workspace directory: ${cwd}`,
        "Use only the tools read_file, write_file, and bash.",
        "Paths passed to read_file/write_file must be relative to the workspace.",
        "bash already runs inside the workspace; do not cd elsewhere.",
        "To run tests, call bash with command: node --test",
        "Keep editing and re-running tests until they pass, then stop.",
      ].join(" "),
    },
    { role: "user", content: prompt },
  ];

  log(`model=${config.model} cwd=${cwd} steps<=${LOOP_THRESHOLD}`);
  log(`user: ${preview(prompt, 200)}`);

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

    const toolResults = yield* Effect.all(
      toolCalls.map((toolCall) =>
        runLLMTool(toolCall.function.name, toolCall.function.arguments, cwd).pipe(
          Effect.map((result) => ({ tool_call_id: toolCall.id, result })),
        ),
      ),
      { concurrency: "unbounded" },
    );

    for (const { tool_call_id, result } of toolResults) {
      const content = toolContent(result);
      log(`result [${tool_call_id}] ok=${result.ok}\n${preview(content)}`);
      messages.push({ role: "tool", tool_call_id, content });
    }
  }

  if (i >= LOOP_THRESHOLD) log(`stopped: hit LOOP_THRESHOLD=${LOOP_THRESHOLD}`);

  const outPath = resolve(values.out ?? "fixtures/messages.json");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(outPath, `${JSON.stringify(messages, null, 2)}\n`);
  log(
    `\n=== done steps=${Math.min(i + 1, LOOP_THRESHOLD)} messages=${messages.length} out=${outPath} ===`,
  );
  if (lastText) console.log(lastText);
});

if (isMainModule()) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
}
