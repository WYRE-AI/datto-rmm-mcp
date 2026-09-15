/**
 * Coverage for end-user attribution on created quick jobs.
 *
 * The Datto RMM API has no impersonation: a job records the API account that
 * created it, never the person who asked. Behind a gateway that authenticates
 * end users, every job in the console therefore reads as the integration, and
 * "who ran this?" is unanswerable. The caller's UPN is carried in the job NAME
 * instead - the one field that reaches the console's activity list.
 *
 * Same technique as quickjob-payload-shape.test.ts: a real tools/call
 * round-trip through the Worker `fetch` entrypoint with only the Datto host
 * stubbed, so this asserts the body actually sent.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV_GATEWAY = { AUTH_MODE: "gateway" };
const ENV_ENV_CREDS = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubQuickJob(capture: { body?: unknown }) {
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/auth/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/quickjob") && init?.method === "PUT") {
      capture.body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ job: { uid: "job-1", name: "x", status: "active" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unstubbed fetch: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}

async function runQuickJob(
  env: Record<string, string>,
  headers: Record<string, string>,
  jobName = "Restart Service"
) {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "datto_run_quickjob",
          arguments: {
            deviceUid: "device-1",
            jobName,
            componentUid: "component-1",
          },
        },
      }),
    }),
    env
  );
}

const GATEWAY_HEADERS = {
  "X-Datto-API-Key": "k",
  "X-Datto-API-Secret": "s",
  "X-Datto-Platform": "concord",
};

describe("quick job attribution", () => {
  it("names the calling user in the job, so the console shows who ran it", async () => {
    const capture: { body?: unknown } = {};
    stubQuickJob(capture);

    const res = await runQuickJob(ENV_GATEWAY, {
      ...GATEWAY_HEADERS,
      "X-Mcp-User-Upn": "grant.hartley-brown@itsimply.co.nz",
    });

    expect(res.status).toBe(200);
    expect((capture.body as { jobName: string }).jobName).toBe(
      "Restart Service [grant.hartley-brown@itsimply.co.nz]"
    );
  });

  it("leaves the name untouched when the gateway sends no user", async () => {
    const capture: { body?: unknown } = {};
    stubQuickJob(capture);

    const res = await runQuickJob(ENV_GATEWAY, GATEWAY_HEADERS);

    expect(res.status).toBe(200);
    expect((capture.body as { jobName: string }).jobName).toBe("Restart Service");
  });

  it("ignores the header outside gateway mode, where anyone could send it", async () => {
    // Without a gateway in front, X-Mcp-User-Upn is whatever the caller chose
    // to put there - attributing a job to it would be worse than not
    // attributing at all, because it would look authoritative.
    const capture: { body?: unknown } = {};
    stubQuickJob(capture);

    const res = await runQuickJob(ENV_ENV_CREDS, {
      "X-Mcp-User-Upn": "someone.else@example.com",
    });

    expect(res.status).toBe(200);
    expect((capture.body as { jobName: string }).jobName).toBe("Restart Service");
  });

  it("does not stack suffixes when the name is already attributed", async () => {
    // A retry, or a caller that attributed the name itself, must not produce
    // "job [upn] [upn]".
    const capture: { body?: unknown } = {};
    stubQuickJob(capture);

    const res = await runQuickJob(
      ENV_GATEWAY,
      { ...GATEWAY_HEADERS, "X-Mcp-User-Upn": "a@b.co" },
      "Restart Service [a@b.co]"
    );

    expect(res.status).toBe(200);
    expect((capture.body as { jobName: string }).jobName).toBe("Restart Service [a@b.co]");
  });

  it("still sends the nested jobComponent shape alongside the attribution", async () => {
    // Guards against the attribution change quietly reverting the payload fix.
    const capture: { body?: unknown } = {};
    stubQuickJob(capture);

    await runQuickJob(ENV_GATEWAY, { ...GATEWAY_HEADERS, "X-Mcp-User-Upn": "a@b.co" });

    const body = capture.body as Record<string, unknown>;
    expect(body).toHaveProperty("jobComponent");
    expect(body).not.toHaveProperty("componentUid");
  });
});
