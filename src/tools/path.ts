import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { ToolFailure } from "./types.ts";

export const isInside = (root: string, target: string): boolean => {
  const rootAbs = resolve(root);
  const targetAbs = resolve(rootAbs, target);
  const rel = relative(rootAbs, targetAbs);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

export const toPosix = (filePath: string): string => filePath.split(sep).join("/");

export const workspaceRelative = (cwd: string, userPath: string): string => {
  const rel = relative(resolve(cwd), resolve(cwd, userPath));
  return rel === "" ? "." : toPosix(rel);
};

export const resolveInWorkspace = (cwd: string, userPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lexicalRoot = resolve(cwd);
    if (!isInside(lexicalRoot, userPath)) {
      return yield* Effect.fail(new ToolFailure({ message: `path escapes workspace: ${userPath}` }));
    }
    const root = yield* fs.realPath(lexicalRoot).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    const abs = resolve(lexicalRoot, userPath);
    const missing: string[] = [];
    let cursor = abs;
    while (true) {
      const exists = yield* fs.stat(cursor).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (exists) break;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      missing.push(basename(cursor));
      cursor = parent;
    }
    const realBase = yield* fs.realPath(cursor).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    const real = missing.length === 0 ? realBase : resolve(realBase, ...missing.toReversed());
    if (!isInside(root, real)) {
      return yield* Effect.fail(new ToolFailure({ message: `path escapes workspace: ${userPath}` }));
    }
    return real;
  });

export const workspaceReal = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(resolve(cwd)).pipe(Effect.orElseSucceed(() => resolve(cwd)));
  });
