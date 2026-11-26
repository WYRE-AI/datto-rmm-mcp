/**
 * Coverage for datto_set_device_udf (WYREAI-745): POST /v2/device/{uid}/udf.
 * The write is sent once (never retried) after a device-exists check, and
 * UDFs listed in DATTO_HIDDEN_UDFS are refused.
 * Drives a real tools/call round-trip through the Worker `fetch` entrypoint
 * with only the Datto RMM host stubbed (same technique as job-tools.test.ts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import { parseDeviceUid, parseUdfFields, refuseHiddenUdfs } from "../udf.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
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
      tools?: { name: string; annotations?: Record<string, boolean> }[];
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
    // The device-exists check that runs before the write.
    if (url === `${DATTO_HOST}/api/v2/device/device-1` && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ uid: "device-1", siteUid: "site-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const stubbed = handler(url, init);
    if (stubbed) return stubbed;
    throw new Error(`Unstubbed fetch in test: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}

describe("datto_set_device_udf", () => {
  it("is listed as a write tool with write annotations", async () => {
    const { result } = await rpc("tools/list");
    const tool = result?.tools?.find((t) => t.name === "datto_set_device_udf");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("POSTs the UDF fields once, and reports which changed without the values", async () => {
    const bodies: unknown[] = [];
    stubFetch((url, init) => {
      if (url === `${DATTO_HOST}/api/v2/device/device-1/udf` && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        // Datto documents a bare 200 with no body.
        return new Response(null, { status: 200 });
      }
      return undefined;
    });

    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf3: "Finance", udf7: "" } },
    });

    expect(result?.isError).toBeFalsy();
    expect(bodies).toEqual([{ udf3: "Finance", udf7: "" }]);
    const text = result?.content?.[0]?.text ?? "{}";
    expect(JSON.parse(text)).toEqual({ deviceUid: "device-1", set: ["udf3"], cleared: ["udf7"] });
    expect(text).not.toContain("Finance");
  });

  it("is not retried on a 500", async () => {
    let posts = 0;
    stubFetch((url, init) => {
      if (url === `${DATTO_HOST}/api/v2/device/device-1/udf` && init?.method === "POST") {
        posts++;
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }
      return undefined;
    });
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf3: "x" } },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toMatch(/HTTP 500.*Not retried/);
    expect(posts).toBe(1);
  });

  it("refuses an unknown device without writing", async () => {
    const writes: string[] = [];
    stubFetch((url, init) => {
      if (init?.method === "POST") writes.push(url);
      if (url === `${DATTO_HOST}/api/v2/device/device-404`) {
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }
      return undefined;
    });
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-404", udf: { udf3: "x" } },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("No device with UID device-404");
    expect(writes).toEqual([]);
  });

  it("refuses UDFs listed in DATTO_HIDDEN_UDFS without echoing the value", async () => {
    vi.stubEnv("DATTO_HIDDEN_UDFS", "3,28");
    const writes: string[] = [];
    stubFetch((url, init) => {
      if (init?.method === "POST") writes.push(url);
      return undefined;
    });
    const secret = "not-a-real-secret-123";
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf5: "ok", udf28: secret } },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("udf28 is a hidden UDF");
    expect(result?.content?.[0]?.text).not.toContain(secret);
    expect(writes).toEqual([]);
  });

  it("writes any UDF while DATTO_HIDDEN_UDFS is unset", async () => {
    vi.stubEnv("DATTO_HIDDEN_UDFS", undefined);
    let posted = false;
    stubFetch((url, init) => {
      if (url === `${DATTO_HOST}/api/v2/device/device-1/udf` && init?.method === "POST") {
        posted = true;
        return new Response(null, { status: 200 });
      }
      return undefined;
    });
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf28: "x" } },
    });
    expect(result?.isError).toBeFalsy();
    expect(posted).toBe(true);
  });

  it("refuses unknown arguments", async () => {
    stubFetch(() => undefined);
    const { result } = await rpc("tools/call", {
      name: "datto_set_device_udf",
      arguments: { deviceUid: "device-1", udf: { udf1: "x" }, siteUid: "site-1" },
    });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("Unknown argument(s): siteUid");
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
    [{ udf1: "x".repeat(256) }, "at most 255 characters"],
    [{ udf1: "a\nb" }, "control characters or line breaks"],
  ])("rejects %j", (input, message) => {
    expect(() => parseUdfFields(input)).toThrow(message);
  });
});

describe("refuseHiddenUdfs", () => {
  it("refuses only listed UDFs, and nothing when none are listed", () => {
    expect(() => refuseHiddenUdfs({ udf3: "x" }, new Set())).not.toThrow();
    expect(() => refuseHiddenUdfs({ udf3: "x", udf4: "y" }, new Set(["udf9"]))).not.toThrow();
    expect(() => refuseHiddenUdfs({ udf3: "x", udf4: "y" }, new Set(["udf3", "udf4"]))).toThrow(
      "udf3, udf4 are hidden UDFs"
    );
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
