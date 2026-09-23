import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { succeed } from "./output.ts";
import type { BashCall } from "./schema.ts";
import { MAX_BUFFER, type ExecFailure, type ExecSuccess } from "./types.ts";

const execFileAsync = promisify(execFile);

const formatOutput = (exit: string, stdout: string, stderr: string): string => {
  const body = [stdout, stderr].filter(Boolean).join("\n");
  return body ? `${exit}\n${body}` : exit;
};

export const invokeBash = (call: BashCall, cwd: string, timeout: number) =>
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
    Effect.flatMap((output) => succeed("bash", output)),
  );
