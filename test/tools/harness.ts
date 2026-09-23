import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { runTool, type ToolCall, type ToolSession } from "../../src/tools/index.ts";

export const provideFs = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

export const tempWorkspace = (): string => mkdtempSync(join(tmpdir(), "bytengu-tools-"));

export const ok = (call: ToolCall, cwd: string, session?: ToolSession) =>
  provideFs(runTool(call, cwd, 5_000, session));

export const errorOf = (call: ToolCall, cwd: string, session?: ToolSession) =>
  provideFs(
    runTool(call, cwd, 5_000, session).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    ),
  );
