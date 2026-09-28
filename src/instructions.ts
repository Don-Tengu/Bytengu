import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";

/** Project instruction text is kept from the start and cut at this length. */
export const INSTRUCTION_CAP = 32_000;

const fileType = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.stat(path).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => undefined),
    );
  });

const isGitRoot = (dir: string) =>
  Effect.gen(function* () {
    const kind = yield* fileType(join(dir, ".git"));
    return kind === "File" || kind === "Directory";
  });

/**
 * Nearest `.git` at or above `start`. With none, the walk stays on `start`
 * and does not read instruction files from ancestors.
 */
const instructionRoot = (start: string) =>
  Effect.gen(function* () {
    let current = start;
    while (true) {
      if (yield* isGitRoot(current)) return current;
      const parent = dirname(current);
      if (parent === current) return start;
      current = parent;
    }
  });

const readText = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    return Option.getOrUndefined(text);
  });

/** `AGENTS.md` when it is a regular file; otherwise `CLAUDE.md` when that is. */
const instructionAt = (dir: string) =>
  Effect.gen(function* () {
    const agents = join(dir, "AGENTS.md");
    if ((yield* fileType(agents)) === "File") return yield* readText(agents);
    const claude = join(dir, "CLAUDE.md");
    if ((yield* fileType(claude)) === "File") return yield* readText(claude);
    return undefined;
  });

/** Nearest-first instruction text from `cwd` through the git root, prefix-capped. */
export const projectInstructions = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const start = yield* fs.realPath(cwd);
    const root = yield* instructionRoot(start);
    const parts: string[] = [];
    let current = start;
    while (true) {
      const text = yield* instructionAt(current);
      if (text) parts.push(text);
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return parts.join("\n\n").slice(0, INSTRUCTION_CAP);
  });
