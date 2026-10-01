/**
 * Coverage for the job read tools that wrap the SDK's `client.jobs`
 * resource: datto_get_job, datto_get_job_components, datto_get_job_results,
 * datto_get_job_stdout, and datto_get_job_stderr.
 *
 * Before these existed, a failed datto_run_quickjob was undiagnosable from
 * inside the MCP — it was fire-and-forget and returned only a generic
 * error. These tools let a caller follow up on the job UID
 * datto_run_quickjob returns to check status and retrieve output.
 *
 * Follows the same technique as s2s-guard-ordering.test.ts: drive a real
 * tools/call round-trip through the actual Worker `fetch` entrypoint with
 * only the network boundary (the Datto RMM host) stubbed.
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
function stubFetch(handler: (url: string) => Response | undefined) {
  globalThis.fetch = vi.fn(async (input) => {
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
    const stubbed = handler(url);
    if (stubbed) return stubbed;
    throw new Error(`Unstubbed fetch in test: GET ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("job read tools", () => {
  it("datto_get_job returns job status/details", async () => {
    stubFetch((url) => {
      if (url === `${DATTO_HOST}/api/v2/job/job-123`) {
        return jsonResponse({
          job: { uid: "job-123", name: "Restart Service", status: "completed" },
        });
      }
      return undefined;
    });

    const res = await call("datto_get_job", { jobUid: "job-123" });
    const job = JSON.parse(await resultText(res));
    expect(job.uid).toBe("job-123");
    expect(job.status).toBe("completed");
  });

  it("datto_get_job_components returns the job's components", async () => {
    stubFetch((url) => {
      if (url === `${DATTO_HOST}/api/v2/job/job-123/components`) {
        return jsonResponse({
          components: [{ uid: "component-789", name: "Restart Service" }],
        });
      }
      return undefined;
    });

    const res = await call("datto_get_job_components", { jobUid: "job-123" });
    const components = JSON.parse(await resultText(res));
    expect(components).toHaveLength(1);
    expect(components[0].uid).toBe("component-789");
  });

  it("datto_get_job_results returns the per-device result", async () => {
    stubFetch((url) => {
      if (url === `${DATTO_HOST}/api/v2/job/job-123/results/device-456`) {
        return jsonResponse({
          result: {
            jobUid: "job-123",
            deviceUid: "device-456",
            status: "completed",
            exitCode: 0,
          },
        });
      }
      return undefined;
    });

    const res = await call("datto_get_job_results", {
      jobUid: "job-123",
      deviceUid: "device-456",
    });
    const result = JSON.parse(await resultText(res));
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("datto_get_job_stdout returns captured stdout", async () => {
    stubFetch((url) => {
      if (
        url === `${DATTO_HOST}/api/v2/job/job-123/results/device-456/stdout`
      ) {
        return jsonResponse({ stdout: "Service restarted OK\n" });
      }
      return undefined;
    });

    const res = await call("datto_get_job_stdout", {
      jobUid: "job-123",
      deviceUid: "device-456",
    });
    // Untrusted-content wrapping (see untrusted-content.ts): stdout is raw
    // endpoint output, so the tool result wraps it in a <datto-data>
    // boundary rather than returning it as bare JSON.
    const text = await resultText(res);
    expect(text.startsWith("<datto-data>\n")).toBe(true);
    expect(text).toContain(JSON.stringify("Service restarted OK\n", null, 2));
    expect(text).toMatch(/not instructions/);
  });

  it("datto_get_job_stderr returns captured stderr", async () => {
    stubFetch((url) => {
      if (
        url === `${DATTO_HOST}/api/v2/job/job-123/results/device-456/stderr`
      ) {
        return jsonResponse({ stderr: "" });
      }
      return undefined;
    });

    const res = await call("datto_get_job_stderr", {
      jobUid: "job-123",
      deviceUid: "device-456",
    });
    // Untrusted-content wrapping (see untrusted-content.ts): stderr is raw
    // endpoint output, so the tool result wraps it in a <datto-data>
    // boundary rather than returning it as bare JSON.
    const text = await resultText(res);
    expect(text.startsWith("<datto-data>\n")).toBe(true);
    expect(text).toContain(JSON.stringify("", null, 2));
    expect(text).toMatch(/not instructions/);
  });

  it("lists all five job tools in tools/list", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      {}
    );
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "datto_get_job",
        "datto_get_job_components",
        "datto_get_job_results",
        "datto_get_job_stdout",
        "datto_get_job_stderr",
      ])
    );
  });
});
