import { JSONSchema, Schema } from "effect";
import { DEFAULT_READ_LIMIT, MAX_READ_LIMIT, type ToolName } from "./types.ts";

const describedString = (description: string) =>
  Schema.String.pipe(Schema.minLength(1)).annotations({ description });

const positiveInt = (description: string, maximum?: number) => {
  const base = Schema.Number.pipe(Schema.int(), Schema.positive());
  const bounded = maximum === undefined ? base : base.pipe(Schema.lessThanOrEqualTo(maximum));
  return bounded.annotations({ description });
};

const WorkspacePath = describedString("Path relative to the workspace");
const FileContent = describedString("Full file contents to write");
const BashCommand = describedString("Bash command to run inside the workspace");
const OldString = Schema.String.annotations({
  description:
    "Exact text to replace. Copy it from the file, not from the `N| ` line prefix that read_file prints.",
});
const NewString = Schema.String.annotations({
  description: "Replacement text. An empty string deletes old_string.",
});

const ReadArgs = Schema.Struct({
  path: WorkspacePath,
  offset: Schema.optional(positiveInt("1-based line or directory entry to start at. Defaults to 1.")),
  limit: Schema.optional(
    positiveInt(
      `Maximum lines or directory entries to return. Defaults to ${DEFAULT_READ_LIMIT}.`,
      MAX_READ_LIMIT,
    ),
  ),
});
const WriteArgs = Schema.Struct({ path: WorkspacePath, content: FileContent });
const EditArgs = Schema.Struct({
  path: WorkspacePath,
  old_string: OldString,
  new_string: NewString,
  replace_all: Schema.optional(
    Schema.Boolean.annotations({
      description: "Replace every exact occurrence of old_string. Defaults to false.",
    }),
  ),
});
const BashArgs = Schema.Struct({ command: BashCommand });
const GrepArgs = Schema.Struct({
  pattern: describedString("Regular expression to search for in file contents"),
  path: Schema.optional(
    WorkspacePath.annotations({
      description: "File or directory to search, relative to the workspace. Defaults to the workspace root.",
    }),
  ),
});
const GlobArgs = Schema.Struct({
  pattern: describedString("Glob such as **/*.ts or src/**/*.js"),
  path: Schema.optional(
    WorkspacePath.annotations({
      description: "Directory to search, relative to the workspace. Defaults to the workspace root.",
    }),
  ),
});

export const ToolCall = Schema.Union(
  Schema.Struct({ name: Schema.Literal("read_file"), arguments: ReadArgs }),
  Schema.Struct({ name: Schema.Literal("write_file"), arguments: WriteArgs }),
  Schema.Struct({ name: Schema.Literal("edit"), arguments: EditArgs }),
  Schema.Struct({ name: Schema.Literal("grep"), arguments: GrepArgs }),
  Schema.Struct({ name: Schema.Literal("glob"), arguments: GlobArgs }),
  Schema.Struct({ name: Schema.Literal("bash"), arguments: BashArgs }),
);
export type ToolCall = Schema.Schema.Type<typeof ToolCall>;

export type ReadCall = Extract<ToolCall, { name: "read_file" }>;
export type WriteCall = Extract<ToolCall, { name: "write_file" }>;
export type EditCall = Extract<ToolCall, { name: "edit" }>;
export type GrepCall = Extract<ToolCall, { name: "grep" }>;
export type GlobCall = Extract<ToolCall, { name: "glob" }>;
export type BashCall = Extract<ToolCall, { name: "bash" }>;

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

const tool = (name: ToolName, description: string, parameters: Schema.Schema.Any) => ({
  type: "function" as const,
  function: { name, description, parameters: asParameters(parameters) },
});

/** OpenAI / Gemini Chat Completions `tools` array. */
export const llmTools = [
  tool(
    "read_file",
    "Read a UTF-8 text file, or list one directory level. Each file line is prefixed with its line number, a pipe, and a space (`12| `). That prefix is not part of the file. Defaults to the first 200 lines; pass offset and limit to page.",
    ReadArgs,
  ),
  tool(
    "write_file",
    "Create or overwrite a whole file, creating parent directories if needed. Prefer edit for a file that already exists.",
    WriteArgs,
  ),
  tool(
    "edit",
    "Replace exact text in an existing file. read_file the file first. old_string must match the file exactly, including whitespace and line endings, and must match once unless replace_all is true. Do not include the `N| ` line prefix. Fails if the file does not exist; use write_file to create a file.",
    EditArgs,
  ),
  tool(
    "grep",
    "Search file contents with a regular expression. Prefer this to bash grep. Results are file:line:text, capped at 100 matches.",
    GrepArgs,
  ),
  tool(
    "glob",
    "Find files by glob, such as **/*.ts. Prefer this to bash find. Results are capped at 100 paths.",
    GlobArgs,
  ),
  tool(
    "bash",
    "Run a bash command in the workspace. Non-zero exit and timeouts are returned as output, not as a crash. Do not use bash for reading, searching, or editing files.",
    BashArgs,
  ),
];
