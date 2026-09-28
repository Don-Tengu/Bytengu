import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Data, Effect, Either, Exit, Option, ParseResult, Redacted, Schema } from "effect";
import {
  DEFAULT_HEADLESS_FORMAT,
  auditLine,
  auditLogPath,
  exitCodeFor,
  headlessLine,
  isHeadlessFormat,
  type HeadlessFormat,
  type StopReason,
} from "./headless.ts";
import { projectInstructions } from "./instructions.ts";
import { proxiedFetch, proxyUrl } from "./proxy.ts";
import { sessionConfig } from "./provider/xai.ts";
import {
  DEFAULT_APPROVAL_PROFILE,
  DEFAULT_TIMEOUT_MS,
  emptyStreak,
  isApprovalProfile,
  isChatMode,
  llmTools,
  runLLMToolsInOrder,
  DOOM_LOOP_THRESHOLD,
  type ApprovalProfile,
  type ChatMode,
  type Result,
} from "./tools/index.ts";

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

/**
 * Tests point this process at a local completion server.
 * Production leaves the variable unset, so requests stay on xAI. Not a provider switch.
 */
const completionsBaseUrl = (fallback: string): string => {
  const override = process.env.BYTENGU_BASE_URL?.trim();
  if (!override) return fallback;
  return override.replace(/\/$/, "");
};

const loadConfig = Effect.gen(function* () {
  const session = yield* sessionConfig().pipe(
    Effect.mapError((error) => new LLMError({ message: error.message })),
  );
  return {
    baseUrl: completionsBaseUrl(session.baseUrl),
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

/** Included in the system text only when `--mode plan` is selected. */
export const PLAN_MODE_INSTRUCTION =
  "Plan mode: name which files to change and how to check. Do not modify files.";

export const systemPrompt = (cwd: string, mode?: ChatMode): string => {
  const fixed = [
    "You are a coding agent working in a local workspace.",
    `Workspace directory: ${cwd}`,
    "Tools: read_file, edit, write_file, grep, glob, and bash.",
    "Paths are relative to the workspace. bash already runs there; do not cd elsewhere.",
    "read_file returns at most 200 lines. Each line is prefixed with its number, a pipe, and a space (`12| `). That prefix is not part of the file. Use offset and limit to read further.",
    "edit changes an existing file by exact old_string. read_file that file first. old_string must match the file text exactly, once, unless replace_all is true. Do not copy the line-number prefix into old_string or new_string.",
    "write_file replaces a whole file or creates a new one, including parent directories. Prefer edit for files that already exist.",
    "Use grep and glob to search. Do not use bash for find or grep.",
  ].join(" ");
  return mode === "plan" ? `${fixed} ${PLAN_MODE_INSTRUCTION}` : fixed;
};

/** Fixed tool instructions, then nearest-first project instructions when any exist. */
export const systemMessage = (cwd: string, mode?: ChatMode) =>
  Effect.gen(function* () {
    const project = yield* projectInstructions(cwd);
    const fixed = systemPrompt(cwd, mode);
    if (project === "") return fixed;
    return `${fixed}\n\nProject instructions read from the workspace. Follow them. They are ordinary project files, not hidden policy.\n\n${project}`;
  });

type RecordedTool = {
  readonly name: string;
  readonly ok: boolean;
};

/** Stderr message, and a closing JSON event when that format was selected. No transcript. */
const failEarly = (format: HeadlessFormat, message: string) =>
  Effect.sync(() => {
    if (format === "json") console.log(headlessLine({ type: "done", reason: "error" }));
    console.error(message);
    return 1;
  });

const appendAudit = (
  recorded: readonly RecordedTool[],
  reason: StopReason,
  profile: ApprovalProfile,
  cwd: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = auditLogPath();
    const directory = dirname(path);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.chmod(directory, 0o700);
    const time = new Date().toISOString();
    const body = recorded
      .map((tool) =>
        auditLine({
          time,
          profile,
          cwd,
          tool: tool.name,
          ok: tool.ok,
          reason,
        }),
      )
      .join("");
    yield* fs.writeFileString(path, body, { flag: "a", mode: 0o600 });
    yield* fs.chmod(path, 0o600);
  });

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
};

const program = Effect.gen(function* () {
  yield* configureProxy;

  const parsed = yield* Effect.try({
    try: () =>
      parseArgs({
        args: process.argv.slice(2),
        options: {
          out: { type: "string", default: "fixtures/messages.json" },
          cwd: { type: "string" },
          profile: { type: "string" },
          format: { type: "string" },
          mode: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
      }),
    catch: (cause) => new LLMError({ message: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(Effect.either);
  if (Either.isLeft(parsed)) return yield* failEarly("human", parsed.left.message);
  const { values, positionals } = parsed.right;

  const formatArg = values.format;
  if (formatArg !== undefined && !isHeadlessFormat(formatArg)) {
    return yield* failEarly("human", `unknown format: ${formatArg}`);
  }
  const format: HeadlessFormat = formatArg ?? DEFAULT_HEADLESS_FORMAT;

  const profileArg = values.profile;
  if (profileArg !== undefined && !isApprovalProfile(profileArg)) {
    return yield* failEarly(format, `unknown profile: ${profileArg}`);
  }
  const profile: ApprovalProfile = profileArg ?? DEFAULT_APPROVAL_PROFILE;

  const modeArg = values.mode;
  if (modeArg !== undefined && !isChatMode(modeArg)) {
    return yield* failEarly(format, `unknown mode: ${modeArg}`);
  }
  const mode: ChatMode | undefined = modeArg;
  log(`profile=${profile}${mode === "plan" ? " mode=plan" : ""}`);

  const loaded = yield* loadConfig.pipe(Effect.either);
  if (Either.isLeft(loaded)) return yield* failEarly(format, loaded.left.message);
  const config = loaded.right;

  const prompt = positionals.join("\n");
  if (prompt.trim() === "") return yield* failEarly(format, "expected a non-empty prompt");

  const fs = yield* FileSystem.FileSystem;
  const requestedCwd = resolve(values.cwd ?? process.cwd());
  const info = yield* fs.stat(requestedCwd).pipe(Effect.option);
  if (Option.isNone(info)) {
    return yield* failEarly(format, `workspace does not exist: ${requestedCwd}`);
  }
  if (info.value.type !== "Directory") {
    return yield* failEarly(format, `workspace is not a directory: ${requestedCwd}`);
  }
  const resolved = yield* fs.realPath(requestedCwd).pipe(
    Effect.mapError((error) => new LLMError({ message: error.message })),
    Effect.either,
  );
  if (Either.isLeft(resolved)) return yield* failEarly(format, resolved.left.message);
  const cwd = resolved.right;

  const instructions = yield* systemMessage(cwd, mode).pipe(
    Effect.mapError((error) => new LLMError({ message: error.message })),
    Effect.either,
  );
  if (Either.isLeft(instructions)) return yield* failEarly(format, instructions.left.message);

  const messages: TranscriptMessage[] = [
    { role: "system", content: instructions.right },
    { role: "user", content: prompt },
  ];

  log(`model=${config.model} cwd=${cwd} profile=${profile} steps<=${LOOP_THRESHOLD}`);
  log(`user: ${preview(prompt, 200)}`);

  const session = { reads: new Set<string>() };
  let streak = emptyStreak();
  let lastText = "";
  let reason: StopReason = "step-cap";
  let sawAssistant = false;
  let errorMessage = "";
  const recorded: RecordedTool[] = [];

  for (let i = 0; i < LOOP_THRESHOLD; ++i) {
    log(`\n=== step ${i + 1} ===`);
    if (format === "json") console.log(headlessLine({ type: "step", step: i + 1 }));

    const posted = yield* postLLM(messages, config).pipe(Effect.either);
    if (Either.isLeft(posted)) {
      reason = "error";
      errorMessage = posted.left.message;
      break;
    }

    const turn = posted.right;
    const msg = turn.choice.message;
    log(`finish_reason=${turn.choice.finish_reason ?? "?"}`);
    if (msg.content) {
      lastText = msg.content;
      log(`assistant:\n${preview(msg.content)}`);
    }

    messages.push(turn.assistant);
    sawAssistant = true;
    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      reason = "clean";
      break;
    }

    for (const toolCall of toolCalls) {
      log(`tool ${toolCall.function.name} [${toolCall.id}]`);
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
      DEFAULT_TIMEOUT_MS,
      profile,
      mode,
    );
    streak = batch.streak;

    for (let index = 0; index < batch.results.length; index++) {
      const toolCall = toolCalls[index];
      const row = batch.results[index];
      if (!toolCall || !row) continue;
      const name = toolCall.function.name;
      const ok = row.result.ok;
      recorded.push({ name, ok });
      if (format === "json") console.log(headlessLine({ type: "tool", name, ok }));
      log(`result [${row.tool_call_id}] ok=${ok}`);
      messages.push({ role: "tool", tool_call_id: row.tool_call_id, content: toolContent(row.result) });
    }
    if (batch.stopped) {
      reason = "repeated-tool";
      log(`stopped: repeated the same tool call ${DOOM_LOOP_THRESHOLD} times`);
      break;
    }
  }

  if (reason === "step-cap") log(`stopped: hit LOOP_THRESHOLD=${LOOP_THRESHOLD}`);

  const outPath = resolve(values.out ?? "fixtures/messages.json");
  const writeTranscript =
    reason === "clean" || reason === "step-cap" || reason === "repeated-tool" || sawAssistant;
  if (writeTranscript) {
    yield* fs.writeFileString(outPath, `${JSON.stringify(messages, null, 2)}\n`);
  }
  if (recorded.length > 0) yield* appendAudit(recorded, reason, profile, cwd);

  log(
    writeTranscript
      ? `\n=== done messages=${messages.length} out=${outPath} reason=${reason} ===`
      : `\n=== done messages=${messages.length} reason=${reason} ===`,
  );

  if (format === "json") {
    if (lastText) console.log(headlessLine({ type: "assistant", text: lastText }));
    console.log(headlessLine({ type: "done", reason }));
  } else if (lastText) {
    console.log(lastText);
  }
  if (errorMessage) console.error(errorMessage);
  return exitCodeFor(reason);
});

if (isMainModule()) {
  // A successful effect is exit 0 inside runMain. The number returned here is the headless table.
  NodeRuntime.runMain(
    program.pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(error.message);
          return 1;
        }),
      ),
    ),
    {
      teardown: (exit, onExit) => {
        if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
          onExit(1);
          return;
        }
        const code = Exit.isSuccess(exit) && typeof exit.value === "number" ? exit.value : 0;
        onExit(code);
      },
    },
  );
}
