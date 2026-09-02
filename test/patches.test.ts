/**
 * Regression coverage for the cross-tenant token-cache leak flagged in
 * PR #75 review: the token cache used to be keyed by platform alone (only
 * six values), so any two credential sets sharing a platform bucket would
 * silently receive each other's cached Datto RMM access token. Keyed by
 * platform+apiKey now - these tests construct exactly that "two different
 * customers, same platform" scenario and assert they never cross wires.
 *
 * Each test uses its own platform/apiKey combination (rather than resetting
 * the module's cache between tests) so cases can't interfere with each
 * other's cache entries.
 */

import { it, expect, vi, afterEach } from "vitest";
import { getDevicePatches } from "../src/patches.js";
import type { DattoCredentials } from "../src/mcp-server.js";

function tokenResponse(accessToken: string) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function patchesResponse() {
  return new Response(
    JSON.stringify({
      pageDetails: { count: 0, totalCount: 0, prevPageUrl: null, nextPageUrl: null },
      patches: [],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not leak one credential set's cached token to another on the same platform", async () => {
  const customerA: DattoCredentials = { platform: "syrah", apiKey: "customer-a-key", apiSecretKey: "a-secret" };
  const customerB: DattoCredentials = { platform: "syrah", apiKey: "customer-b-key", apiSecretKey: "b-secret" };

  const authHeadersSeen: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.endsWith("/auth/oauth/token")) {
      const params = new URLSearchParams(init?.body as string);
      // Return a token that encodes which customer it belongs to, so we can
      // tell whose token actually reached the API call below.
      return tokenResponse(`token-for-${params.get("username")}`);
    }
    authHeadersSeen.push((init?.headers as Record<string, string>).Authorization);
    return patchesResponse();
  });
  vi.stubGlobal("fetch", fetchMock);

  await getDevicePatches(customerA, "device-a");
  await getDevicePatches(customerB, "device-b");

  expect(authHeadersSeen).toEqual(["Bearer token-for-customer-a-key", "Bearer token-for-customer-b-key"]);
});

it("reuses the cached token for repeated calls with the same credentials", async () => {
  const creds: DattoCredentials = { platform: "merlot", apiKey: "repeat-key", apiSecretKey: "repeat-secret" };

  let tokenFetchCount = 0;
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (url.toString().endsWith("/auth/oauth/token")) {
      tokenFetchCount += 1;
      return tokenResponse("reused-token");
    }
    return patchesResponse();
  });
  vi.stubGlobal("fetch", fetchMock);

  await getDevicePatches(creds, "device-1");
  await getDevicePatches(creds, "device-2");

  expect(tokenFetchCount).toBe(1);
});

it("invalidates only the failing credential set's cache entry on a 401, not other customers'", async () => {
  const customerA: DattoCredentials = { platform: "concord", apiKey: "concord-a", apiSecretKey: "a-secret" };
  const customerB: DattoCredentials = { platform: "concord", apiKey: "concord-b", apiSecretKey: "b-secret" };

  let tokenFetchCountB = 0;
  let firstApiCallForA = true;
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.endsWith("/auth/oauth/token")) {
      const params = new URLSearchParams(init?.body as string);
      if (params.get("username") === "concord-b") tokenFetchCountB += 1;
      return tokenResponse(`token-for-${params.get("username")}`);
    }
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (auth === "Bearer token-for-concord-a" && firstApiCallForA) {
      firstApiCallForA = false;
      return new Response("unauthorized", { status: 401 });
    }
    return patchesResponse();
  });
  vi.stubGlobal("fetch", fetchMock);

  // Warm B's cache entry first.
  await getDevicePatches(customerB, "device-b");
  expect(tokenFetchCountB).toBe(1);

  // A's first call 401s and retries - should only evict A's own entry.
  await getDevicePatches(customerA, "device-a-1");

  // B's cached token must still be reused, unaffected by A's 401.
  await getDevicePatches(customerB, "device-b-2");
  expect(tokenFetchCountB).toBe(1);
});

it("does not include the raw OAuth error response body in the thrown error", async () => {
  const creds: DattoCredentials = { platform: "vidal", apiKey: "vidal-key", apiSecretKey: "vidal-secret" };
  const sensitiveBody = "error_description=invalid credentials for internal-account-id-12345";

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(sensitiveBody, { status: 400, statusText: "Bad Request" }))
  );

  await expect(getDevicePatches(creds, "device-1")).rejects.toThrow(
    "Failed to acquire Datto RMM token: 400 Bad Request"
  );
  await expect(getDevicePatches(creds, "device-1")).rejects.not.toThrow(
    new RegExp(sensitiveBody.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});
