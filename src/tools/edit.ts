import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { isMissing, splitLines, succeed } from "./output.ts";
import { resolveInWorkspace, workspaceRelative } from "./path.ts";
import type { EditCall } from "./schema.ts";
import { MAX_DIFF_LINES, ToolFailure, type ToolSession } from "./types.ts";

const manualDiff = (rel: string, before: string, after: string): string => {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldLines.slice(start, oldEnd + 1);
  const added = newLines.slice(start, newEnd + 1);
  if (removed.length + added.length > MAX_DIFF_LINES) {
    return [
      `--- a/${rel}`,
      `+++ b/${rel}`,
      `@@ edited ${removed.length} lines into ${added.length} lines @@`,
    ].join("\n");
  }
  const context = 3;
  const oldFrom = Math.max(0, start - context);
  const oldTo = Math.min(oldLines.length, oldEnd + 1 + context);
  const newFrom = Math.max(0, start - context);
  const newTo = Math.min(newLines.length, newEnd + 1 + context);
  const body = [
    ...oldLines.slice(oldFrom, start).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...oldLines.slice(oldEnd + 1, oldTo).map((line) => ` ${line}`),
  ];
  const header = `@@ -${oldFrom + 1},${oldTo - oldFrom} +${newFrom + 1},${newTo - newFrom} @@`;
  return [`--- a/${rel}`, `+++ b/${rel}`, header, ...body].join("\n");
};

const replaceExact = (content: string, oldString: string, newString: string, replaceAll: boolean): string => {
  if (oldString === newString) {
    throw new Error("No changes to apply: old_string and new_string are identical.");
  }
  if (oldString === "") {
    throw new Error(
      "old_string cannot be empty when editing an existing file. Provide the exact text to replace, or use write_file for an intentional full-file replacement.",
    );
  }
  const first = content.indexOf(oldString);
  if (first === -1) {
    throw new Error(
      "Could not find old_string in the file. It must match exactly, including whitespace, indentation, and line endings.",
    );
  }
  const another = content.indexOf(oldString, first + oldString.length);
  if (!replaceAll && another !== -1) {
    throw new Error(
      "Found multiple matches for old_string. Provide more surrounding lines in old_string to identify the correct match.",
    );
  }
  return replaceAll
    ? content.replaceAll(oldString, newString)
    : content.slice(0, first) + newString + content.slice(first + oldString.length);
};

export const invokeEdit = (call: EditCall, cwd: string, session: ToolSession | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const abs = yield* resolveInWorkspace(cwd, call.arguments.path);
    const rel = workspaceRelative(cwd, call.arguments.path);
    if (session && !session.reads.has(rel)) {
      return yield* Effect.fail(
        new ToolFailure({ message: `You must use read_file on ${rel} before editing it.` }),
      );
    }
    const info = yield* fs.stat(abs).pipe(
      Effect.mapError((error) =>
        isMissing(error.message)
          ? new ToolFailure({
              message: `File not found: ${rel}. Use write_file to create a new file.`,
            })
          : new ToolFailure({ message: error.message }),
      ),
    );
    if (info.type === "Directory") {
      return yield* Effect.fail(new ToolFailure({ message: `path is a directory: ${rel}` }));
    }
    if (info.type !== "File") {
      return yield* Effect.fail(new ToolFailure({ message: `not a readable file: ${rel}` }));
    }
    const before = yield* fs.readFileString(abs, "utf8").pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    const after = yield* Effect.try({
      try: () =>
        replaceExact(before, call.arguments.old_string, call.arguments.new_string, call.arguments.replace_all ?? false),
      catch: (cause) => new ToolFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
    yield* fs.writeFileString(abs, after).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    return yield* succeed("edit", `edited ${rel}\n${manualDiff(rel, before, after)}`);
  });
