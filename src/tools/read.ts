import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { clipLine, isMissing, page, splitLines, succeed } from "./output.ts";
import { resolveInWorkspace, workspaceRelative } from "./path.ts";
import type { ReadCall } from "./schema.ts";
import { DEFAULT_READ_LIMIT, ToolFailure, type ToolSession } from "./types.ts";

const formatFile = (rel: string, text: string, offset: number, limit: number): string => {
  const lines = splitLines(text);
  const shown = page(lines, offset, limit);
  if (shown.past) return `${rel} has ${shown.total} lines; offset ${offset} is past the end.`;
  const width = String(shown.end || 1).length;
  const body = shown.slice
    .map((line, index) => `${String(shown.start + index).padStart(width)}| ${clipLine(line)}`)
    .join("\n");
  const header = `${rel} lines ${shown.start}-${shown.end} of ${shown.total}`;
  const more = shown.end < shown.total ? `\nPass offset ${shown.end + 1} to continue.` : "";
  return body ? `${header}\n${body}${more}` : header;
};

const formatDirectory = (abs: string, rel: string, offset: number, limit: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(abs).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    const ranked: Array<{ readonly label: string; readonly name: string }> = [];
    for (const name of names) {
      const info = yield* fs.stat(join(abs, name)).pipe(Effect.option);
      const label = Option.isNone(info)
        ? "other"
        : info.value.type === "Directory"
          ? "dir"
          : info.value.type === "File"
            ? "file"
            : "other";
      ranked.push({ label, name });
    }
    ranked.sort((a, b) => {
      const rank = (label: string) => (label === "dir" ? 0 : label === "file" ? 1 : 2);
      const byKind = rank(a.label) - rank(b.label);
      return byKind === 0 ? a.name.localeCompare(b.name) : byKind;
    });
    const shown = page(ranked, offset, limit);
    if (shown.past) {
      return `${rel} has ${shown.total} entries; offset ${offset} is past the end.`;
    }
    const body = shown.slice.map((entry) => `${entry.label} ${entry.name}`).join("\n");
    const header = `${rel} directory, entries ${shown.start}-${shown.end} of ${shown.total}`;
    const more = shown.end < shown.total ? `\nPass offset ${shown.end + 1} to continue.` : "";
    return body ? `${header}\n${body}${more}` : header;
  });

export const invokeReadFile = (call: ReadCall, cwd: string, session: ToolSession | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const abs = yield* resolveInWorkspace(cwd, call.arguments.path);
    const rel = workspaceRelative(cwd, call.arguments.path);
    const info = yield* fs.stat(abs).pipe(
      Effect.mapError((error) =>
        isMissing(error.message)
          ? new ToolFailure({ message: `File not found: ${rel}` })
          : new ToolFailure({ message: error.message }),
      ),
    );
    const offset = call.arguments.offset ?? 1;
    const limit = call.arguments.limit ?? DEFAULT_READ_LIMIT;
    if (info.type === "Directory") {
      return yield* succeed("read_file", yield* formatDirectory(abs, rel, offset, limit));
    }
    if (info.type !== "File") {
      return yield* Effect.fail(new ToolFailure({ message: `not a readable file: ${rel}` }));
    }
    const text = yield* fs.readFileString(abs, "utf8").pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    if (text.includes("\0")) {
      return yield* Effect.fail(new ToolFailure({ message: `not a UTF-8 text file: ${rel}` }));
    }
    session?.reads.add(rel);
    return yield* succeed("read_file", formatFile(rel, text, offset, limit));
  });
