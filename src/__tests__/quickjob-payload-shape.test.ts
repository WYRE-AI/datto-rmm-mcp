/**
 * Regression coverage for the datto_run_quickjob payload shape bug.
 *
 * Follows the same technique as s2s-guard-ordering.test.ts: drive a real
 * tools/call round-trip through the actual Worker `fetch` entrypoint (the
 * same handler production uses) with only the network boundary (the Datto
 * RMM host) stubbed — no mocking of mcp-server.ts/worker.ts. This exercises
 * the true request body the SDK forwards to the API, which is the
 * regression that matters: Datto RMM rejects the flat
 * `{jobName, componentUid, variables}` shape with HTTP 400
 * ("Failed to read request"); it requires
 * `{jobName, jobComponent: {componentUid, variables: [{name, value}]}}`.
 * See the QuickJobRequestBody comment in mcp-server.ts for the full story.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(name: string, args: Record<string, unknown>) {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    ENV
  );
}

async function resultText(res: Response): Promise<string> {
  const body = (await res.json()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
  };
  expect(body.result?.isError).toBeFalsy();
  return body.result?.content?.[0]?.text ?? "";
}

/**
 * Stubs the global fetch used by the SDK's HttpClient. Always answers the
 * OAuth token exchange; everything else goes through `handler`, and an
 * unmatched URL throws (so a wrong path/method fails loudly, not silently).
 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | undefined
) {
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      return new Response(
        JSON.stringify({
          access_token: "fake-token",
          token_type: "bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    const stubbed = handler(url, init);
    if (stubbed) return stubbed;
    throw new Error(`Unstubbed fetch in test: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("datto_run_quickjob payload shape", () => {
  it("sends the nested jobComponent shape with variables as a {name,value} array", async () => {
    let capturedBody: unknown;
    stubFetch((url, init) => {
      if (
        url === `${DATTO_HOST}/api/v2/device/device-456/quickjob` &&
        init?.method === "PUT"
      ) {
        capturedBody = JSON.parse(String(init.body));
        return jsonResponse({
          uid: "job-123",
          name: "Restart Service",
          status: "queued",
        });
      }
      return undefined;
    });

    const res = await call("datto_run_quickjob", {
      deviceUid: "device-456",
      jobName: "Restart Service",
      componentUid: "component-789",
      variables: { param1: "value1", param2: "value2" },
    });

    expect(res.status).toBe(200);
    const text = await resultText(res);
    expect(JSON.parse(text).uid).toBe("job-123");

    // The regression: the API needs the nested shape, never the flat one.
    expect(capturedBody).toEqual({
      jobName: "Restart Service",
      jobComponent: {
        componentUid: "component-789",
        variables: [
          { name: "param1", value: "value1" },
          { name: "param2", value: "value2" },
        ],
      },
    });
    expect(capturedBody).not.toHaveProperty("componentUid");
    expect(capturedBody).not.toHaveProperty("variables");
  });

  it("sends an empty variables array when no variables are given", async () => {
    let capturedBody: unknown;
    stubFetch((url, init) => {
      if (
        url === `${DATTO_HOST}/api/v2/device/device-456/quickjob` &&
        init?.method === "PUT"
      ) {
        capturedBody = JSON.parse(String(init.body));
        return jsonResponse({ uid: "job-999", name: "x", status: "queued" });
      }
      return undefined;
    });

    await call("datto_run_quickjob", {
      deviceUid: "device-456",
      jobName: "No Vars Job",
      componentUid: "component-000",
    });

    expect(capturedBody).toEqual({
      jobName: "No Vars Job",
      jobComponent: { componentUid: "component-000", variables: [] },
    });
  });
});
