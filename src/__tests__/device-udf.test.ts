/**
 * Coverage for datto_set_device_udf (WYREAI-745): POST /v2/device/{uid}/udf.
 * Drives a real tools/call round-trip through the Worker `fetch` entrypoint
 * with only the Datto RMM host stubbed (same technique as job-tools.test.ts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { parseDeviceUid, parseUdfFields } from "../udf.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    ENV
  );
  return (await res.json()) as {
    result?: {
      content?: { text?: string }[];
      isError?: boolean;
      tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    };
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined) {
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      return new Response(
        JSON.stringify({ access_token: "fake-token", token_type: "bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    const stubbed = handler(url, init);
    if (stubbed) return stubbed;
    throw new Error(`Unstubbed fetch in test: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}

describe("datto_set_device_udf", () => {
  it("is listed as a write tool (not read-only)", async () => {
    const { result } = await rpc("tools/list");
    const tool = result?.tools?.find((t) => t.name === "datto_set_device_udf");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("POSTs the UDF fields to /v2/device/{uid}/udf", async () => {
    let capturedBody: unknown;
    stubFetch((url, init) => {
      if (url === `${DATTO_HOST}/api/v2/device/device-1/udf` && init?.method === "POST") {
        capturedBody = JSON.parse(String(init.body));
        // Datto documents a bare 200 with no body.
        return new Response(null, { status: 200 });
      }
      return undefined;
    });

    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf3: "Finance" } },
    });

    expect(result?.isError).toBeFalsy();
    expect(capturedBody).toEqual({ udf3: "Finance" });
    expect(JSON.parse(result?.content?.[0]?.text ?? "{}")).toEqual({
      deviceUid: "device-1",
      updated: { udf3: "Finance" },
    });
  });

  it("rejects invalid UDF keys without calling Datto", async () => {
    stubFetch(() => undefined);
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf301: "x" } },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("Invalid UDF key");
  });

  it("rejects a path-traversal deviceUid without calling Datto", async () => {
    const fetchSpy = vi.fn();
    stubFetch((url) => {
      fetchSpy(url);
      return undefined;
    });
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "../alert/x/resolve?", udf: { udf1: "x" } },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("deviceUid must be");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("parseUdfFields", () => {
  it("accepts udf1 through udf300 and empty-string values", () => {
    expect(parseUdfFields({ udf1: "a", udf30: "", udf31: "b", udf300: "c" })).toEqual({
      udf1: "a",
      udf30: "",
      udf31: "b",
      udf300: "c",
    });
  });

  it.each([
    [{}, "at least one"],
    [null, "must be an object"],
    [["udf1"], "must be an object"],
    [{ udf0: "x" }, "Invalid UDF key"],
    [{ udf301: "x" }, "Invalid UDF key"],
    [{ udf310: "x" }, "Invalid UDF key"],
    [{ custom1: "x" }, "Invalid UDF key"],
    [{ udf1: 5 }, "must be a string"],
  ])("rejects %j", (input, message) => {
    expect(() => parseUdfFields(input)).toThrow(message);
  });
});

describe("parseDeviceUid", () => {
  it("accepts GUID-shaped UIDs", () => {
    expect(parseDeviceUid("0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe(
      "0a1b2c3d-4e5f-6789-abcd-ef0123456789"
    );
  });

  it.each(["../alert/x/resolve?", "a/b", "", "a b", 5, undefined])("rejects %j", (input) => {
    expect(() => parseDeviceUid(input)).toThrow("deviceUid must be");
  });
});
