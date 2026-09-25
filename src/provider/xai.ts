import { randomUUID } from "node:crypto";
import { Deferred, Effect, FiberId } from "effect";
import {
  AuthError,
  defaultAuthPath,
  readAuthFile,
  writeAuthFile,
  type AuthFile,
  type StoredOAuth,
} from "../auth/store.ts";

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

type Clock = {
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Effect.Effect<void>;
  readonly now?: () => number;
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

const readJson = (response: Response) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => response.text());
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { error_description: text };
    }
  });

const postForm = (url: string, body: URLSearchParams, fetchImpl: FetchLike) =>
  Effect.tryPromise({
    try: () =>
      fetchImpl(url, {
        method: "POST",
        headers: authHeaders(),
        body: body.toString(),
      }),
    catch: (cause) => new AuthError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

export const requestDeviceCode = (fetchImpl: FetchLike = fetch) =>
  Effect.gen(function* () {
    const response = yield* postForm(
      DEVICE_AUTHORIZATION_URL,
      new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE, referrer: "bytengu" }),
      fetchImpl,
    );
    const json = (yield* readJson(response)) as Partial<DeviceCode> & {
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
      return yield* new AuthError({
        message: `xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      });
    }
    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      ...(json.verification_uri_complete ? { verificationUriComplete: json.verification_uri_complete } : {}),
      ...(json.expires_in !== undefined ? { expiresIn: json.expires_in } : {}),
      ...(json.interval !== undefined ? { interval: json.interval } : {}),
    } satisfies DeviceCode;
  });

export const loginInstructions = (device: DeviceCode): string =>
  [
    "Sign in to Grok in the browser, then enter this code.",
    device.verificationUriComplete ?? device.verificationUri,
    `Code: ${device.userCode}`,
  ].join("\n");

export const pollDeviceToken = (device: DeviceCode, options: Clock = {}) =>
  Effect.gen(function* () {
    const fetchImpl = options.fetch ?? fetch;
    const wait = options.sleep ?? ((ms: number) => Effect.sleep(ms));
    const now = options.now ?? (() => Date.now());
    const deadline = now() + positiveSecondsToMs(device.expiresIn, DEVICE_CODE_DEFAULT_EXPIRES_MS);
    let intervalMs = Math.max(
      positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
      DEVICE_CODE_MIN_INTERVAL_MS,
    );

    while (now() < deadline) {
      const response = yield* postForm(
        TOKEN_URL,
        new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
        }),
        fetchImpl,
      );
      const json = (yield* readJson(response)) as DeviceTokenError & {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (response.ok && json.access_token && json.refresh_token) {
        return {
          access: json.access_token,
          refresh: json.refresh_token,
          expires: now() + (json.expires_in ?? 3600) * 1000,
        } satisfies TokenSet;
      }
      const remaining = Math.max(0, deadline - now());
      if (json.error === "authorization_pending") {
        yield* wait(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
        continue;
      }
      if (json.error === "slow_down") {
        intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
        yield* wait(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
        continue;
      }
      if (json.error === "access_denied" || json.error === "authorization_denied") {
        return yield* new AuthError({ message: "xAI device authorization was denied" });
      }
      if (json.error === "expired_token") {
        return yield* new AuthError({ message: "xAI device code expired - please re-run login" });
      }
      const detail = json.error_description ?? json.error ?? "";
      return yield* new AuthError({
        message: `xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`,
      });
    }
    return yield* new AuthError({ message: "xAI device authorization timed out" });
  });

export const refreshAccessToken = (refreshToken: string, fetchImpl: FetchLike = fetch) =>
  Effect.gen(function* () {
    const response = yield* postForm(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      fetchImpl,
    );
    const json = (yield* readJson(response)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!response.ok || !json.access_token) {
      const detail = json.error_description ?? "";
      return yield* new AuthError({
        message: `xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`,
      });
    }
    return {
      access: json.access_token,
      refresh: json.refresh_token || refreshToken,
      expires: Date.now() + (json.expires_in ?? 3600) * 1000,
    } satisfies TokenSet;
  });

const shouldRefresh = (stored: StoredOAuth, now: number): boolean =>
  accessTokenIsExpiring(stored.expires, now) || jwtIsExpiring(stored.access, now);

let refreshInFlight: Deferred.Deferred<StoredOAuth, AuthError> | undefined;

const saveOAuth = (path: string, next: TokenSet) =>
  Effect.gen(function* () {
    const file = yield* readAuthFile(path);
    const stored: StoredOAuth = {
      type: "oauth",
      access: next.access,
      refresh: next.refresh,
      expires: next.expires,
    };
    yield* writeAuthFile(path, { default: XAI.id, providers: { ...file.providers, [XAI.id]: stored } });
    return stored;
  });

const refreshShared = (path: string, refreshToken: string, fetchImpl: FetchLike) =>
  Effect.gen(function* () {
    if (refreshInFlight) return yield* Deferred.await(refreshInFlight);
    const deferred = Deferred.unsafeMake<StoredOAuth, AuthError>(FiberId.none);
    refreshInFlight = deferred;
    return yield* refreshAccessToken(refreshToken, fetchImpl).pipe(
      Effect.flatMap((tokens) => saveOAuth(path, tokens)),
      Effect.mapError((cause) => (cause instanceof AuthError ? cause : new AuthError({ message: cause.message }))),
      Effect.tap((stored) => Deferred.succeed(deferred, stored)),
      Effect.tapError((error) => Deferred.fail(deferred, error)),
      Effect.ensuring(
        Effect.sync(() => {
          if (refreshInFlight === deferred) refreshInFlight = undefined;
        }),
      ),
    );
  });

export const currentBearer = (options?: Clock & { env?: NodeJS.ProcessEnv; path?: string }) =>
  Effect.gen(function* () {
    const env = options?.env ?? process.env;
    const path = options?.path ?? defaultAuthPath();
    const fetchImpl = options?.fetch ?? fetch;
    const now = options?.now ?? (() => Date.now());
    const fromEnv = env.XAI_API_KEY?.trim();
    const file = yield* readAuthFile(path);
    const stored = file.providers[XAI.id];
    if (stored?.type === "oauth") {
      if (!shouldRefresh(stored, now())) return stored.access;
      return (yield* refreshShared(path, stored.refresh, fetchImpl)).access;
    }
    if (stored?.type === "api") return stored.key;
    if (fromEnv) return fromEnv;
    return yield* new AuthError({ message: "No xAI login. Run: bun run login" });
  });

export const sessionConfig = (options?: Clock & { env?: NodeJS.ProcessEnv; path?: string }) =>
  Effect.gen(function* () {
    return {
      baseUrl: XAI.baseUrl,
      model: XAI.model,
      apiKey: yield* currentBearer(options),
      headers: { "x-grok-conv-id": randomUUID() },
    };
  });

export const saveLogin = (path: string, tokens: TokenSet, existing?: AuthFile) =>
  Effect.gen(function* () {
    const file = existing ?? (yield* readAuthFile(path));
    yield* writeAuthFile(path, {
      default: XAI.id,
      providers: {
        ...file.providers,
        [XAI.id]: { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires },
      },
    });
  });
