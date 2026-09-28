import { homedir } from "node:os";
import { join } from "node:path";

/** Why the one-shot process stopped. The exit code and the closing event use the same value. */
export const STOP_REASONS = ["clean", "error", "step-cap", "repeated-tool"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Fixed process exit table.
 * `0` clean, `1` startup or model error, `2` 30-step cap, `3` repeated tool call.
 */
export const exitCodeFor = (reason: StopReason): number => {
  switch (reason) {
    case "clean":
      return 0;
    case "error":
      return 1;
    case "step-cap":
      return 2;
    case "repeated-tool":
      return 3;
  }
};

export const HEADLESS_FORMATS = ["human", "json"] as const;
export type HeadlessFormat = (typeof HEADLESS_FORMATS)[number];
export const DEFAULT_HEADLESS_FORMAT: HeadlessFormat = "human";

export const isHeadlessFormat = (value: string): value is HeadlessFormat =>
  (HEADLESS_FORMATS as readonly string[]).includes(value);

export type HeadlessEvent =
  | { readonly type: "step"; readonly step: number }
  | { readonly type: "tool"; readonly name: string; readonly ok: boolean }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "done"; readonly reason: StopReason };

/** One JSON object, no trailing newline. The caller writes the line. */
export const headlessLine = (event: HeadlessEvent): string => JSON.stringify(event);

/** Append-only tool log. One file directly under the process home, not auth.json. */
export const auditLogPath = (): string => join(homedir(), ".bytengu", "audit.log");

export type AuditFields = {
  readonly time: string;
  readonly profile: string;
  readonly cwd: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly reason: StopReason;
};

/** One audit record and its trailing newline. No arguments, output, or tokens. */
export const auditLine = (fields: AuditFields): string =>
  `${JSON.stringify({
    time: fields.time,
    profile: fields.profile,
    cwd: fields.cwd,
    tool: fields.tool,
    ok: fields.ok,
    reason: fields.reason,
  })}\n`;
