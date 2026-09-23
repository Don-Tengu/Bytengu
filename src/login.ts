import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultAuthPath } from "./auth/store.ts";
import { loginInstructions, pollDeviceToken, requestDeviceCode, saveLogin } from "./provider/xai.ts";

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
};

export const login = async (): Promise<void> => {
  const device = await requestDeviceCode();
  console.error(loginInstructions(device));
  const tokens = await pollDeviceToken(device);
  const path = defaultAuthPath();
  await saveLogin(path, tokens);
  console.error(`已登入 xAI。之後的請求使用 grok-4.7。憑證在 ${path}`);
};

if (isMainModule()) {
  login().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(message);
    process.exitCode = 1;
  });
}
