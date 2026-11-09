/**
 * Coverage for the job read tools that wrap the SDK's `client.jobs`
 * resource: datto_get_job, datto_get_job_components, datto_get_job_results,
 * datto_get_job_stdout, and datto_get_job_stderr - plus
 * datto_list_device_jobs, which finds the job UIDs those tools need.
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
        "datto_list_device_jobs",
      ])
    );
  });
});

/**
 * datto_list_device_jobs: activity-log rows (`GET /v2/activity-logs`) whose
 * `details` is a JSON string with dotted keys, enriched from
 * `GET /v2/job/{uid}/results/{deviceUid}`. Fixture shapes mirror a live
 * response captured on 2026-11-09 (identifiers replaced).
 */
describe("datto_list_device_jobs", () => {
  const DEVICE = "76a3ba3b-0000-4000-8000-000000000001";
  const OTHER_DEVICE = "76a3ba3b-0000-4000-8000-000000000002";
  const RECURRING = "dd3c5669-0000-4000-8000-00000000000a";
  const QUICK = "2e1101e5-0000-4000-8000-00000000000b";
  const ACTIVITY_PREFIX = `${DATTO_HOST}/api/v2/activity-logs?`;

  // 2026-11-08T21:45:00Z and the same job's previous run a day earlier.
  const LATEST_RUN_S = 1794174300;
  const EARLIER_RUN_S = LATEST_RUN_S - 86400;
  const QUICK_RUN_S = 1794180451;

  function activity(opts: {
    jobUid?: string;
    jobName: string;
    dateS: number;
    device?: string;
    hasStdOut?: boolean;
    user?: Record<string, unknown> | null;
  }) {
    const details: Record<string, unknown> = {
      "device.hostname": "CWS0001",
      "device.uid": opts.device ?? DEVICE,
      entity: "device",
      "event.action": "deployment",
      "event.category": "job",
      "job.name": opts.jobName,
      "job.status": "scheduled",
      "job.scheduled_job_uid": "3209ce19-0000-4000-8000-0000000000ff",
      uid: "87557555-0000-4000-8000-0000000000ee",
    };
    if (opts.jobUid) details["job.uid"] = opts.jobUid;
    return {
      id: `${opts.dateS}`,
      entity: "DEVICE",
      category: "job",
      action: "deployment",
      date: opts.dateS + 0.24,
      deviceId: 2941912,
      hostname: "CWS0001",
      user: opts.user ?? null,
      details: JSON.stringify(details),
      hasStdOut: opts.hasStdOut ?? false,
      hasStdErr: false,
    };
  }

  function result(jobUid: string, ranOnS: number, componentName: string, status = "Success") {
    return jsonResponse({
      jobUid,
      deviceUid: DEVICE,
      ranOn: ranOnS * 1000,
      jobDeploymentStatus: status,
      componentResults: [
        {
          componentUid: "4ca56165-0000-4000-8000-0000000000cc",
          componentName,
          componentStatus: status,
          numberOfWarnings: 0,
          hasStdOut: true,
          hasStdErr: false,
        },
      ],
    });
  }

  async function errorText(res: Response): Promise<string> {
    const body = (await res.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    expect(body.result?.isError).toBe(true);
    return body.result?.content?.[0]?.text ?? "";
  }

  it("lists job runs newest first, with outcome only on the run the stored result belongs to", async () => {
    let activityUrl = "";
    stubFetch((url) => {
      if (url.startsWith(ACTIVITY_PREFIX)) {
        activityUrl = url;
        return jsonResponse({
          pageDetails: { count: 5, nextPageUrl: null },
          activities: [
            activity({ jobUid: QUICK, jobName: "QuickJob running component Get-NitroPDFInfo on device CWS0001", dateS: QUICK_RUN_S, user: { id: 7, userName: "jdoe", firstName: "Jane", lastName: "Doe" } }),
            activity({ jobUid: RECURRING, jobName: "Add Bitlocker key to UDF 9", dateS: LATEST_RUN_S, hasStdOut: true }),
            // Another device's row must be dropped even if the search returns it.
            activity({ jobUid: "ffffffff-0000-4000-8000-000000000000", jobName: "Other", dateS: LATEST_RUN_S - 10, device: OTHER_DEVICE }),
            // A row without job.uid can't be followed up, so it's skipped.
            activity({ jobName: "No uid", dateS: LATEST_RUN_S - 20 }),
            activity({ jobUid: RECURRING, jobName: "Add Bitlocker key to UDF 9", dateS: EARLIER_RUN_S, hasStdOut: true }),
          ],
        });
      }
      if (url === `${DATTO_HOST}/api/v2/job/${QUICK}/results/${DEVICE}`) {
        return result(QUICK, QUICK_RUN_S, "Get-NitroPDFInfo");
      }
      if (url === `${DATTO_HOST}/api/v2/job/${RECURRING}/results/${DEVICE}`) {
        return result(RECURRING, LATEST_RUN_S, "Bitlocker Recovery Key (Powershell)");
      }
      return undefined;
    });

    const res = await call("datto_list_device_jobs", {
      deviceUid: DEVICE,
      since: "2026-11-01T00:00:00Z",
      until: "2026-11-09T00:00:00Z",
    });
    const out = JSON.parse(await resultText(res));

    // Request: documented params, server-side device filter, no millis in dates.
    const q = new URL(activityUrl).searchParams;
    expect(q.get("categories")).toBe("job");
    expect(q.get("entities")).toBe("device");
    expect(q.get("order")).toBe("desc");
    expect(q.get("from")).toBe("2026-11-01T00:00:00Z");
    expect(q.get("until")).toBe("2026-11-09T00:00:00Z");
    expect(q.get("searchQuery")).toBe(`device.uid : "${DEVICE}"`);

    expect(out.deviceUid).toBe(DEVICE);
    expect(out.returned).toBe(3);
    expect(out.jobs.map((j: { jobUid: string }) => j.jobUid)).toEqual([QUICK, RECURRING, RECURRING]);

    const [quick, latest, earlier] = out.jobs;
    expect(quick.jobName).toContain("Get-NitroPDFInfo");
    expect(quick.status).toBe("Success");
    expect(quick.componentNames).toEqual(["Get-NitroPDFInfo"]);
    expect(quick.startedBy).toBe("jdoe");
    expect(quick.deployedAt).toBe(new Date((QUICK_RUN_S + 0.24) * 1000).toISOString());

    expect(latest.status).toBe("Success");
    expect(latest.ranOn).toBe(new Date(LATEST_RUN_S * 1000).toISOString());
    expect(latest.components[0]).toMatchObject({ name: "Bitlocker Recovery Key (Powershell)", status: "Success", hasStdOut: true });
    expect(latest.startedBy).toBeUndefined();

    // Same job.uid, earlier run: no borrowed outcome, but still identifiable.
    expect(earlier.status).toBeUndefined();
    expect(earlier.ranOn).toBeUndefined();
    expect(earlier.componentNames).toEqual(["Bitlocker Recovery Key (Powershell)"]);
    expect(earlier.statusNote).toMatch(/latest run/);
    expect(out.notes.join(" ")).toMatch(/LATEST run/);

    // Not a device-shaped payload: no untrusted-content wrapper, no hostname.
    const text = JSON.stringify(out);
    expect(text).not.toContain('"hostname"');
    expect(text).not.toContain("datto-data");
  });

  it("looks up each job's result once, however many runs it has", async () => {
    const resultCalls: string[] = [];
    stubFetch((url) => {
      if (url.startsWith(ACTIVITY_PREFIX)) {
        return jsonResponse({
          pageDetails: { nextPageUrl: null },
          activities: [0, 1, 2].map((i) =>
            activity({ jobUid: RECURRING, jobName: "Daily", dateS: LATEST_RUN_S - i * 86400 })
          ),
        });
      }
      if (url.includes("/results/")) {
        resultCalls.push(url);
        return result(RECURRING, LATEST_RUN_S, "Daily component");
      }
      return undefined;
    });

    const res = await call("datto_list_device_jobs", { deviceUid: DEVICE });
    const out = JSON.parse(await resultText(res));
    expect(out.returned).toBe(3);
    expect(resultCalls).toHaveLength(1);
  });

  it("filters case-insensitively on job name or component name", async () => {
    stubFetch((url) => {
      if (url.startsWith(ACTIVITY_PREFIX)) {
        return jsonResponse({
          pageDetails: { nextPageUrl: null },
          activities: [
            activity({ jobUid: QUICK, jobName: "Weekly maintenance", dateS: QUICK_RUN_S }),
            activity({ jobUid: RECURRING, jobName: "Restart Desktop at 4am", dateS: LATEST_RUN_S }),
          ],
        });
      }
      if (url === `${DATTO_HOST}/api/v2/job/${QUICK}/results/${DEVICE}`) {
        return result(QUICK, QUICK_RUN_S, "Get-NitroPDFInfo");
      }
      if (url === `${DATTO_HOST}/api/v2/job/${RECURRING}/results/${DEVICE}`) {
        return result(RECURRING, LATEST_RUN_S, "Restart Computer");
      }
      return undefined;
    });

    const byComponent = JSON.parse(
      await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE, name: "nitropdf" }))
    );
    expect(byComponent.jobs.map((j: { jobUid: string }) => j.jobUid)).toEqual([QUICK]);

    const byJobName = JSON.parse(
      await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE, name: "RESTART desktop" }))
    );
    expect(byJobName.jobs.map((j: { jobUid: string }) => j.jobUid)).toEqual([RECURRING]);

    const none = JSON.parse(
      await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE, name: "nothing-matches" }))
    );
    expect(none.returned).toBe(0);
    expect(none.notes.join(" ")).toMatch(/No job runs matching/);
  });

  it("follows nextPageUrl and stops at max", async () => {
    const pages: string[] = [];
    const page2 = `${DATTO_HOST}/api/v2/activity-logs?page=next&searchAfter=abc`;
    stubFetch((url) => {
      if (url === page2) {
        pages.push(url);
        return jsonResponse({
          pageDetails: { nextPageUrl: `${DATTO_HOST}/api/v2/activity-logs?page=next&searchAfter=def` },
          activities: [
            activity({ jobUid: "a3000000-0000-4000-8000-000000000003", jobName: "Job 3", dateS: LATEST_RUN_S - 300 }),
            activity({ jobUid: "a4000000-0000-4000-8000-000000000004", jobName: "Job 4", dateS: LATEST_RUN_S - 400 }),
          ],
        });
      }
      if (url.startsWith(ACTIVITY_PREFIX)) {
        pages.push(url);
        return jsonResponse({
          pageDetails: { nextPageUrl: page2 },
          activities: [
            activity({ jobUid: "a1000000-0000-4000-8000-000000000001", jobName: "Job 1", dateS: LATEST_RUN_S - 100 }),
            activity({ jobUid: "a2000000-0000-4000-8000-000000000002", jobName: "Job 2", dateS: LATEST_RUN_S - 200 }),
          ],
        });
      }
      if (url.includes("/results/")) {
        return new Response("not found", { status: 404 });
      }
      return undefined;
    });

    const out = JSON.parse(
      await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE, max: 3 }))
    );
    expect(pages).toHaveLength(2);
    expect(out.jobs.map((j: { jobName: string }) => j.jobName)).toEqual(["Job 1", "Job 2", "Job 3"]);
    // A job whose result Datto no longer has is still listed.
    expect(out.jobs[0].statusNote).toMatch(/no stored result/);
  });

  it("refuses to send the token to a paging URL on another host", async () => {
    stubFetch((url) => {
      if (url.startsWith(ACTIVITY_PREFIX)) {
        return jsonResponse({
          pageDetails: { nextPageUrl: "https://attacker.example/api/v2/activity-logs?page=next" },
          activities: [],
        });
      }
      return undefined;
    });

    const text = await errorText(await call("datto_list_device_jobs", { deviceUid: DEVICE }));
    expect(text).toMatch(/outside the configured platform API/);
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("attacker.example"))).toBe(false);
  });

  it("rejects a deviceUid that isn't a UID, before calling the API", async () => {
    stubFetch(() => undefined);
    const text = await errorText(
      await call("datto_list_device_jobs", { deviceUid: 'x" OR device.uid : *' })
    );
    expect(text).toMatch(/deviceUid must be/);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects an invalid or inverted date window", async () => {
    stubFetch(() => undefined);
    expect(
      await errorText(await call("datto_list_device_jobs", { deviceUid: DEVICE, since: "last tuesday" }))
    ).toMatch(/since must be an ISO 8601/);
    expect(
      await errorText(
        await call("datto_list_device_jobs", { deviceUid: DEVICE, since: "2026-11-09", until: "2026-11-01" })
      )
    ).toMatch(/since must be earlier than until/);
  });

  it("surfaces the activity log's database-layer error field", async () => {
    stubFetch((url) =>
      url.startsWith(ACTIVITY_PREFIX) ? jsonResponse({ error: "search backend unavailable" }) : undefined
    );
    const text = await errorText(await call("datto_list_device_jobs", { deviceUid: DEVICE }));
    expect(text).toMatch(/search backend unavailable/);
  });

  it("gives an untimed (pending/running) result only to the newest run, and only when the window reaches now", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const rows = (latestS: number) => [
      activity({ jobUid: RECURRING, jobName: "Daily", dateS: latestS }),
      activity({ jobUid: RECURRING, jobName: "Daily", dateS: latestS - 86400 }),
    ];
    let activityRows = rows(nowS - 60);
    stubFetch((url) => {
      if (url.startsWith(ACTIVITY_PREFIX)) {
        return jsonResponse({ pageDetails: { nextPageUrl: null }, activities: activityRows });
      }
      if (url.includes("/results/")) {
        return jsonResponse({ jobUid: RECURRING, deviceUid: DEVICE, ranOn: null, jobDeploymentStatus: "Running", componentResults: [] });
      }
      return undefined;
    });

    // Default window (until = now): newest row is the latest deployment.
    const live = JSON.parse(await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE })));
    expect(live.jobs[0].status).toBe("Running");
    expect(live.jobs[1].status).toBeUndefined();
    expect(live.jobs[1].statusNote).toMatch(/can't be matched/);

    // Historical window: its newest row may not be the latest deployment.
    activityRows = rows(LATEST_RUN_S);
    const past = JSON.parse(
      await resultText(
        await call("datto_list_device_jobs", { deviceUid: DEVICE, since: "2026-11-01", until: "2026-11-05" })
      )
    );
    expect(past.jobs.map((j: { status?: string }) => j.status)).toEqual([undefined, undefined]);
  });

  it("reports a failed results lookup instead of treating it as 'no stored result'", async () => {
    stubFetch((url) => {
      if (url.startsWith(ACTIVITY_PREFIX)) {
        return jsonResponse({
          pageDetails: { nextPageUrl: null },
          activities: [activity({ jobUid: QUICK, jobName: "Weekly maintenance", dateS: QUICK_RUN_S })],
        });
      }
      if (url.includes("/results/")) {
        return new Response(JSON.stringify({ message: "missing scope" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    });

    const unfiltered = JSON.parse(await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE })));
    expect(unfiltered.jobs[0].statusNote).toMatch(/Results lookup failed/);
    expect(unfiltered.jobs[0].statusNote).not.toMatch(/no stored result/);
    expect(unfiltered.notes.join(" ")).toMatch(/lookups failed/);

    // With a component-name filter the job can't be checked: say the search
    // is incomplete rather than "No job runs matching".
    const filtered = JSON.parse(
      await resultText(await call("datto_list_device_jobs", { deviceUid: DEVICE, name: "nitropdf" }))
    );
    expect(filtered.returned).toBe(0);
    const notes = filtered.notes.join(" ");
    expect(notes).toMatch(/Incomplete search: 1 job/);
    expect(notes).not.toMatch(/No job runs matching/);
  });

  it("reads offset-free since/until as UTC whatever the host time zone", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      let activityUrl = "";
      stubFetch((url) => {
        if (url.startsWith(ACTIVITY_PREFIX)) {
          activityUrl = url;
          return jsonResponse({ pageDetails: { nextPageUrl: null }, activities: [] });
        }
        return undefined;
      });
      const out = JSON.parse(
        await resultText(
          await call("datto_list_device_jobs", {
            deviceUid: DEVICE,
            since: "2026-11-01T09:00:00",
            until: "2026-11-02T09:00",
          })
        )
      );
      const q = new URL(activityUrl).searchParams;
      expect(q.get("from")).toBe("2026-11-01T09:00:00Z");
      expect(q.get("until")).toBe("2026-11-02T09:00:00Z");
      expect(out.since).toBe("2026-11-01T09:00:00Z");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("is annotated read-only in tools/list", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      {}
    );
    const body = (await res.json()) as {
      result?: {
        tools?: {
          name: string;
          annotations?: { readOnlyHint?: boolean };
          inputSchema?: { required?: string[] };
        }[];
      };
    };
    const tool = body.result?.tools?.find((t) => t.name === "datto_list_device_jobs");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema?.required).toEqual(["deviceUid"]);
  });
});
