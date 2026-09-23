import { execFile } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { clipLine, splitLines, succeed } from "./output.ts";
import { isInside, resolveInWorkspace, toPosix, workspaceReal, workspaceRelative } from "./path.ts";
import type { GlobCall, GrepCall } from "./schema.ts";
import { MAX_BUFFER, MAX_MATCHES, MAX_WALK_FILES, ToolFailure, type ExecFailure, type ExecSuccess } from "./types.ts";

const execFileAsync = promisify(execFile);

type RgRun =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly message: string };

let ripgrep: boolean | undefined;

const runRg = (args: readonly string[], cwd: string, timeout: number) => {
  // Tests set BYTENGU_NO_RG to force the Node walk. ripgrep is otherwise preferred.
  if (process.env.BYTENGU_NO_RG === "1" || ripgrep === false) {
    return Effect.succeed<RgRun>({ kind: "missing" });
  }
  return Effect.tryPromise({
    try: () =>
      execFileAsync("rg", [...args], {
        encoding: "utf8",
        cwd,
        timeout,
        maxBuffer: MAX_BUFFER,
      }) as Promise<ExecSuccess>,
    catch: (err) => err as ExecFailure,
  }).pipe(
    Effect.match({
      onSuccess: ({ stdout }): RgRun => {
        ripgrep = true;
        return { kind: "ok", stdout };
      },
      onFailure: (err): RgRun => {
        if (err.code === "ENOENT") {
          ripgrep = false;
          return { kind: "missing" };
        }
        ripgrep = true;
        if (err.code === 1) return { kind: "none" };
        if (err.killed || err.code === "ETIMEDOUT") {
          return { kind: "error", message: `search timed out after ${timeout}ms` };
        }
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return { kind: "error", message: "search output exceeded 1MB; narrow the path" };
        }
        const stderr = (err.stderr ?? "").trim();
        return { kind: "error", message: stderr || `search failed (${String(err.code)})` };
      },
    }),
  );
};

const capMatches = (lines: readonly string[], noun: string): string => {
  if (lines.length === 0) return "no matches";
  if (lines.length <= MAX_MATCHES) return lines.join("\n");
  return `${lines.slice(0, MAX_MATCHES).join("\n")}\n...[${lines.length - MAX_MATCHES} more ${noun} omitted]`;
};

const compileRegex = (pattern: string) =>
  Effect.try({
    try: () => new RegExp(pattern),
    catch: (cause) =>
      new ToolFailure({ message: `invalid regex: ${cause instanceof Error ? cause.message : String(cause)}` }),
  });

const globToRegExp = (pattern: string): RegExp => {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char?.replace(/[.+^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  return new RegExp(`^${source}$`);
};

const matchGlob = (rel: string, pattern: string): boolean => {
  if (globToRegExp(pattern).test(rel)) return true;
  if (pattern.includes("/")) return false;
  const base = rel.split("/").at(-1) ?? rel;
  return globToRegExp(pattern).test(base);
};

const walkFiles = (root: string, dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: string[] = [];
    let visited = 0;
    let truncated = false;
    const visit = (current: string): Effect.Effect<void, ToolFailure, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        if (truncated) return;
        const names = yield* fs.readDirectory(current).pipe(
          Effect.mapError((error) => new ToolFailure({ message: error.message })),
        );
        for (const name of names) {
          if (truncated) return;
          if (name === "node_modules" || name.startsWith(".")) continue;
          const abs = join(current, name);
          const real = yield* fs.realPath(abs).pipe(Effect.option);
          if (Option.isNone(real) || !isInside(root, real.value)) continue;
          const info = yield* fs.stat(real.value).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") {
            yield* visit(real.value);
            continue;
          }
          if (info.value.type !== "File") continue;
          visited += 1;
          if (visited > MAX_WALK_FILES) {
            truncated = true;
            return;
          }
          const rel = relative(root, real.value);
          if (rel.startsWith("..") || isAbsolute(rel)) continue;
          found.push(toPosix(rel));
        }
      });
    yield* visit(dir);
    return { found, truncated };
  });

const grepText = (abs: string, text: string, pattern: RegExp, cwd: string): string => {
  if (text.includes("\0")) return "no matches";
  const shown = workspaceRelative(cwd, abs);
  const matches: string[] = [];
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!pattern.test(line)) continue;
    matches.push(`${shown}:${index + 1}:${clipLine(line)}`);
    if (matches.length > MAX_MATCHES) break;
  }
  return capMatches(matches, "matches");
};

const nodeGrep = (root: string, dir: string, pattern: RegExp, displayRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { found, truncated } = yield* walkFiles(root, dir);
    const matches: string[] = [];
    let oversized = 0;
    for (const rel of found) {
      if (matches.length > MAX_MATCHES) break;
      const abs = join(root, rel);
      const info = yield* fs.stat(abs).pipe(Effect.option);
      if (Option.isNone(info) || Number(info.value.size) > MAX_BUFFER) {
        oversized += 1;
        continue;
      }
      const text = yield* fs.readFileString(abs, "utf8").pipe(Effect.orElseSucceed(() => ""));
      if (text.includes("\0")) continue;
      const lines = splitLines(text);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!pattern.test(line)) continue;
        const shown = workspaceRelative(displayRoot, abs);
        matches.push(`${shown}:${index + 1}:${clipLine(line)}`);
        if (matches.length > MAX_MATCHES) break;
      }
    }
    const note = [
      truncated ? `walk stopped after ${MAX_WALK_FILES} files` : "",
      oversized > 0 ? `skipped ${oversized} files larger than 1MB` : "",
    ].filter(Boolean);
    const body = capMatches(matches.slice(0, MAX_MATCHES + 1), "matches");
    return note.length === 0 ? body : `${body}\n...[${note.join("; ")}]`;
  });

const nodeGlob = (root: string, dir: string, pattern: string) =>
  Effect.gen(function* () {
    const { found, truncated } = yield* walkFiles(root, dir);
    const matches = found.filter((rel) => matchGlob(rel, pattern)).sort((a, b) => a.localeCompare(b));
    const body = capMatches(matches, "files");
    return truncated ? `${body}\n...[walk stopped after ${MAX_WALK_FILES} files]` : body;
  });

const searchRoot = (cwd: string, userPath: string | undefined) =>
  Effect.gen(function* () {
    const requested = userPath ?? ".";
    const abs = yield* resolveInWorkspace(cwd, requested);
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(abs).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    return { abs, info, rel: workspaceRelative(cwd, requested) };
  });

export const invokeGrep = (call: GrepCall, cwd: string, timeout: number) =>
  Effect.gen(function* () {
    const root = yield* searchRoot(cwd, call.arguments.path);
    const rg = yield* runRg(
      [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--glob",
        "!.git/**",
        "--glob",
        "!node_modules/**",
        "--",
        call.arguments.pattern,
        root.abs,
      ],
      resolve(cwd),
      timeout,
    );
    if (rg.kind === "error") return yield* Effect.fail(new ToolFailure({ message: rg.message }));
    if (rg.kind === "none") return yield* succeed("grep", "no matches");
    if (rg.kind === "ok") {
      // rg prints the absolute path we passed. The model needs a workspace-relative path.
      const rewritten = rg.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = /^(.*?):(\d+):(.*)$/.exec(line);
          if (!match?.[1] || !match[2]) return line;
          return `${workspaceRelative(cwd, match[1])}:${match[2]}:${clipLine(match[3] ?? "")}`;
        });
      return yield* succeed("grep", capMatches(rewritten, "matches"));
    }
    const regex = yield* compileRegex(call.arguments.pattern);
    if (root.info.type === "File") {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(root.abs, "utf8").pipe(
        Effect.mapError((error) => new ToolFailure({ message: error.message })),
      );
      return yield* succeed("grep", grepText(root.abs, text, regex, cwd));
    }
    const real = yield* workspaceReal(cwd);
    const body = yield* nodeGrep(real, root.abs, regex, cwd);
    return yield* succeed("grep", body);
  });

export const invokeGlob = (call: GlobCall, cwd: string, timeout: number) =>
  Effect.gen(function* () {
    const root = yield* searchRoot(cwd, call.arguments.path);
    if (root.info.type !== "Directory") {
      return yield* Effect.fail(new ToolFailure({ message: `glob path is not a directory: ${root.rel}` }));
    }
    const rg = yield* runRg(
      [
        "--files",
        "--color",
        "never",
        "--glob",
        "!.git/**",
        "--glob",
        "!node_modules/**",
        "--glob",
        call.arguments.pattern,
        root.abs,
      ],
      resolve(cwd),
      timeout,
    );
    if (rg.kind === "error") return yield* Effect.fail(new ToolFailure({ message: rg.message }));
    if (rg.kind === "none") return yield* succeed("glob", "no matches");
    if (rg.kind === "ok") {
      const paths = rg.stdout
        .split("\n")
        .filter(Boolean)
        .map((file) => workspaceRelative(cwd, file))
        .sort((a, b) => a.localeCompare(b));
      return yield* succeed("glob", capMatches(paths, "files"));
    }
    const real = yield* workspaceReal(cwd);
    const body = yield* nodeGlob(real, root.abs, call.arguments.pattern);
    return yield* succeed("glob", body);
  });
