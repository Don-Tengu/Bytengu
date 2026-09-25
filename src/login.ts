import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { defaultAuthPath } from "./auth/store.ts";
import { loginInstructions, pollDeviceToken, requestDeviceCode, saveLogin } from "./provider/xai.ts";

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
};

export const login = Effect.gen(function* () {
  const device = yield* requestDeviceCode();
  yield* Effect.sync(() => console.error(loginInstructions(device)));
  const tokens = yield* pollDeviceToken(device);
  const path = defaultAuthPath();
  yield* saveLogin(path, tokens);
  yield* Effect.sync(() => console.error(`Signed in to xAI. Later requests use grok-4.7. Credentials are at ${path}`));
});

if (isMainModule()) {
  NodeRuntime.runMain(
    login.pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(error.message);
          process.exit(1);
        }),
      ),
    ),
  );
}
