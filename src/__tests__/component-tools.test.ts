/**
 * Coverage for datto_list_components, which wraps the SDK's
 * `client.account.componentsAll()` resource.
 *
 * Before this tool existed there was no way to get a componentUid for
 * datto_run_quickjob short of copying it out of the Datto RMM web UI by
 * hand — datto_get_job_components only works retroactively, on a job that
 * has already run.
 *
 * The stubbed responses below use the real `GET /account/components` shape,
 * confirmed live against a real Datto RMM account (2026-09-26,
 * `?max=250`, 250+ components inspected): every component has exactly
 * `id`, `credentialsRequired`, `uid`, `name`, `description`, `categoryCode`,
 * `variables` — there is no `level` or `category` field.
 *
 * Follows the same technique as job-tools.test.ts: drive a real
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

async function resultJson(res: Response): Promise<{
  totalMatched: number;
  returned: number;
  components: {
    uid: string;
    name: string;
    description?: string;
    categoryCode?: string;
    credentialsRequired?: boolean;
    variables?: {
      name?: string;
      type?: string;
      defaultValue?: string;
      description?: string;
    }[];
  }[];
}> {
  const body = (await res.json()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
  };
  expect(body.result?.isError).toBeFalsy();
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
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

const PAGE_1_URL = `${DATTO_HOST}/api/v2/account/components`;
const PAGE_2_URL = `${DATTO_HOST}/api/v2/account/components?page=2`;

/**
 * A two-page catalogue matching the live response shape. The
 * "Disk Cleanup [WIN]" component only shows up on page 2, and carries a
 * `variables` entry — the input datto_run_quickjob needs filled in.
 */
function stubTwoPageCatalogue() {
  stubFetch((url) => {
    if (url === PAGE_1_URL) {
      return jsonResponse({
        pageDetails: { count: 1, prevPageUrl: null, nextPageUrl: PAGE_2_URL },
        components: [
          {
            id: 111,
            uid: "component-restart",
            name: "Restart Service",
            description: "Restarts a Windows service",
            categoryCode: "scripts",
            credentialsRequired: false,
            variables: [
              {
                name: "ServiceName",
                type: "string",
                defaultValue: "Spooler",
                description: "The Windows service name to restart",
              },
            ],
          },
        ],
      });
    }
    if (url === PAGE_2_URL) {
      return jsonResponse({
        pageDetails: { count: 1, prevPageUrl: PAGE_1_URL, nextPageUrl: null },
        components: [
          {
            id: 222,
            uid: "component-disk-cleanup",
            name: "Disk Cleanup [WIN]",
            description: "Frees up disk space",
            categoryCode: "scripts",
            credentialsRequired: true,
            variables: [],
          },
        ],
      });
    }
    return undefined;
  });
}

describe("datto_list_components", () => {
  it("is listed in tools/list with a description that explains the 500-vs-403 diagnosis", async () => {
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
      result?: { tools?: { name: string; description?: string }[] };
    };
    const tool = (body.result?.tools ?? []).find(
      (t) => t.name === "datto_list_components"
    );
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("HTTP 500");
    expect(tool?.description).toContain("403");
    expect(tool?.description).toContain("Level");
    expect(tool?.description).toContain("datto_run_quickjob");
  });

  it("finds a component by a case-insensitive name substring across pages (acceptance case)", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", { name: "disk" });
    const { totalMatched, returned, components } = await resultJson(res);

    expect(totalMatched).toBe(1);
    expect(returned).toBe(1);
    expect(components).toHaveLength(1);
    expect(components[0].uid).toBe("component-disk-cleanup");
    expect(components[0].name).toBe("Disk Cleanup [WIN]");
  });

  it("matches case-insensitively regardless of the filter's own casing", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", { name: "DiSk" });
    const { components } = await resultJson(res);

    expect(components).toHaveLength(1);
    expect(components[0].uid).toBe("component-disk-cleanup");
  });

  it("applies the name filter across all pages, not just the first", async () => {
    stubTwoPageCatalogue();

    // "Disk Cleanup [WIN]" only exists on page 2 — a filter that stopped
    // after page 1 would miss it entirely.
    const res = await call("datto_list_components", { name: "cleanup" });
    const { totalMatched, components } = await resultJson(res);

    expect(totalMatched).toBe(1);
    expect(components[0].uid).toBe("component-disk-cleanup");
  });

  it("honours max, truncating after collecting across pages", async () => {
    stubFetch((url) => {
      if (url === PAGE_1_URL) {
        return jsonResponse({
          pageDetails: { count: 2, prevPageUrl: null, nextPageUrl: PAGE_2_URL },
          components: [
            { id: 1, uid: "c1", name: "Alpha Cleanup", categoryCode: "scripts" },
            { id: 2, uid: "c2", name: "Beta Cleanup", categoryCode: "scripts" },
          ],
        });
      }
      if (url === PAGE_2_URL) {
        return jsonResponse({
          pageDetails: { count: 2, prevPageUrl: PAGE_1_URL, nextPageUrl: null },
          components: [
            { id: 3, uid: "c3", name: "Gamma Cleanup", categoryCode: "monitors" },
            { id: 4, uid: "c4", name: "Delta Cleanup", categoryCode: "monitors" },
          ],
        });
      }
      return undefined;
    });

    const res = await call("datto_list_components", {
      name: "cleanup",
      max: 2,
    });
    const { totalMatched, returned, components } = await resultJson(res);

    // All 4 matched the filter, but only 2 are returned.
    expect(totalMatched).toBe(4);
    expect(returned).toBe(2);
    expect(components).toHaveLength(2);
  });

  it("defaults max to 50 when no name filter is given", async () => {
    stubFetch((url) => {
      if (url === PAGE_1_URL) {
        return jsonResponse({
          pageDetails: { count: 1, prevPageUrl: null, nextPageUrl: null },
          components: [
            {
              id: 1,
              uid: "c1",
              name: "Restart Service",
              categoryCode: "scripts",
            },
          ],
        });
      }
      return undefined;
    });

    const res = await call("datto_list_components", {});
    const { returned, components } = await resultJson(res);
    expect(returned).toBe(1);
    expect(components[0].uid).toBe("c1");
  });

  it("returns an empty result cleanly when nothing matches", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", { name: "nonexistent" });
    const { totalMatched, returned, components } = await resultJson(res);

    expect(totalMatched).toBe(0);
    expect(returned).toBe(0);
    expect(components).toEqual([]);
  });

  it("returns an empty result cleanly when the account has no components at all", async () => {
    stubFetch((url) => {
      if (url === PAGE_1_URL) {
        return jsonResponse({
          pageDetails: { count: 0, prevPageUrl: null, nextPageUrl: null },
          components: [],
        });
      }
      return undefined;
    });

    const res = await call("datto_list_components", {});
    const { totalMatched, returned, components } = await resultJson(res);

    expect(totalMatched).toBe(0);
    expect(returned).toBe(0);
    expect(components).toEqual([]);
  });

  it("does not return a `level` field (the live API never sends one)", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", {});
    const { components } = await resultJson(res);

    for (const component of components) {
      expect(component).not.toHaveProperty("level");
    }
  });

  it("includes categoryCode and credentialsRequired for every returned component", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", {});
    const { components } = await resultJson(res);

    expect(components).toHaveLength(2);
    for (const component of components) {
      expect(component.categoryCode).toBe("scripts");
      expect(typeof component.credentialsRequired).toBe("boolean");
    }
    expect(
      components.find((c) => c.uid === "component-disk-cleanup")
        ?.credentialsRequired
    ).toBe(true);
  });

  it("falls back to `category` when the API sends that spelling instead of categoryCode", async () => {
    stubFetch((url) => {
      if (url === PAGE_1_URL) {
        return jsonResponse({
          pageDetails: { count: 1, prevPageUrl: null, nextPageUrl: null },
          components: [
            {
              id: 1,
              uid: "c1",
              name: "Something",
              category: "SECURITY",
            },
          ],
        });
      }
      return undefined;
    });

    const res = await call("datto_list_components", {});
    const { components } = await resultJson(res);
    expect(components[0].categoryCode).toBe("SECURITY");
  });

  it("returns a compact variables summary for datto_run_quickjob (variables example)", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", { name: "restart" });
    const { components } = await resultJson(res);

    expect(components).toHaveLength(1);
    expect(components[0].variables).toEqual([
      {
        name: "ServiceName",
        type: "string",
        defaultValue: "Spooler",
        description: "The Windows service name to restart",
      },
    ]);
  });

  it("returns an empty variables array for a component with no expected variables", async () => {
    stubTwoPageCatalogue();

    const res = await call("datto_list_components", { name: "disk" });
    const { components } = await resultJson(res);

    expect(components[0].variables).toEqual([]);
  });
});
