import { dirname } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { succeed } from "./output.ts";
import { resolveInWorkspace, workspaceRelative } from "./path.ts";
import type { WriteCall } from "./schema.ts";
import { ToolFailure } from "./types.ts";

export const invokeWriteFile = (call: WriteCall, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const abs = yield* resolveInWorkspace(cwd, call.arguments.path);
    const rel = workspaceRelative(cwd, call.arguments.path);
    const existing = yield* fs.stat(abs).pipe(Effect.option);
    if (Option.isSome(existing) && existing.value.type === "Directory") {
      return yield* Effect.fail(new ToolFailure({ message: `path is a directory: ${rel}` }));
    }
    yield* fs.makeDirectory(dirname(abs), { recursive: true }).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    yield* fs.writeFileString(abs, call.arguments.content).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    return yield* succeed("write_file", `wrote ${rel}`);
  });
