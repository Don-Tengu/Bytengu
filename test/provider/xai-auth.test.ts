import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { readAuthFile, writeAuthFile } from "../../src/auth/store.ts";
import {
  XAI,
  currentBearer,
  jwtIsExpiring,
  loginInstructions,
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCode,
  type FetchLike,
} from "../../src/provider/xai.ts";

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const device = (): DeviceCode => ({
  deviceCode: "device-secret",
  userCode: "ABCD-1234",
  verificationUri: "https://auth.x.ai/device",
  expiresIn: 60,
  interval: 1,
});

test("auth file roundtrip keeps oauth fields and is owner-readable only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bytengu-auth-"));
  const path = join(dir, "auth.json");
  try {
    await run(
      writeAuthFile(path, {
        default: "xai",
        providers: { xai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 50 } },
      }),
    );
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
    const loaded = await run(readAuthFile(path));
    assert.equal(loaded.default, "xai");
    assert.deepEqual(loaded.providers.xai, {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 50,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login instructions show the code and not tokens", () => {
  const text = loginInstructions(device());
  assert.match(text, /ABCD-1234/);
  assert.match(text, /https:\/\/auth\.x\.ai\/device/);
  assert.doesNotMatch(text, /device-secret/);
});

test("device login asks xAI with the bytengu referrer", async () => {
  let body = "";
  const fetchImpl: FetchLike = async (_url, init) => {
    body = String(init.body);
    return jsonResponse({
      device_code: "device-secret",
      user_code: "ABCD-1234",
      verification_uri: "https://auth.x.ai/device",
      expires_in: 60,
      interval: 5,
    });
  };
  const issued = await Effect.runPromise(requestDeviceCode(fetchImpl));
  assert.equal(issued.userCode, "ABCD-1234");
  assert.match(body, /referrer=bytengu/);
});

test("device poll waits through pending and slow_down, then returns tokens", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "authorization_pending" }, 400);
    if (calls === 2) return jsonResponse({ error: "slow_down" }, 400);
    return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
  };
  const tokens = await Effect.runPromise(
    pollDeviceToken(device(), {
      fetch: fetchImpl,
      sleep: (ms) => Effect.sync(() => sleeps.push(ms)),
      now: () => 0,
    }),
  );
  assert.deepEqual(tokens, { access: "access-token", refresh: "refresh-token", expires: 3_600_000 });
  assert.deepEqual(sleeps, [4_000, 9_000]);
});

test("device poll stops when the code expires", async () => {
  let nowMs = 0;
  const fetchImpl: FetchLike = async () => jsonResponse({ error: "authorization_pending" }, 400);
  await assert.rejects(
    () =>
      Effect.runPromise(
        pollDeviceToken(
          { ...device(), expiresIn: 1 },
          {
            fetch: fetchImpl,
            now: () => nowMs,
            sleep: (ms) =>
              Effect.sync(() => {
                nowMs += ms;
              }),
          },
        ),
      ),
    /timed out/,
  );
});

test("bearer uses a fresh oauth token, refreshes an expiring one, and otherwise asks for login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bytengu-auth-"));
  const path = join(dir, "auth.json");
  try {
    await run(
      writeAuthFile(path, {
        providers: { xai: { type: "oauth", access: "fresh-access", refresh: "refresh-token", expires: 10_000_000 } },
      }),
    );
    assert.equal(await run(currentBearer({ env: {}, path, now: () => 1_000 })), "fresh-access");

    await run(
      writeAuthFile(path, {
        providers: { xai: { type: "oauth", access: "old-access", refresh: "refresh-token", expires: 1_000 } },
      }),
    );
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    assert.equal(await run(currentBearer({ env: {}, path, fetch: fetchImpl, now: () => 1_000 })), "new-access");
    const saved = await run(readAuthFile(path));
    assert.equal(saved.default, "xai");
    assert.equal(saved.providers.xai?.type === "oauth" ? saved.providers.xai.refresh : "", "new-refresh");

    await run(writeAuthFile(path, { providers: {} }));
    assert.equal(await run(currentBearer({ env: { XAI_API_KEY: "env-key" }, path })), "env-key");
    await assert.rejects(() => run(currentBearer({ env: {}, path })), /bun run login/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fixed model is grok-4.7", () => {
  assert.equal(XAI.model, "grok-4.7");
  assert.equal(XAI.baseUrl, "https://api.x.ai/v1");
});

test("a JWT expiring inside two minutes is treated as expired", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 10 })).toString("base64url");
  assert.equal(jwtIsExpiring(`aaa.${payload}.sig`, 0), true);
  assert.equal(jwtIsExpiring("not-a-jwt", 0), false);
});
