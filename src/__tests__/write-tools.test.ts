/**
 * Coverage for the write tools: datto_resolve_alert, datto_run_quickjob,
 * datto_set_device_udf and datto_move_device.
 *
 * - Annotations: every write says readOnlyHint false (MCP clients and
 *   gateways can gate writes on it), every other tool says readOnlyHint true.
 * - Checks before a write: a quick job only runs an existing component, with
 *   only the variables it declares, on a device that exists.
 *   (datto_set_device_udf has its own coverage in device-udf.test.ts.)
 * - Rate limits: a write is sent exactly once. A 429 is not retried and comes
 *   back as error_type rate_limited with retry_after_seconds.
 *
 * Same technique as quickjob-payload-shape.test.ts: real tools/call
 * round-trips through the Worker entrypoint, only the Datto host stubbed.
 * All UIDs and values are made up.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../worker.js";
import { validateQuickJobVariables } from "../writes.js";
import { ipBlockSuspected, noteRateLimited, resetRateLimitState } from "../rate-limit.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "write-test-key", DATTO_API_SECRET: "write-test-secret" };

const WRITE_TOOLS = [
  "datto_resolve_alert",
  "datto_run_quickjob",
  "datto_set_device_udf",
  "datto_move_device",
];

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetRateLimitState();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

interface ToolResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
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
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const body = await rpc("tools/call", { name, arguments: args });
  return body.result as ToolResult;
}

function text(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const COMPONENTS = [
  {
    uid: "comp-restart",
    name: "Restart Service",
    variables: [
      { name: "ServiceName", type: "string" },
      { name: "Force", type: "boolean" },
      { name: "Mode", type: "selection", selectionOptions: [{ value: "Fast" }, { value: "Safe" }] },
    ],
  },
  { uid: "comp-novars", name: "Flush DNS", variables: [] },
];

interface Calls {
  writes: { method: string; url: string; body?: unknown }[];
}

/**
 * Stubs the Datto host: token, the component catalogue, device-1 (in site-a),
 * site-a and site-b. Writes (non-GET) go to `onWrite`, default 200 {}.
 */
function stubDatto(onWrite?: (method: string, url: string) => Response | undefined): Calls {
  const calls: Calls = { writes: [] };
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      return json({ access_token: "fake-token", expires_in: 3600 });
    }
    if (method === "GET") {
      if (url === `${DATTO_HOST}/api/v2/account/components`) {
        return json({ pageDetails: { nextPageUrl: null }, components: COMPONENTS });
      }
      if (url === `${DATTO_HOST}/api/v2/device/device-1`) {
        return json({ uid: "device-1", hostname: "WS-01", siteUid: "site-a", siteName: "Site A" });
      }
      if (url === `${DATTO_HOST}/api/v2/site/site-a`) return json({ uid: "site-a", name: "Site A" });
      if (url === `${DATTO_HOST}/api/v2/site/site-b`) return json({ uid: "site-b", name: "Site B" });
      return json({ message: "not found" }, 404);
    }
    calls.writes.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return onWrite?.(method, url) ?? json({});
  }) as typeof fetch;
  return calls;
}

describe("write tool annotations", () => {
  it("marks every write tool readOnlyHint false, and every other tool readOnlyHint true", async () => {
    const body = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string; annotations?: Record<string, boolean> }[] })
      .tools;
    for (const name of WRITE_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
    }
    for (const tool of tools.filter((t) => !WRITE_TOOLS.includes(t.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it("marks quick jobs, UDF writes, moves and alert resolution destructive", async () => {
    const body = await rpc("tools/list", {});
    const tools = (body.result as { tools: { name: string; annotations?: Record<string, boolean> }[] })
      .tools;
    const hint = (n: string) => tools.find((t) => t.name === n)?.annotations?.destructiveHint;
    expect(hint("datto_run_quickjob")).toBe(true);
    expect(hint("datto_set_device_udf")).toBe(true);
    expect(hint("datto_move_device")).toBe(true);
    expect(hint("datto_resolve_alert")).toBe(true);
  });
});

describe("datto_run_quickjob checks", () => {
  const base = { deviceUid: "device-1", jobName: "Restart spooler", componentUid: "comp-restart" };

  it("runs an existing component with declared variables", async () => {
    const calls = stubDatto(() => json({ job: { uid: "job-1", status: "active" } }));
    const result = await call("datto_run_quickjob", {
      ...base,
      siteUid: "site-a",
      variables: { ServiceName: "Spooler", Force: "true", Mode: "Safe" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0].method).toBe("PUT");
    expect(calls.writes[0].url).toBe(`${DATTO_HOST}/api/v2/device/device-1/quickjob`);
    expect(calls.writes[0].body).toEqual({
      jobName: "Restart spooler",
      jobComponent: {
        componentUid: "comp-restart",
        variables: [
          { name: "ServiceName", value: "Spooler" },
          { name: "Force", value: "true" },
          { name: "Mode", value: "Safe" },
        ],
      },
    });
  });

  it("refuses a component that is not in the catalogue", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", { ...base, componentUid: "comp-missing" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No component with UID comp-missing/);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses a free-form script argument", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", { ...base, script: "Remove-Item C:\\ -Recurse" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unknown argument\(s\): script/);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses a variable the component does not declare, and suggests the right case", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", { ...base, variables: { servicename: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no variable "servicename".*Did you mean "ServiceName"/);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses variables on a component that has none", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", {
      ...base,
      componentUid: "comp-novars",
      variables: { Command: "whoami" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Its variables: none/);
    expect(calls.writes).toHaveLength(0);
  });

  it("checks boolean and selection values", async () => {
    stubDatto();
    const bool = await call("datto_run_quickjob", { ...base, variables: { Force: "yes" } });
    expect(text(bool)).toMatch(/boolean/);
    const sel = await call("datto_run_quickjob", { ...base, variables: { Mode: "Turbo" } });
    expect(text(sel)).toMatch(/must be one of: Fast, Safe/);
  });

  it("refuses when the device is not in the named site", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", { ...base, siteUid: "site-b" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not in site site-b/);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses an unknown device", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", { ...base, deviceUid: "device-404" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No device with UID device-404/);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses a UID that would change the URL path", async () => {
    const calls = stubDatto();
    const result = await call("datto_run_quickjob", { ...base, deviceUid: "../account" });
    expect(result.isError).toBe(true);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses a job name with a line break", async () => {
    stubDatto();
    const result = await call("datto_run_quickjob", { ...base, jobName: "a\nb" });
    expect(text(result)).toMatch(/jobName/);
  });
});

describe("writes are sent once and never retried", () => {
  it("a 429 on a quick job is not retried and returns rate_limited with retry_after_seconds", async () => {
    const calls = stubDatto(() => json({}, 429, { "Retry-After": "42" }));
    const result = await call("datto_run_quickjob", {
      deviceUid: "device-1",
      jobName: "x",
      componentUid: "comp-novars",
    });
    expect(calls.writes).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 42 });
    expect(text(result)).toMatch(/HTTP 429.*Try again in 42 s/);
  });

  it("a 429 without Retry-After reports 60 s", async () => {
    stubDatto(() => json({}, 429));
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 60 });
  });

  it("an IP block (403) is reported as rate_limited", async () => {
    const calls = stubDatto(() => json({ message: "IP blocked due to rate limit" }, 403));
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(calls.writes).toHaveLength(1);
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  it("a bare 403 on a write is an IP block during the cooldown after a 429, and a plain error otherwise", async () => {
    const forbidden = () => json({ message: "Forbidden" }, 403);
    let calls = stubDatto(forbidden);
    let result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(calls.writes).toHaveLength(1);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toMatch(/HTTP 403.*Not retried/);

    stubDatto(() => json({}, 429));
    await call("datto_resolve_alert", { alertUid: "alert-1" });

    calls = stubDatto(forbidden);
    result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(calls.writes).toHaveLength(1);
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  // The main reason writes bypass the SDK: it re-sends any request once after a
  // 5xx, and Datto answers 500 for some quick jobs it has already started.
  it.each([500, 502, 503, 504])("a %i on a quick job is sent once and never re-sent", async (status) => {
    const calls = stubDatto(() => json({ errorMessage: "boom" }, status));
    const result = await call("datto_run_quickjob", {
      deviceUid: "device-1",
      jobName: "x",
      componentUid: "comp-novars",
    });
    const quickJobPuts = calls.writes.filter(
      (w) => w.method === "PUT" && w.url === `${DATTO_HOST}/api/v2/device/device-1/quickjob`
    );
    expect(quickJobPuts).toHaveLength(1);
    expect(calls.writes).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(new RegExp(`HTTP ${status}.*Not retried`));
    expect(result.structuredContent).toBeUndefined();

    // Nothing is re-sent later either (the SDK waits 1 s before its retry).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(calls.writes).toHaveLength(1);
  });

  it("a bare 403 presumed to be the IP block does not restart the cooldown", async () => {
    // A 429 50 s ago with a 60 s cooldown leaves 10 s.
    noteRateLimited(60, Date.now() - 50_000);
    stubDatto(() => json({ message: "Forbidden" }, 403));
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
    expect(ipBlockSuspected(Date.now() + 11_000)).toBe(false);
  });

  it.each([307, 308])("a %i on a quick job is not followed, so the body is sent once", async (status) => {
    const calls = stubDatto(
      () => new Response(null, { status, headers: { Location: `${DATTO_HOST}/api/v2/device/device-1/quickjob-elsewhere` } })
    );
    const result = await call("datto_run_quickjob", { deviceUid: "device-1", jobName: "x", componentUid: "comp-novars" });
    expect(calls.writes).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(new RegExp(`HTTP ${status}.*Not retried`));
    const writeInit = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([, init]) => init)
      .find((init) => init?.method === "PUT");
    expect(writeInit?.redirect).toBe("manual");
  });

  it.each([
    ["stalls", () => new ReadableStream<Uint8Array>({ start() {} })],
    ["is cut off", () => new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError("terminated")); } })],
  ])("a 429 whose body %s is still reported as rate_limited at once", async (_label, body) => {
    const calls = stubDatto(() => new Response(body(), { status: 429, headers: { "Retry-After": "20" } }));
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(calls.writes).toHaveLength(1);
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 20 });
  }, 2_000);

  it("a 401 with a truncated body still drops the token, so the next call gets a fresh one", async () => {
    stubDatto(
      () =>
        new Response(new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError("terminated")); } }), { status: 401 })
    );
    const first = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(first.isError).toBe(true);
    const tokenRequests = () =>
      vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => String(input).startsWith(`${DATTO_HOST}/auth/oauth/token`)).length;
    const before = tokenRequests();
    await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(tokenRequests()).toBe(before + 1);
  });

  it("a 403 with a truncated body during the cooldown is still an IP block, without renewing it", async () => {
    noteRateLimited(60, Date.now() - 50_000);
    stubDatto(
      () =>
        new Response(new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError("terminated")); } }), { status: 403 })
    );
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(result.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
    expect(ipBlockSuspected(Date.now() + 11_000)).toBe(false);
  });

  it("a 401 on a write is not re-sent", async () => {
    const calls = stubDatto(() => json({}, 401));
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(calls.writes).toHaveLength(1);
    expect(result.isError).toBe(true);
  });
});

describe("datto_resolve_alert", () => {
  it("POSTs to the resolve endpoint once", async () => {
    const calls = stubDatto();
    const result = await call("datto_resolve_alert", { alertUid: "alert-1" });
    expect(result.isError).toBeFalsy();
    expect(calls.writes).toEqual([
      { method: "POST", url: `${DATTO_HOST}/api/v2/alert/alert-1/resolve`, body: undefined },
    ]);
  });
});

describe("datto_move_device", () => {
  it("moves a device to another site", async () => {
    const calls = stubDatto();
    const result = await call("datto_move_device", { deviceUid: "device-1", siteUid: "site-b" });
    expect(result.isError).toBeFalsy();
    expect(calls.writes).toEqual([
      { method: "PUT", url: `${DATTO_HOST}/api/v2/device/device-1/site/site-b`, body: undefined },
    ]);
    expect(JSON.parse(text(result))).toMatchObject({ fromSiteUid: "site-a", toSiteUid: "site-b" });
  });

  it("refuses a move to the site the device is already in", async () => {
    const calls = stubDatto();
    const result = await call("datto_move_device", { deviceUid: "device-1", siteUid: "site-a" });
    expect(text(result)).toMatch(/already in site site-a/);
    expect(calls.writes).toHaveLength(0);
  });

  it("refuses an unknown site", async () => {
    const calls = stubDatto();
    const result = await call("datto_move_device", { deviceUid: "device-1", siteUid: "site-zz" });
    expect(text(result)).toMatch(/No site with UID site-zz/);
    expect(calls.writes).toHaveLength(0);
  });
});

describe("validateQuickJobVariables", () => {
  it("returns [] for no variables", () => {
    expect(validateQuickJobVariables(undefined, { variables: [] })).toEqual([]);
  });

  it("refuses non-string and over-long values", () => {
    const component = { name: "c", variables: [{ name: "A", type: "string" }] };
    expect(() => validateQuickJobVariables({ A: 1 }, component)).toThrow(/must be a string/);
    expect(() => validateQuickJobVariables({ A: "x".repeat(1025) }, component)).toThrow(/at most/);
    expect(() => validateQuickJobVariables({ A: "a\u0000b" }, component)).toThrow(/control/);
  });
});
