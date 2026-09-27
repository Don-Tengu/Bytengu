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
