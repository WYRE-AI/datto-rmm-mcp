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
