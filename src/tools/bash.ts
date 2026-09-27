import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { succeed } from "./output.ts";
import { DEFAULT_APPROVAL_PROFILE, type ApprovalProfile } from "./profile.ts";
import type { BashCall } from "./schema.ts";
import { MAX_BUFFER, ToolFailure, type ExecFailure, type ExecSuccess } from "./types.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const BASH = "/bin/bash";

// Bash execs a script's last command. The trailing `exit` keeps this shell
// alive so `ps` still sees `sandbox-exec` and a timeout can signal the group.
const SANDBOXED_SHELL = `${SANDBOX_EXEC} -f "$1" ${BASH} -lc "$2"; status=$?; exit "$status"`;

const sbString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Seatbelt profile for one workspace realpath.
 * `/bin/ps` is setuid, so Seatbelt refuses to run it inside the sandbox.
 * That single binary may exec outside. Everything else stays in, and network stays closed.
 */
const seatbelt = (root: string): string => `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow process-exec (literal "/bin/ps") (with no-sandbox))
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm*)
(allow file-read*)
(allow file-map-executable)
(allow file-ioctl)
(allow file-write* (subpath ${sbString(root)}))
(allow file-write* (literal "/dev/null"))
(allow file-write-data (literal "/dev/dtracehelper"))
(deny network*)
(deny system-socket)
`;

const formatOutput = (exit: string, stdout: string, stderr: string): string => {
  const body = [stdout, stderr].filter(Boolean).join("\n");
  return body ? `${exit}\n${body}` : exit;
};

const presentSuccess = (result: ExecSuccess): string => formatOutput("exit 0", result.stdout, result.stderr);

const presentFailure = (timeout: number, failed: ExecFailure): string => {
  const stdout = failed.stdout ?? "";
  const stderr = failed.stderr ?? "";
  if (failed.killed || failed.code === "ETIMEDOUT") {
    return formatOutput(`timed out after ${timeout}ms`, stdout, stderr);
  }
  const code = typeof failed.code === "number" ? failed.code : 1;
  return formatOutput(`exit ${code}`, stdout, stderr);
};

const runCaptured = (file: string, args: readonly string[], cwd: string, timeout: number) =>
  Effect.async<ExecSuccess, ExecFailure>((resume) => {
    const child = spawn(file, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    const err: string[] = [];
    let capturedBytes = 0;
    let settled = false;
    let stop: "timeout" | "overflow" | undefined;

    const snapshot = (): { stdout: string; stderr: string } => ({
      stdout: out.join(""),
      stderr: err.join(""),
    });

    const finish = (effect: Effect.Effect<ExecSuccess, ExecFailure>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resume(effect);
    };

    const killGroup = () => {
      if (child.pid === undefined) {
        child.kill("SIGKILL");
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      stop = "timeout";
      const captured = snapshot();
      killGroup();
      finish(Effect.fail({ killed: true, code: "ETIMEDOUT", ...captured }));
    }, timeout);

    const push = (bucket: string[], chunk: string) => {
      bucket.push(chunk);
      capturedBytes += chunk.length;
      if (stop === undefined && capturedBytes > MAX_BUFFER) {
        stop = "overflow";
        killGroup();
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      push(out, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      push(err, chunk);
    });
    child.once("error", (error) => {
      const captured = snapshot();
      finish(Effect.fail({ code: error.message, ...captured }));
    });
    child.once("close", (code) => {
      const captured = snapshot();
      if (stop === "timeout") {
        finish(Effect.fail({ killed: true, code: "ETIMEDOUT", ...captured }));
        return;
      }
      if (code === 0 && stop === undefined) {
        finish(Effect.succeed(captured));
        return;
      }
      const numeric = typeof code === "number" ? code : 1;
      finish(Effect.fail({ code: numeric, killed: stop === "overflow", ...captured }));
    });

    return Effect.sync(() => {
      clearTimeout(timer);
      killGroup();
    });
  });

const runSandboxed = (command: string, cwd: string, timeout: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = join(tmpdir(), "bytengu-seatbelt");
    const file = join(dir, `${process.pid}-${randomBytes(4).toString("hex")}.sb`);
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    yield* fs.writeFileString(file, seatbelt(cwd)).pipe(
      Effect.mapError((error) => new ToolFailure({ message: error.message })),
    );
    return yield* runCaptured(BASH, ["-c", SANDBOXED_SHELL, "bash", file, command], cwd, timeout).pipe(
      Effect.ensuring(fs.remove(file).pipe(Effect.ignore)),
    );
  });

export const invokeBash = (
  call: BashCall,
  cwd: string,
  timeout: number,
  profile: ApprovalProfile = DEFAULT_APPROVAL_PROFILE,
) =>
  Effect.gen(function* () {
    if (profile === "read-only") {
      return yield* Effect.fail(new ToolFailure({ message: "profile read-only does not allow bash" }));
    }
    const command = call.arguments.command;
    const captured =
      profile === "full"
        ? yield* runCaptured(BASH, ["-lc", command], cwd, timeout).pipe(Effect.either)
        : yield* runSandboxed(command, cwd, timeout).pipe(Effect.either);
    if (captured._tag === "Left") {
      const error = captured.left;
      if (error instanceof ToolFailure) return yield* Effect.fail(error);
      return yield* succeed("bash", presentFailure(timeout, error));
    }
    return yield* succeed("bash", presentSuccess(captured.right));
  });
