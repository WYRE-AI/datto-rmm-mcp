/**
 * Datto RMM blocks the source IP (403, about 5 minutes) when requests
 * continue after a 429, so a 429 must never be retried. These tests drive
 * real tools/call round-trips through the Worker entrypoint with only the
 * Datto RMM host stubbed, and check that a 429 makes exactly one request and
 * the tool error says "HTTP 429" and "Try again in N s.".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import worker from "../worker.js";
import {
  describeError,
  ipBlockSuspected,
  isRateLimitError,
  noteRateLimited,
  rateLimitDetails,
  resetRateLimitState,
  retryAfterSeconds,
} from "../rate-limit.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };
const DEVICE = "00000000-0000-4000-8000-0000000000d1";
const JOB_A = "a1000000-0000-4000-8000-000000000001";
const JOB_B = "a2000000-0000-4000-8000-000000000002";

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetRateLimitState();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(name: string, args: Record<string, unknown>) {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    ENV
  );
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  expect(body.result?.isError).toBe(true);
  return body.result?.content?.[0]?.text ?? "";
}

/** Answers the OAuth exchange; other URLs go to `handler` and are recorded in `seen`. */
function stubFetch(handler: (url: string) => Response | undefined) {
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      return new Response(JSON.stringify({ access_token: "fake-token", token_type: "bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    seen.push(url);
    const stubbed = handler(url);
    if (stubbed) return stubbed;
    throw new Error(`Unstubbed fetch in test: GET ${url}`);
  }) as typeof fetch;
  return seen;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const tooMany = (headers: Record<string, string> = {}) =>
  jsonResponse({ message: "Too Many Requests" }, 429, headers);

function activity(jobUid: string, dateS: number) {
  return {
    id: `${dateS}`,
    entity: "DEVICE",
    category: "job",
    action: "deployment",
    date: dateS,
    deviceId: 1,
    hostname: "WS-01",
    user: null,
    details: JSON.stringify({
      "device.hostname": "WS-01",
      "device.uid": DEVICE,
      entity: "device",
      "event.action": "deployment",
      "event.category": "job",
      "job.name": `Job ${jobUid.slice(0, 2)}`,
      "job.status": "scheduled",
      "job.uid": jobUid,
    }),
    hasStdOut: false,
    hasStdErr: false,
  };
}

describe("429 through the SDK", () => {
  it("is not retried, and the tool error says HTTP 429 and how long to wait", async () => {
    const seen = stubFetch((url) => (url === `${DATTO_HOST}/api/v2/job/job-123` ? tooMany() : undefined));

    const text = await errorText(await call("datto_get_job", { jobUid: "job-123" }));

    expect(seen).toEqual([`${DATTO_HOST}/api/v2/job/job-123`]);
    expect(text).toMatch(/HTTP 429.*Not retried.*Try again in \d+ s\./);
  });

  it("ends datto_list_device_jobs at the first 429 instead of looking up the other jobs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const seen = stubFetch((url) => {
      if (url.startsWith(`${DATTO_HOST}/api/v2/activity-logs?`)) {
        return jsonResponse({
          pageDetails: { count: 2, nextPageUrl: null },
          activities: [activity(JOB_A, now - 60), activity(JOB_B, now - 120)],
        });
      }
      if (url.includes("/results/")) return tooMany({ "Retry-After": "20" });
      return undefined;
    });

    const text = await errorText(await call("datto_list_device_jobs", { deviceUid: DEVICE }));

    expect(seen.filter((u) => u.includes("/results/"))).toHaveLength(1);
    // The pinned SDK (1.1.0) does not read Retry-After, so its 60 s default is reported.
    expect(text).toMatch(/HTTP 429.*Try again in \d+ s\./);
  });
});

describe("429 on the direct patches endpoint", () => {
  it("is not retried and reports the Retry-After", async () => {
    const seen = stubFetch((url) =>
      url.startsWith(`${DATTO_HOST}/api/v2/device/${DEVICE}/patches`) ? tooMany({ "Retry-After": "30" }) : undefined
    );

    const text = await errorText(await call("datto_get_device_patches", { deviceUid: DEVICE }));

    expect(seen).toHaveLength(1);
    expect(text).toContain(
      "Datto RMM rate-limited the request (HTTP 429 Too Many Requests). Not retried: continuing after a 429 gets this IP blocked (HTTP 403). Try again in 30 s."
    );
  });
});

describe("describeError", () => {
  it("rewords an older SDK's 429 so it says how long to wait", () => {
    const err = Object.assign(new Error("Rate limit exceeded and max retries reached (429): slow down"), {
      statusCode: 429,
    });
    expect(isRateLimitError(err)).toBe(true);
    expect(describeError(err)).toMatch(/^Datto RMM rate-limited the request \(HTTP 429.*Try again in 60 s\. Detail: Rate limit exceeded/);
  });

  it("reports an IP block as HTTP 403 with the cooldown", () => {
    const err = Object.assign(new Error("IP has been blocked due to rate limit violations"), {
      name: "DattoRmmIpBlockedError",
      statusCode: 403,
      cooldownMs: 300_000,
    });
    expect(describeError(err)).toMatch(/blocked this IP.*\(HTTP 403 Forbidden\)\. Try again in 300 s\./);
  });

  it("keeps a message that already says how long to wait, and leaves other errors alone", () => {
    const sayWait = Object.assign(new Error("Datto RMM rate-limited the request (HTTP 429). Try again in 12 s."), {
      statusCode: 429,
    });
    expect(describeError(sayWait)).toBe(sayWait.message);
    // That 429 starts the IP-block cooldown; outside it a bare 403 is a permissions error.
    resetRateLimitState();
    const forbidden = Object.assign(new Error("Access forbidden (403): no scope"), { statusCode: 403 });
    expect(isRateLimitError(forbidden)).toBe(false);
    expect(describeError(forbidden)).toBe("Access forbidden (403): no scope");
  });
});

describe("retry_after_seconds on the structured tool error", () => {
  type ToolBody = {
    result?: {
      content?: { text?: string }[];
      isError?: boolean;
      structuredContent?: { error_type?: string; retry_after_seconds?: number };
    };
  };

  it("carries the same N as the text, for a direct 429 and an SDK 429", async () => {
    stubFetch((url) =>
      url.startsWith(`${DATTO_HOST}/api/v2/device/${DEVICE}/patches`) ? tooMany({ "Retry-After": "30" }) : undefined
    );
    const direct = ((await (await call("datto_get_device_patches", { deviceUid: DEVICE })).json()) as ToolBody).result;
    expect(direct?.isError).toBe(true);
    expect(direct?.content?.[0]?.text).toContain("Try again in 30 s.");
    expect(direct?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 30 });

    stubFetch((url) => (url === `${DATTO_HOST}/api/v2/job/job-123` ? tooMany() : undefined));
    const sdk = ((await (await call("datto_get_job", { jobUid: "job-123" })).json()) as ToolBody).result;
    const n = Number(/Try again in (\d+) s\./.exec(sdk?.content?.[0]?.text ?? "")?.[1]);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(sdk?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: n });
  });

  it("is left off other errors", async () => {
    stubFetch((url) => (url === `${DATTO_HOST}/api/v2/job/job-404` ? jsonResponse({ message: "nope" }, 404) : undefined));
    const body = ((await (await call("datto_get_job", { jobUid: "job-404" })).json()) as ToolBody).result;
    expect(body?.isError).toBe(true);
    expect(body?.structuredContent).toBeUndefined();
  });
});

describe("rateLimitDetails", () => {
  it("reports an IP block's cooldown and clamps a stated 0 to 1", () => {
    const blocked = Object.assign(new Error("IP blocked"), { name: "DattoRmmIpBlockedError", statusCode: 403, cooldownMs: 300_000 });
    expect(rateLimitDetails(blocked).retryAfterSeconds).toBe(300);
    const zero = Object.assign(new Error("HTTP 429. Try again in 0 s."), { statusCode: 429 });
    expect(rateLimitDetails(zero)).toEqual({ message: "HTTP 429. Try again in 1 s.", retryAfterSeconds: 1 });
    expect(rateLimitDetails(new Error("plain")).retryAfterSeconds).toBeUndefined();
  });
});

describe("retryAfterSeconds", () => {
  it("reads seconds and HTTP dates, ignores junk", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterSeconds("5", now)).toBe(5);
    expect(retryAfterSeconds("0.2", now)).toBe(1);
    expect(retryAfterSeconds("Thu, 01 Jan 2026 00:00:07 GMT", now)).toBe(7);
    expect(retryAfterSeconds(null, now)).toBeUndefined();
    expect(retryAfterSeconds("soon", now)).toBeUndefined();
    expect(retryAfterSeconds("-3", now)).toBeUndefined();
  });
});

describe("a stated wait below 1 s", () => {
  it("says 1 s in the text and in retry_after_seconds", () => {
    const zero = Object.assign(new Error("Datto RMM rate-limited the request (HTTP 429). Try again in 0 s. Detail: /x"), {
      statusCode: 429,
    });
    const { message, retryAfterSeconds: n } = rateLimitDetails(zero);
    expect(message).toContain("Try again in 1 s.");
    expect(message).not.toContain("Try again in 0 s.");
    expect(n).toBe(1);
  });
});

type ToolResult = {
  content?: { text?: string }[];
  isError?: boolean;
  structuredContent?: { error_type?: string; retry_after_seconds?: number };
};

async function toolResult(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
  return ((await (await call(name, args)).json()) as { result?: ToolResult }).result;
}

const forbidden = (body: string, contentType = "text/plain") =>
  new Response(body, { status: 403, headers: { "Content-Type": contentType } });

describe("IP-block 403 on a direct call", () => {
  const PATCHES = `${DATTO_HOST}/api/v2/device/${DEVICE}/patches`;

  it("is reported as a rate limit when the body says the IP is blocked", async () => {
    const seen = stubFetch((url) => (url.startsWith(PATCHES) ? forbidden("IP blocked due to rate limit violations") : undefined));
    const result = await toolResult("datto_get_device_patches", { deviceUid: DEVICE });
    expect(seen).toHaveLength(1);
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("blocked this IP after rate-limit violations (HTTP 403 Forbidden). Not retried. Try again in 300 s.");
    expect(result?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  it("is reported as a rate limit during the cooldown after a 429, even with a bare body", async () => {
    stubFetch((url) => (url.startsWith(PATCHES) ? tooMany({ "Retry-After": "30" }) : undefined));
    await toolResult("datto_get_device_patches", { deviceUid: DEVICE });
    expect(ipBlockSuspected()).toBe(true);

    stubFetch((url) => (url.startsWith(PATCHES) ? forbidden("Forbidden") : undefined));
    const result = await toolResult("datto_get_device_patches", { deviceUid: DEVICE });
    expect(result?.content?.[0]?.text).toContain("(HTTP 403 Forbidden)");
    expect(result?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  it("does not restart the cooldown for a bare 403 that is only presumed to be the block", async () => {
    // A 429 50 s ago with a 60 s cooldown leaves 10 s.
    noteRateLimited(60, Date.now() - 50_000);
    stubFetch((url) => (url.startsWith(PATCHES) ? forbidden("Forbidden") : undefined));
    const result = await toolResult("datto_get_device_patches", { deviceUid: DEVICE });
    expect(result?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
    expect(ipBlockSuspected(Date.now() + 11_000)).toBe(false);
  });

  it("does restart the cooldown for a 403 whose body confirms the block", async () => {
    noteRateLimited(60, Date.now() - 50_000);
    stubFetch((url) => (url.startsWith(PATCHES) ? forbidden("IP blocked due to rate limit violations") : undefined));
    await toolResult("datto_get_device_patches", { deviceUid: DEVICE });
    expect(ipBlockSuspected(Date.now() + 11_000)).toBe(true);
  });

  it("leaves a permissions 403 alone when no rate limit has been seen", async () => {
    stubFetch((url) => (url.startsWith(PATCHES) ? forbidden("Forbidden") : undefined));
    const result = await toolResult("datto_get_device_patches", { deviceUid: DEVICE });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("Datto RMM API error: 403");
    expect(result?.structuredContent).toBeUndefined();
  });
});

describe("IP-block 403 through the SDK", () => {
  const JOB = `${DATTO_HOST}/api/v2/job/job-123`;

  it("is a rate limit when a plain-text body says the IP is blocked", async () => {
    stubFetch((url) => (url === JOB ? forbidden("Your IP has been blocked") : undefined));
    const result = await toolResult("datto_get_job", { jobUid: "job-123" });
    expect(result?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  it("is a rate limit during the cooldown after a 429, and a permissions error otherwise", async () => {
    stubFetch((url) => (url === JOB ? jsonResponse({ message: "Forbidden" }, 403) : undefined));
    expect((await toolResult("datto_get_job", { jobUid: "job-123" }))?.structuredContent).toBeUndefined();

    noteRateLimited();
    const result = await toolResult("datto_get_job", { jobUid: "job-123" });
    expect(result?.content?.[0]?.text).toContain("(HTTP 403 Forbidden). Try again in 300 s.");
    expect(result?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  it("ends datto_list_device_jobs at the first IP-block 403 instead of looking up the other jobs", async () => {
    noteRateLimited();
    const now = Math.floor(Date.now() / 1000);
    const seen = stubFetch((url) => {
      if (url.startsWith(`${DATTO_HOST}/api/v2/activity-logs?`)) {
        return jsonResponse({
          pageDetails: { count: 2, nextPageUrl: null },
          activities: [activity(JOB_A, now - 60), activity(JOB_B, now - 120)],
        });
      }
      if (url.includes("/results/")) return jsonResponse({ message: "Forbidden" }, 403);
      return undefined;
    });

    const result = await toolResult("datto_list_device_jobs", { deviceUid: DEVICE });
    expect(seen.filter((u) => u.includes("/results/"))).toHaveLength(1);
    expect(result?.structuredContent).toEqual({ error_type: "rate_limited", retry_after_seconds: 300 });
  });

  it("a bare 403 outside the cooldown is not a rate limit", () => {
    const err = Object.assign(new Error("Access forbidden (403): Forbidden"), { statusCode: 403, response: { message: "Forbidden" } });
    expect(isRateLimitError(err)).toBe(false);
    noteRateLimited(60, Date.now() - 61_000);
    expect(isRateLimitError(err)).toBe(false);
    noteRateLimited();
    expect(isRateLimitError(err)).toBe(true);
  });
});
