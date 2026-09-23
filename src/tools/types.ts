import { Data } from "effect";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_READ_LIMIT = 200;
export const DOOM_LOOP_THRESHOLD = 3;

export const MAX_BUFFER = 1024 * 1024;
export const MAX_OUTPUT = 20_000;
export const MAX_LINE_LENGTH = 2_000;
export const MAX_READ_LIMIT = 2_000;
export const MAX_MATCHES = 100;
export const MAX_WALK_FILES = 4_000;
export const MAX_DIFF_LINES = 80;

/**
 * Expected tool failure: bad arguments, a path outside the workspace, or an
 * I/O error. Bash timeouts and non-zero exits are not this — the model has to
 * see those as ordinary output.
 */
export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  readonly message: string;
}> {}

export type ToolName = "read_file" | "write_file" | "edit" | "grep" | "glob" | "bash";

export type Ok = {
  readonly ok: true;
  readonly name: ToolName;
  readonly output: string;
};
export type Result =
  | Ok
  | {
      readonly ok: false;
      readonly error: string;
    };

/** Paths successfully read in this conversation. edit refuses a file that is not here. */
export type ToolSession = {
  readonly reads: Set<string>;
};

export type RepeatStreak = {
  readonly signature: string;
  readonly count: number;
};

export type OrderedToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

export type ToolBatch = {
  readonly results: ReadonlyArray<{ readonly tool_call_id: string; readonly result: Result }>;
  readonly streak: RepeatStreak;
  readonly stopped: boolean;
};

export type ExecSuccess = { readonly stdout: string; readonly stderr: string };
export type ExecFailure = {
  readonly killed?: boolean;
  readonly code?: string | number;
  readonly stdout?: string;
  readonly stderr?: string;
};

export const emptyStreak = (): RepeatStreak => ({ signature: "", count: 0 });

export const nextStreak = (streak: RepeatStreak, signature: string): RepeatStreak =>
  streak.signature === signature
    ? { signature, count: streak.count + 1 }
    : { signature, count: 1 };

export const isDoomLoop = (streak: RepeatStreak): boolean => streak.count >= DOOM_LOOP_THRESHOLD;
