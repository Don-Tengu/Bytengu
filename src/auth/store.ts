import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredOAuth = {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
};

export type StoredApiKey = {
  readonly type: "api";
  readonly key: string;
};

export type StoredAuth = StoredOAuth | StoredApiKey;

export type AuthFile = {
  readonly default?: string;
  readonly providers: Readonly<Record<string, StoredAuth>>;
};

export const defaultAuthPath = (): string => join(homedir(), ".bytengu", "auth.json");

const emptyAuth = (): AuthFile => ({ providers: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStored = (value: unknown): StoredAuth | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string") {
    const expires = typeof value.expires === "number" ? value.expires : 0;
    return { type: "oauth", access: value.access, refresh: value.refresh, expires };
  }
  if (value.type === "api" && typeof value.key === "string" && value.key.length > 0) {
    return { type: "api", key: value.key };
  }
  return undefined;
};

export const parseAuthFile = (text: string): AuthFile => {
  const json: unknown = JSON.parse(text);
  if (!isRecord(json)) return emptyAuth();
  const providers: Record<string, StoredAuth> = {};
  if (isRecord(json.providers)) {
    for (const [id, value] of Object.entries(json.providers)) {
      const stored = parseStored(value);
      if (stored) providers[id] = stored;
    }
  }
  const fallback = typeof json.default === "string" ? json.default : undefined;
  return fallback ? { default: fallback, providers } : { providers };
};

const isEnoent = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export const readAuthFile = async (path: string): Promise<AuthFile> => {
  try {
    return parseAuthFile(await readFile(path, "utf8"));
  } catch (cause) {
    if (isEnoent(cause)) return emptyAuth();
    throw cause;
  }
};

export const writeAuthFile = async (path: string, file: AuthFile): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};
