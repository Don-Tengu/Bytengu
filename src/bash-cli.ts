import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect, Either } from "effect";
import { DEFAULT_TIMEOUT_MS, ToolFailure, decodeToolCall, llmTools, runTool } from "./tools.ts";

const PROMPT =
  "npx tsx src/bash-cli.ts [--dump-schema] [--input <file.json>] [--cwd <dir>] [--timeout <ms>]";

const toPositiveInteger = (value: string): number | undefined => {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const num = Number(value);
  return num > 0 ? num : undefined;
};

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
};

const reject = (error: string) => {
  console.log(JSON.stringify({ ok: false, error }));
  process.exitCode = 1;
};

const program = Effect.gen(function* () {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      input: { type: "string" },
      "dump-schema": { type: "boolean", default: false },
      cwd: { type: "string" },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
    },
    strict: true,
  });

  if (values.input && values["dump-schema"]) {
    console.log(PROMPT);
    process.exitCode = 1;
    return;
  }
  if (values["dump-schema"]) {
    console.log(JSON.stringify(llmTools, null, 2));
    return;
  }
  if (!values.input) {
    console.log(PROMPT);
    process.exitCode = 1;
    return;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const timeout = toPositiveInteger(values.timeout ?? String(DEFAULT_TIMEOUT_MS)) ?? DEFAULT_TIMEOUT_MS;
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(resolve(values.input), "utf8");

  const json = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new ToolFailure({ message: `not valid JSON: ${values.input}` }),
  }).pipe(Effect.either);
  if (Either.isLeft(json)) {
    reject(json.left.message);
    return;
  }

  const decoded = yield* decodeToolCall(json.right).pipe(Effect.either);
  if (Either.isLeft(decoded)) {
    reject(decoded.left.message);
    return;
  }

  const result = yield* runTool(decoded.right, cwd, timeout).pipe(
    Effect.match({
      onFailure: (error) => ({ ok: false as const, error: error.message }),
      onSuccess: (value) => value,
    }),
  );
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
});

if (isMainModule()) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
}
