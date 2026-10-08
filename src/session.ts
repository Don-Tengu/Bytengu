import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileSystem } from "@effect/platform";
import { Data, Effect } from "effect";

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly message: string;
}> {}

/** One stored turn. Extra provider fields stay on the object. */
export type SessionMessage = { readonly role: string } & Record<string, unknown>;

/** Latest conversation for a workspace. Outside the project, so a tool cannot rewrite it. */
export const sessionDbPath = (): string => join(homedir(), ".bytengu", "bytengu.db");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTurns = (text: string): readonly SessionMessage[] => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SessionError({ message: `session is not valid JSON: ${message}` });
  }
  if (!Array.isArray(json) || json.some((item) => !isRecord(item) || typeof item.role !== "string")) {
    throw new SessionError({ message: "session messages are not a list of role objects" });
  }
  return json as SessionMessage[];
};

const withDb = <A>(use: (db: DatabaseSync) => A) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = sessionDbPath();
    const directory = dirname(path);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.chmod(directory, 0o700);
    const value = yield* Effect.try({
      try: () => {
        const db = new DatabaseSync(path);
        try {
          db.exec("PRAGMA journal_mode = DELETE");
          db.exec(
            `CREATE TABLE IF NOT EXISTS session (
              workspace TEXT PRIMARY KEY,
              messages TEXT NOT NULL
            )`,
          );
          return use(db);
        } finally {
          db.close();
        }
      },
      catch: (cause) =>
        cause instanceof SessionError
          ? cause
          : new SessionError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
    });
    yield* fs.chmod(path, 0o600);
    return value;
  });

/** Missing row and an empty list are both "no session". */
export const loadSession = (workspace: string) =>
  withDb((db) => {
    const row = db.prepare("SELECT messages FROM session WHERE workspace = ?").get(workspace);
    if (!row) return undefined;
    const text = row.messages;
    if (typeof text !== "string") {
      throw new SessionError({ message: "session row is missing messages" });
    }
    const turns = parseTurns(text);
    return turns.length === 0 ? undefined : turns;
  });

/** Replaces the latest session for this workspace. */
export const saveSession = (workspace: string, messages: readonly object[]) =>
  withDb((db) => {
    db.prepare(
      `INSERT INTO session (workspace, messages) VALUES (?, ?)
       ON CONFLICT(workspace) DO UPDATE SET messages = excluded.messages`,
    ).run(workspace, JSON.stringify(messages));
  });
