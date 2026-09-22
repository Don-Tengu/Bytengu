import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { FileSystem } from "@effect/platform";
import { Data, Effect, JSONSchema, ParseResult, Schema } from "effect";

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT = 20_000;

/**
 * Expected tool failure: bad arguments, a path outside the workspace, or an
 * I/O error. Bash timeouts and non-zero exits are not this — the model has to
 * see those as ordinary output.
 */
export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  readonly message: string;
}> {}

const describedString = (description: string) =>
  Schema.String.pipe(Schema.minLength(1)).annotations({ description });

const WorkspacePath = describedString("Path relative to the workspace");
const FileContent = describedString("Full file contents to write");
const BashCommand = describedString("Bash command to run inside the workspace");

const ReadArgs = Schema.Struct({ path: WorkspacePath });
const WriteArgs = Schema.Struct({ path: WorkspacePath, content: FileContent });
const BashArgs = Schema.Struct({ command: BashCommand });

export const ToolCall = Schema.Union(
  Schema.Struct({ name: Schema.Literal("read_file"), arguments: ReadArgs }),
  Schema.Struct({ name: Schema.Literal("write_file"), arguments: WriteArgs }),
  Schema.Struct({ name: Schema.Literal("bash"), arguments: BashArgs }),
);
export type ToolCall = Schema.Schema.Type<typeof ToolCall>;

type ReadCall = Extract<ToolCall, { name: "read_file" }>;
type WriteCall = Extract<ToolCall, { name: "write_file" }>;
type BashCall = Extract<ToolCall, { name: "bash" }>;

export type Ok = {
  readonly ok: true;
  readonly name: "read_file" | "write_file" | "bash";
  readonly output: string;
};
export type Result =
  | Ok
  | {
      readonly ok: false;
      readonly error: string;
    };

type ExecSuccess = { readonly stdout: string; readonly stderr: string };
type ExecFailure = {
  readonly killed?: boolean;
  readonly code?: string | number;
  readonly stdout?: string;
  readonly stderr?: string;
};

// `title` is the refinement's own name (`minLength(1)`). The model only needs description and minLength.
const withoutTitles = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutTitles);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "title") continue;
    out[key] = withoutTitles(child);
  }
  return out;
};

const asParameters = (schema: Schema.Schema.Any): Record<string, unknown> => {
  const json = withoutTitles(JSONSchema.make(schema)) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

/** OpenAI / Gemini Chat Completions `tools` array. */
export const llmTools = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a UTF-8 file in the workspace",
      parameters: asParameters(ReadArgs),
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Overwrite a file in the workspace",
      parameters: asParameters(WriteArgs),
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description:
        "Run a bash command in the workspace. Non-zero exit and timeouts are returned as output, not as a crash.",
      parameters: asParameters(BashArgs),
    },
  },
];

const isInside = (root: string, target: string): boolean => {
  const rootAbs = resolve(root);
  const targetAbs = resolve(rootAbs, target);
  const rel = relative(rootAbs, targetAbs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const resolveInWorkspace = (cwd: string, userPath: string) => {
  if (!isInside(cwd, userPath)) {
    return Effect.fail(new ToolFailure({ message: `path escapes workspace: ${userPath}` }));
  }
  return Effect.succeed(resolve(cwd, userPath));
};

const formatOutput = (exit: string, stdout: string, stderr: string): string => {
  const body = [stdout, stderr].filter(Boolean).join("\n");
  const text = body ? `${exit}\n${body}` : exit;
  return text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, MAX_OUTPUT)}\n...[truncated ${text.length - MAX_OUTPUT} chars]`;
};

export const decodeToolCall = (input: unknown) =>
  Schema.decodeUnknown(ToolCall, { errors: "all" })(input).pipe(
    Effect.mapError(
      (error) => new ToolFailure({ message: ParseResult.TreeFormatter.formatErrorSync(error) }),
    ),
  );

const invokeReadFile = (call: ReadCall, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const abs = yield* resolveInWorkspace(cwd, call.arguments.path);
    const output = yield* fs.readFileString(abs, "utf8").pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    return { ok: true as const, name: "read_file" as const, output };
  });

const invokeWriteFile = (call: WriteCall, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const abs = yield* resolveInWorkspace(cwd, call.arguments.path);
    yield* fs.writeFileString(abs, call.arguments.content).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    return { ok: true as const, name: "write_file" as const, output: `wrote ${call.arguments.path}` };
  });

const invokeBash = (call: BashCall, cwd: string, timeout: number) =>
  Effect.tryPromise({
    try: () =>
      execFileAsync("/bin/bash", ["-lc", call.arguments.command], {
        encoding: "utf8",
        cwd,
        timeout,
        maxBuffer: MAX_BUFFER,
      }) as Promise<ExecSuccess>,
    catch: (err) => err as ExecFailure,
  }).pipe(
    Effect.match({
      onSuccess: ({ stdout, stderr }) => formatOutput("exit 0", stdout, stderr),
      onFailure: (err) => {
        const stdout = err.stdout ?? "";
        const stderr = err.stderr ?? "";
        if (err.killed || err.code === "ETIMEDOUT") {
          return formatOutput(`timed out after ${timeout}ms`, stdout, stderr);
        }
        const code = typeof err.code === "number" ? err.code : 1;
        return formatOutput(`exit ${code}`, stdout, stderr);
      },
    }),
    Effect.map((output) => ({ ok: true as const, name: "bash" as const, output })),
  );

export const runTool = (
  call: ToolCall,
  cwd: string,
  timeout = DEFAULT_TIMEOUT_MS,
): Effect.Effect<Ok, ToolFailure, FileSystem.FileSystem> => {
  switch (call.name) {
    case "read_file":
      return invokeReadFile(call, cwd);
    case "write_file":
      return invokeWriteFile(call, cwd);
    case "bash":
      return invokeBash(call, cwd, timeout);
  }
};

/** Run one model tool call. Expected failures come back as `{ ok: false }`. */
export const runLLMTool = (
  name: string,
  argumentsJson: string,
  cwd: string,
  timeout = DEFAULT_TIMEOUT_MS,
): Effect.Effect<Result, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const args = yield* Effect.try({
      try: () => JSON.parse(argumentsJson) as unknown,
      catch: () => new ToolFailure({ message: `invalid arguments JSON: ${argumentsJson}` }),
    });
    const call = yield* decodeToolCall({ name, arguments: args });
    return yield* runTool(call, cwd, timeout);
  }).pipe(
    Effect.match({
      onFailure: (error): Result => ({ ok: false, error: error.message }),
      onSuccess: (value) => value,
    }),
  );
