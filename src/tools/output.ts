import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { MAX_LINE_LENGTH, MAX_OUTPUT, type Ok, type ToolName } from "./types.ts";

export const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
};

export const clipLine = (line: string): string =>
  line.length <= MAX_LINE_LENGTH
    ? line
    : `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`;

export const page = <T>(items: readonly T[], offset: number, limit: number) => {
  const total = items.length;
  if (total === 0) {
    return { total, start: 0, end: 0, slice: [] as T[], past: false };
  }
  if (offset > total) {
    return { total, start: offset, end: 0, slice: [] as T[], past: true };
  }
  const slice = items.slice(offset - 1, offset - 1 + limit);
  const end = slice.length === 0 ? 0 : offset - 1 + slice.length;
  return { total, start: offset, end, slice, past: false };
};

const present = (output: string) =>
  Effect.gen(function* () {
    if (output.length <= MAX_OUTPUT) return output;
    const fs = yield* FileSystem.FileSystem;
    const dir = join(tmpdir(), "bytengu-output");
    const file = join(dir, `${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.txt`);
    const written = yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.flatMap(() => fs.writeFileString(file, output)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const note = written ? `full output: ${file}` : "full output was not saved";
    return `${output.slice(0, MAX_OUTPUT)}\n...[truncated ${output.length - MAX_OUTPUT} chars; ${note}]`;
  });

export const succeed = (name: ToolName, output: string) =>
  present(output).pipe(Effect.map((text): Ok => ({ ok: true, name, output: text })));

export const isMissing = (message: string): boolean => /ENOENT|no such file/i.test(message);
