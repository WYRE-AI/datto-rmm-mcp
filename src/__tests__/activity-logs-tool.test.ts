/**
 * datto_list_activity_logs: `GET /v2/activity-logs` with the documented
 * filters, a client-side user/hostname match, and a cursor that resumes
 * part-way through a page. Driven through the Worker entrypoint with only
 * the Datto RMM host stubbed. All names and ids are made up.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };
const PREFIX = `${DATTO_HOST}/api/v2/activity-logs?`;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

async function call(name: string, args: Record<string, unknown>, env: Record<string, string> = ENV) {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env
  );
}

/** Asserts the <datto-data> boundary and returns the parsed JSON inside it. */
async function result(res: Response) {
  const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  expect(body.result?.isError).toBeFalsy();
  const text = body.result?.content?.[0]?.text ?? "";
  expect(text.startsWith("<datto-data>\n")).toBe(true);
  return JSON.parse(text.slice("<datto-data>\n".length, text.indexOf("\n</datto-data>")));
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  expect(body.result?.isError).toBe(true);
  return body.result?.content?.[0]?.text ?? "";
}

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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const ALEX = { id: 101, userName: "alex.tech", firstName: "Alex", lastName: "Tech" };
const SAM = { id: 202, userName: "sam.ops", firstName: "Sam", lastName: "Ops" };

// 2026-11-19T22:00:00Z
const T0 = 1795125600;

function row(n: number, user: typeof ALEX | null, extra: Record<string, unknown> = {}) {
  return {
    id: `row-${n}`,
    entity: "USER",
    category: "user",
    action: "login",
    date: T0 - n * 60 + 0.25,
    site: null,
    user,
    details: JSON.stringify({ "user.username": user?.userName ?? "", ip: "192.0.2.10" }),
    ...extra,
  };
}

function page(activities: unknown[], nextPageUrl: string | null = null) {
  return json({ pageDetails: { count: activities.length, nextPageUrl }, activities });
}

describe("datto_list_activity_logs", () => {
  it("sends a 7-day window, newest first, and returns compact rows with a summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    const seen = stubFetch((url) =>
      url.startsWith(PREFIX)
        ? page([
            row(1, ALEX),
            row(2, SAM, {
              entity: "DEVICE",
              category: "job",
              action: "deployment",
              hostname: "WS-01",
              deviceId: 55,
              site: { id: 7, name: "Example Site" },
              details: JSON.stringify({ "job.name": "x".repeat(300), "device.hostname": "WS-01" }),
            }),
          ])
        : undefined
    );

    const out = await result(await call("datto_list_activity_logs", {}));

    const q = new URL(seen[0]).searchParams;
    expect(q.get("from")).toBe("2026-11-13T00:00:00Z");
    expect(q.get("until")).toBe("2026-11-20T00:00:00Z");
    expect(q.get("order")).toBe("desc");
    expect(q.get("size")).toBe("100");
    for (const k of ["entities", "categories", "actions", "siteIds", "userIds", "searchQuery"]) {
      expect(q.has(k)).toBe(false);
    }

    expect(out.returned).toBe(2);
    expect(out.summary).toEqual({ "user/login": 1, "job/deployment": 1 });
    expect(out.activities[0]).toEqual({
      time: "2026-11-19T21:59:00.250Z",
      entity: "user",
      category: "user",
      action: "login",
      user: "alex.tech",
      userFullName: "Alex Tech",
      userId: 101,
      details: { "user.username": "alex.tech", ip: "192.0.2.10" },
    });
    expect(out.activities[1]).toMatchObject({ entity: "device", site: "Example Site", siteId: 7, hostname: "WS-01", deviceId: 55 });
    expect(out.activities[1].details["job.name"]).toHaveLength(201);
    expect(out.nextCursor).toBeUndefined();
  });

  it("passes the documented filters to the API", async () => {
    const seen = stubFetch((url) => (url.startsWith(PREFIX) ? page([]) : undefined));

    await call("datto_list_activity_logs", {
      from: "2026-11-01",
      until: "2026-11-02T12:00:00",
      entity: "User",
      category: "user, Remote Control",
      action: "login,Patch Start",
      siteId: 7,
      userId: 101,
      hostname: "WS-01",
      search: 'site.name:"Example Site"',
      order: "asc",
    });

    const q = new URL(seen[0]).searchParams;
    expect(q.get("from")).toBe("2026-11-01T00:00:00Z");
    expect(q.get("until")).toBe("2026-11-02T12:00:00Z");
    expect(q.get("entities")).toBe("user");
    expect(q.get("categories")).toBe("user,Remote Control");
    expect(q.get("actions")).toBe("login,Patch Start");
    expect(q.get("siteIds")).toBe("7");
    expect(q.get("userIds")).toBe("101");
    expect(q.get("order")).toBe("asc");
    expect(q.get("searchQuery")).toBe('device.hostname : "WS-01" AND (site.name:"Example Site")');
  });

  it("matches user by username or name across pages, and says the user's last login", async () => {
    const page2 = `${PREFIX}searchAfter=abc&page=next`;
    const seen = stubFetch((url) => {
      if (url === page2) return page([row(3, SAM), row(4, ALEX)]);
      if (url.startsWith(PREFIX)) return page([row(1, SAM), row(2, SAM)], page2);
      return undefined;
    });

    const out = await result(await call("datto_list_activity_logs", { user: "ALEX TECH", entity: "user" }));

    expect(seen).toHaveLength(2);
    expect(out.scanned).toBe(4);
    expect(out.activities.map((a: { user: string }) => a.user)).toEqual(["alex.tech"]);
    expect(out.activities[0].action).toBe("login");
  });

  it("resumes from nextCursor part-way through a page without skipping or repeating rows", async () => {
    const page2 = `${PREFIX}searchAfter=abc&page=next`;
    const first = [row(1, ALEX), row(2, SAM), row(3, ALEX), row(4, ALEX)];
    const seen = stubFetch((url) => {
      if (url === page2) return page([row(5, ALEX)]);
      if (url.startsWith(PREFIX)) return page(first, page2);
      return undefined;
    });

    const one = await result(await call("datto_list_activity_logs", { user: "alex", max: 2 }));
    expect(one.activities.map((a: { time: string }) => a.time)).toEqual([
      new Date((T0 - 60 + 0.25) * 1000).toISOString(),
      new Date((T0 - 180 + 0.25) * 1000).toISOString(),
    ]);
    expect(one.nextCursor).toEqual(expect.any(String));

    const two = await result(await call("datto_list_activity_logs", { cursor: one.nextCursor, max: 5, user: "ignored" }));
    expect(two.activities.map((a: { time: string }) => a.time)).toEqual([
      new Date((T0 - 240 + 0.25) * 1000).toISOString(),
      new Date((T0 - 300 + 0.25) * 1000).toISOString(),
    ]);
    expect(two.nextCursor).toBeUndefined();
    // The cursor re-reads the same first page (a fixed searchAfter pointer), then follows paging.
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(page2);
  });

  it("says clearly when nothing is found", async () => {
    stubFetch((url) => (url.startsWith(PREFIX) ? page([row(1, SAM)]) : undefined));

    const out = await result(await call("datto_list_activity_logs", { user: "nobody" }));

    expect(out.returned).toBe(0);
    expect(out.activities).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/No activity-log entries found for user "nobody".*Administrator security level/);
  });

  it("stops after 10 pages and hands back a cursor", async () => {
    let n = 0;
    const seen = stubFetch((url) => {
      if (!url.startsWith(PREFIX)) return undefined;
      n++;
      return page([row(n, SAM)], `${PREFIX}searchAfter=p${n}&page=next`);
    });

    const out = await result(await call("datto_list_activity_logs", { user: "alex" }));

    expect(seen).toHaveLength(10);
    expect(out.nextCursor).toEqual(expect.any(String));
    expect(out.notes.join(" ")).toMatch(/Stopped after reading 10 pages/);
  });

  it("does not follow a paging URL to another host or endpoint", async () => {
    stubFetch((url) => (url.startsWith(PREFIX) ? page([row(1, SAM)], "https://example.invalid/api/v2/activity-logs?x=1") : undefined));
    expect(await errorText(await call("datto_list_activity_logs", { user: "alex" }))).toMatch(/Refusing to follow/);
  });

  it("rejects bad input before calling Datto, including the OAuth token request", async () => {
    // A credential no other test uses, so the token cache is cold and a token request would show.
    const coldEnv = { DATTO_API_KEY: "cold-validation-key", DATTO_API_SECRET: "cold-validation-secret" };
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seen.push(typeof input === "string" ? input : input.toString());
      throw new Error("no request may be sent for bad input");
    }) as typeof fetch;
    const forged = Buffer.from(JSON.stringify({ u: "/v2/account/users?max=1", s: 0 })).toString("base64url");
    for (const [args, message] of [
      [{ entity: "site" }, /entity must be/],
      [{ from: "last tuesday" }, /from must be an ISO 8601/],
      [{ from: "2026-11-09", until: "2026-11-01" }, /from must be earlier than until/],
      [{ from: "2026-11-01T09:00:00.100Z", until: "2026-11-01T09:00:00.900Z" }, /whole seconds/],
      [{ siteId: true }, /siteId must be a number/],
      [{ userId: "abc" }, /userId must be a number/],
      [{ user: 5 }, /user must be a string/],
      [{ category: "job;drop" }, /category must be/],
      [{ action: "Patch  Start" }, /action must be/],
      [{ siteId: -1 }, /siteId must be a positive whole number/],
      [{ hostname: 'WS" OR *' }, /hostname must be/],
      [{ cursor: "not-a-cursor" }, /cursor is not a nextCursor/],
      [{ cursor: forged }, /cursor is not a nextCursor/],
    ] as const) {
      expect(await errorText(await call("datto_list_activity_logs", args, coldEnv))).toMatch(message);
    }
    expect(seen).toEqual([]);
  });

  it("returns the hostname it matched on, even when it is only in details", async () => {
    stubFetch((url) =>
      url.startsWith(PREFIX)
        ? page([row(1, SAM, { entity: "DEVICE", details: JSON.stringify({ "device.hostname": "WS-01" }) })])
        : undefined
    );
    const out = await result(await call("datto_list_activity_logs", { hostname: "WS-01" }));
    expect(out.activities).toHaveLength(1);
    expect(out.activities[0].hostname).toBe("WS-01");
  });

  it("keeps paging past an empty page while nextPageUrl is set", async () => {
    const seen = stubFetch((url) => {
      if (!url.startsWith(PREFIX)) return undefined;
      return url.includes("searchAfter=2") ? page([row(1, ALEX)]) : page([], `${PREFIX}searchAfter=2`);
    });
    const out = await result(await call("datto_list_activity_logs", {}));
    expect(seen).toHaveLength(2);
    expect(out.returned).toBe(1);
  });

  it("names the cursor's saved user filter when a resumed search finds nothing", async () => {
    stubFetch((url) => (url.startsWith(PREFIX) ? page([row(1, SAM)]) : undefined));
    const cursor = Buffer.from(JSON.stringify({ u: "/v2/activity-logs?order=desc", s: 0, user: "alex" })).toString("base64url");
    const out = await result(await call("datto_list_activity_logs", { cursor, user: "Sam" }));
    expect(out.returned).toBe(0);
    expect(out.notes.join(" ")).toMatch(/user "alex"/);
    expect(out.notes.join(" ")).not.toMatch(/Sam/);
  });

  it("reports a 429 without retrying", async () => {
    const seen = stubFetch((url) =>
      url.startsWith(PREFIX) ? json({ message: "Too Many Requests" }, 429, { "Retry-After": "15" }) : undefined
    );
    const text = await errorText(await call("datto_list_activity_logs", {}));
    expect(seen).toHaveLength(1);
    expect(text).toMatch(/429/);
  });

  it("is listed as read-only with no required arguments", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      ENV
    );
    const body = (await res.json()) as {
      result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: { required?: string[] } }[] };
    };
    const tool = body.result?.tools?.find((t) => t.name === "datto_list_activity_logs");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema?.required).toBeUndefined();
  });
});
