/**
 * DATTO_HIDDEN_UDFS through the real tools/call path (Worker entrypoint), with only the
 * Datto RMM host stubbed: no tool result that can carry a device's `udf` block may show
 * the value of a listed UDF.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../worker.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };
const SITE = "00000000-0000-4000-8000-0000000000a1";
const DEVICE = "00000000-0000-4000-8000-0000000000d1";
const SECRET = "example-secret-value";
const realFetch = globalThis.fetch;

/** A device as the API returns it, with a value in udf3 (listed) and udf5 (not listed). */
const device = {
  uid: DEVICE,
  hostname: "WS-01",
  siteUid: SITE,
  siteName: "Example Site",
  online: true,
  udf: { udf1: null, udf3: SECRET, udf5: "visible-value" },
};

beforeEach(() => {
  vi.stubEnv("DATTO_HIDDEN_UDFS", "3");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubDatto() {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      return json({ access_token: "fake-token", token_type: "bearer", expires_in: 3600 });
    }
    if (url.startsWith(`${DATTO_HOST}/api/v2/account/devices`) || url.startsWith(`${DATTO_HOST}/api/v2/site/${SITE}/devices`)) {
      return json({ pageDetails: { count: 1, nextPageUrl: null }, devices: [device] });
    }
    if (url === `${DATTO_HOST}/api/v2/device/${DEVICE}`) return json(device);
    if (url === `${DATTO_HOST}/api/v2/audit/device/${DEVICE}`) {
      return json({ systemInfo: { manufacturer: "Example" }, device });
    }
    throw new Error(`Unstubbed fetch in test: GET ${url}`);
  }) as typeof fetch;
}

async function toolText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    ENV
  );
  const body = (await res.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
  expect(body.result?.isError).toBeFalsy();
  return body.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

describe("DATTO_HIDDEN_UDFS in tool results", () => {
  it.each([
    ["datto_list_devices", { siteUid: SITE }],
    ["datto_get_device", { deviceUid: DEVICE }],
    ["datto_get_device_audit", { deviceUid: DEVICE }],
  ])("%s shows a listed UDF as [hidden] and leaves the others", async (name, args) => {
    stubDatto();
    const text = await toolText(name, args);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('"udf3": "[hidden]"');
    expect(text).toContain('"udf5": "visible-value"');
  });

  it("datto_find_device never shows a listed UDF", async () => {
    stubDatto();
    const text = await toolText("datto_find_device", { hostname: "WS-01" });
    expect(text).toContain('"hostname": "WS-01"');
    expect(text).not.toContain(SECRET);
  });
});
