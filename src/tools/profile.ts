export const APPROVAL_PROFILES = ["read-only", "workspace-write", "full"] as const;

export type ApprovalProfile = (typeof APPROVAL_PROFILES)[number];

export const DEFAULT_APPROVAL_PROFILE: ApprovalProfile = "workspace-write";

const READ_ONLY_BLOCKED: ReadonlySet<string> = new Set(["bash", "edit", "write_file"]);

export const isApprovalProfile = (value: string): value is ApprovalProfile =>
  (APPROVAL_PROFILES as readonly string[]).includes(value);

/** `read-only` refuses mutating tools before a process starts. Other profiles do not. */
export const readOnlyRefusal = (profile: ApprovalProfile, tool: string): string | undefined =>
  profile === "read-only" && READ_ONLY_BLOCKED.has(tool)
    ? `profile read-only does not allow ${tool}`
    : undefined;

/** One-shot `--mode`. Omitting the flag is today's editing run, not a named mode. */
export const CHAT_MODES = ["plan"] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

export const isChatMode = (value: string): value is ChatMode =>
  (CHAT_MODES as readonly string[]).includes(value);

const PLAN_BLOCKED: ReadonlySet<string> = new Set(["bash", "edit", "write_file"]);

/** Plan mode refuses mutating tools before a write or a child process. Every profile. */
export const planModeRefusal = (mode: ChatMode | undefined, tool: string): string | undefined =>
  mode === "plan" && PLAN_BLOCKED.has(tool) ? `plan mode does not allow ${tool}` : undefined;
