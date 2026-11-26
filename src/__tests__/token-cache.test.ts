/**
 * The access-token cache must only serve a token to the same full credential
 * pair: in gateway mode the caller supplies both the API key and the secret,
 * so a request with the right key and a wrong secret must not get the cached
 * token. All values are made up.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { dattoApiGet } from "../patches.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(): { tokenRequests: () => number } {
  let tokens = 0;
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = url.startsWith(`${DATTO_HOST}/auth/oauth/token`)
      ? (tokens++, { access_token: `token-${tokens}`, token_type: "bearer", expires_in: 3600 })
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { tokenRequests: () => tokens };
}

describe("access-token cache", () => {
  it("reuses a token for the same key and secret", async () => {
    const s = stub();
    const creds = { apiKey: "cache-key-1", apiSecretKey: "secret-a", platform: "concord" as const };
    await dattoApiGet(creds, "/v2/x");
    await dattoApiGet(creds, "/v2/x");
    expect(s.tokenRequests()).toBe(1);
  });

  it("does not serve a cached token to the same key with a different secret", async () => {
    const s = stub();
    await dattoApiGet({ apiKey: "cache-key-2", apiSecretKey: "secret-a", platform: "concord" }, "/v2/x");
    await dattoApiGet({ apiKey: "cache-key-2", apiSecretKey: "wrong-secret", platform: "concord" }, "/v2/x");
    expect(s.tokenRequests()).toBe(2);
  });
});

describe("429 response bodies", () => {
  /** A 429 whose body records whether it was cancelled (and never ends on its own). */
  function tooMany(onCancel: () => void): Response {
    return new Response(new ReadableStream<Uint8Array>({ start() {}, cancel: onCancel }), {
      status: 429,
      headers: { "Retry-After": "20" },
    });
  }

  it("cancels the body of a 429 on a direct GET", async () => {
    let cancelled = false;
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
        return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 3600 }), { status: 200 });
      }
      return tooMany(() => {
        cancelled = true;
      });
    }) as typeof fetch;
    await expect(dattoApiGet({ apiKey: "body-key-1", apiSecretKey: "s", platform: "concord" }, "/v2/x")).rejects.toThrow(/429/);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  it("cancels the body of a 429 on the token exchange", async () => {
    let cancelled = false;
    globalThis.fetch = vi.fn(async () =>
      tooMany(() => {
        cancelled = true;
      })
    ) as typeof fetch;
    await expect(dattoApiGet({ apiKey: "body-key-2", apiSecretKey: "s", platform: "concord" }, "/v2/x")).rejects.toThrow(/429/);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
});
