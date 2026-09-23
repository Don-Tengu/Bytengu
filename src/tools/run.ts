import { FileSystem } from "@effect/platform";
import { Effect, ParseResult, Schema } from "effect";
import { invokeBash } from "./bash.ts";
import { invokeEdit } from "./edit.ts";
import { invokeReadFile } from "./read.ts";
import { invokeGlob, invokeGrep } from "./search.ts";
import { ToolCall } from "./schema.ts";
import { workspaceReal } from "./path.ts";
import { invokeWriteFile } from "./write.ts";
import {
  DEFAULT_TIMEOUT_MS,
  DOOM_LOOP_THRESHOLD,
  ToolFailure,
  isDoomLoop,
  nextStreak,
  type Ok,
  type OrderedToolCall,
  type RepeatStreak,
  type Result,
  type ToolBatch,
  type ToolSession,
} from "./types.ts";

const STOPPED_REPEAT = `stopped: the same tool call was repeated ${DOOM_LOOP_THRESHOLD} times`;
const NOT_RUN = "not executed: agent stopped after a repeated tool call";

export const decodeToolCall = (input: unknown) =>
  Schema.decodeUnknown(ToolCall, { errors: "all" })(input).pipe(
    Effect.mapError(
      (error) => new ToolFailure({ message: ParseResult.TreeFormatter.formatErrorSync(error) }),
    ),
  );

export const runTool = (
  call: ToolCall,
  cwd: string,
  timeout = DEFAULT_TIMEOUT_MS,
  session?: ToolSession,
): Effect.Effect<Ok, ToolFailure, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // `/tmp` is a symlink to `/private/tmp` on macOS. Relative paths are only stable
    // when every tool uses the same real workspace root.
    const root = yield* workspaceReal(cwd);
    switch (call.name) {
      case "read_file":
        return yield* invokeReadFile(call, root, session);
      case "write_file":
        return yield* invokeWriteFile(call, root);
      case "edit":
        return yield* invokeEdit(call, root, session);
      case "grep":
        return yield* invokeGrep(call, root, timeout);
      case "glob":
        return yield* invokeGlob(call, root, timeout);
      case "bash":
        return yield* invokeBash(call, root, timeout);
    }
  });

/** Run one model tool call. Expected failures come back as `{ ok: false }`. */
export const runLLMTool = (
  name: string,
  argumentsJson: string,
  cwd: string,
  timeout = DEFAULT_TIMEOUT_MS,
  session?: ToolSession,
): Effect.Effect<Result, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const args = yield* Effect.try({
      try: () => JSON.parse(argumentsJson) as unknown,
      catch: () => new ToolFailure({ message: `invalid arguments JSON: ${argumentsJson}` }),
    });
    const call = yield* decodeToolCall({ name, arguments: args });
    return yield* runTool(call, cwd, timeout, session);
  }).pipe(
    Effect.match({
      onFailure: (error): Result => ({ ok: false, error: error.message }),
      onSuccess: (value) => value,
    }),
  );

/**
 * Tool calls in one assistant message run in the order the model emitted them.
 * An edit and the bash that tests it cannot share a turn if they run at once.
 * The same name and arguments three times in a row stops the batch.
 */
export const runLLMToolsInOrder = (
  calls: readonly OrderedToolCall[],
  cwd: string,
  session: ToolSession,
  streak: RepeatStreak,
  timeout = DEFAULT_TIMEOUT_MS,
): Effect.Effect<ToolBatch, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const results: Array<{ tool_call_id: string; result: Result }> = [];
    let current = streak;
    let stopped = false;
    for (const call of calls) {
      if (stopped) {
        results.push({ tool_call_id: call.id, result: { ok: false, error: NOT_RUN } });
        continue;
      }
      const next = nextStreak(current, `${call.name}\n${call.arguments}`);
      if (isDoomLoop(next)) {
        stopped = true;
        current = next;
        results.push({ tool_call_id: call.id, result: { ok: false, error: STOPPED_REPEAT } });
        continue;
      }
      current = next;
      const result = yield* runLLMTool(call.name, call.arguments, cwd, timeout, session);
      results.push({ tool_call_id: call.id, result });
    }
    return { results, streak: current, stopped };
  });
