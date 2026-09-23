import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FileSystem } from "@effect/platform";
import { Data, Effect, Either } from "effect";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

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
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new AuthError({ message: `auth file is not valid JSON: ${message}` });
  }
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

const missingFile = (error: { readonly _tag: string; readonly reason?: string }): boolean =>
  error._tag === "SystemError" && error.reason === "NotFound";

export const readAuthFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.either);
    if (Either.isLeft(text)) {
      if (missingFile(text.left)) return emptyAuth();
      return yield* Effect.fail(text.left);
    }
    return yield* Effect.try({
      try: () => parseAuthFile(text.right),
      catch: (cause) => (cause instanceof AuthError ? cause : new AuthError({ message: String(cause) })),
    });
  });

export const writeAuthFile = (path: string, file: AuthFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = dirname(path);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.chmod(directory, 0o700);
    yield* fs.writeFileString(path, `${JSON.stringify(file, null, 2)}\n`);
    yield* fs.chmod(path, 0o600);
  });
