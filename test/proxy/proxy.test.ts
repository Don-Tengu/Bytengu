import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { isBun, proxiedFetch, proxyUrl } from "../../src/proxy.ts";

const proxyKeys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;

const withProxyEnv = async (proxy: string, body: () => Promise<void>) => {
  const saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  process.env.HTTPS_PROXY = proxy;
  try {
    await body();
  } finally {
    for (const key of proxyKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("proxyUrl reads HTTPS_PROXY before HTTP_PROXY", async () => {
  await withProxyEnv("http://127.0.0.1:9", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:8";
    assert.equal(proxyUrl(), "http://127.0.0.1:9");
  });
});

test("bun fetch sends CONNECT through HTTPS_PROXY", { skip: !isBun() }, async () => {
  const received = await new Promise<string>((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        socket.end("HTTP/1.1 502 tunnel closed\r\n\r\n");
        resolve(chunk.toString("utf8"));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      void withProxyEnv(`http://127.0.0.1:${address.port}`, async () => {
        await proxiedFetch("https://example.com/chat/completions", {
          method: "POST",
          body: "{}",
        }).catch(() => undefined);
        server.close();
      }).catch(reject);
    });
  });
  assert.match(received, /^CONNECT example.com:443/);
});
