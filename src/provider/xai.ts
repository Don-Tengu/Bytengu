import { randomUUID } from "node:crypto";
import { defaultAuthPath, readAuthFile, writeAuthFile, type AuthFile, type StoredOAuth } from "../auth/store.ts";

/** Public Grok CLI device-code client. xAI does not issue a Bytengu client id. */
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

export const XAI = {
  id: "xai",
  label: "xAI",
  baseUrl: "https://api.x.ai/v1",
  model: "grok-4.7",
} as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type DeviceCode = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn?: number;
  readonly interval?: number;
};

export type TokenSet = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
};

type DeviceTokenError = {
  readonly error?: string;
  readonly error_description?: string;
};

const authHeaders = (): Record<string, string> => ({
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "User-Agent": "bytengu/0.1.0",
});

const positiveSecondsToMs = (value: unknown, defaultMs: number): number => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const accessTokenIsExpiring = (
  expires: number,
  now: number,
  skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean => !expires || expires - now <= skewMs;

/** Unsigned JWT exp check. Opaque tokens return false so the stored expires field decides. */
export const jwtIsExpiring = (token: string, now: number, skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS): boolean => {
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (!payloadPart || parts.length < 2) return false;
  try {
    let payload = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) payload += "=";
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    if (typeof claims !== "object" || claims === null || !("exp" in claims)) return false;
    const exp = claims.exp;
    return typeof exp === "number" && exp * 1000 <= now + Math.max(0, skewMs);
  } catch {
    return false;
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error_description: text };
  }
};

export const requestDeviceCode = async (fetchImpl: FetchLike = fetch): Promise<DeviceCode> => {
  const response = await fetchImpl(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: "bytengu",
    }).toString(),
  });
  const json = (await readJson(response)) as Partial<DeviceCode> & {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
  };
  if (!response.ok || !json.device_code || !json.user_code || !json.verification_uri) {
    const detail = json.error_description ?? "";
    throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    ...(json.verification_uri_complete ? { verificationUriComplete: json.verification_uri_complete } : {}),
    ...(json.expires_in !== undefined ? { expiresIn: json.expires_in } : {}),
    ...(json.interval !== undefined ? { interval: json.interval } : {}),
  };
};

export const loginInstructions = (device: DeviceCode): string =>
  [
    "用瀏覽器登入 Grok，然後輸入這組短碼。",
    device.verificationUriComplete ?? device.verificationUri,
    `短碼: ${device.userCode}`,
  ].join("\n");

export const pollDeviceToken = async (
  device: DeviceCode,
  options: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenSet> => {
  const fetchImpl = options.fetch ?? fetch;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + positiveSecondsToMs(device.expiresIn, DEVICE_CODE_DEFAULT_EXPIRES_MS);
  let intervalMs = Math.max(positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS), DEVICE_CODE_MIN_INTERVAL_MS);

  while (now() < deadline) {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
      }).toString(),
    });
    const json = (await readJson(response)) as DeviceTokenError & {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (response.ok && json.access_token && json.refresh_token) {
      return {
        access: json.access_token,
        refresh: json.refresh_token,
        expires: now() + (json.expires_in ?? 3600) * 1000,
      };
    }
    const remaining = Math.max(0, deadline - now());
    if (json.error === "authorization_pending") {
      await wait(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (json.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await wait(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (json.error === "access_denied" || json.error === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (json.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run login");
    }
    const detail = json.error_description ?? json.error ?? "";
    throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  throw new Error("xAI device authorization timed out");
};

export const refreshAccessToken = async (refreshToken: string, fetchImpl: FetchLike = fetch): Promise<TokenSet> => {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  const json = (await readJson(response)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    const detail = json.error_description ?? "";
    throw new Error(`xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token || refreshToken,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
};

const shouldRefresh = (stored: StoredOAuth, now: number): boolean =>
  accessTokenIsExpiring(stored.expires, now) || jwtIsExpiring(stored.access, now);

let refreshInFlight: Promise<StoredOAuth> | undefined;

const saveOAuth = async (path: string, next: TokenSet): Promise<StoredOAuth> => {
  const file = await readAuthFile(path);
  const stored: StoredOAuth = { type: "oauth", access: next.access, refresh: next.refresh, expires: next.expires };
  const providers = { ...file.providers, [XAI.id]: stored };
  await writeAuthFile(path, { default: XAI.id, providers });
  return stored;
};

export const currentBearer = async (options?: {
  env?: NodeJS.ProcessEnv;
  path?: string;
  fetch?: FetchLike;
  now?: () => number;
}): Promise<string> => {
  const env = options?.env ?? process.env;
  const path = options?.path ?? defaultAuthPath();
  const fetchImpl = options?.fetch ?? fetch;
  const now = options?.now ?? (() => Date.now());
  const fromEnv = env.XAI_API_KEY?.trim();
  const file = await readAuthFile(path);
  const stored = file.providers[XAI.id];
  if (stored?.type === "oauth") {
    if (!shouldRefresh(stored, now())) return stored.access;
    if (!refreshInFlight) {
      const refreshToken = stored.refresh;
      refreshInFlight = refreshAccessToken(refreshToken, fetchImpl)
        .then((tokens) => saveOAuth(path, tokens))
        .finally(() => {
          refreshInFlight = undefined;
        });
    }
    return (await refreshInFlight).access;
  }
  if (stored?.type === "api") return stored.key;
  if (fromEnv) return fromEnv;
  throw new Error("No xAI login. Run: bun run login");
};

export const sessionConfig = async (
  options?: { env?: NodeJS.ProcessEnv; path?: string; fetch?: FetchLike; now?: () => number },
): Promise<{ baseUrl: string; model: string; apiKey: string; headers: Record<string, string> }> => ({
  baseUrl: XAI.baseUrl,
  model: XAI.model,
  apiKey: await currentBearer(options),
  headers: { "x-grok-conv-id": randomUUID() },
});

export const saveLogin = async (path: string, tokens: TokenSet, existing?: AuthFile): Promise<void> => {
  const file = existing ?? (await readAuthFile(path));
  await writeAuthFile(path, {
    default: XAI.id,
    providers: {
      ...file.providers,
      [XAI.id]: { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires },
    },
  });
};
