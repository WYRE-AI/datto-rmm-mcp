/**
 * Tests for the Cloudflare Workers entrypoint.
 *
 * Drives the exported `fetch` handler directly with Web Standard Request objects
 * (available natively in Node 18+), exercising the same WebStandardStreamableHTTP
 * transport the Worker uses in production.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "../worker.js";

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

async function mcp(body: unknown, env: Env = {}): Promise<Response> {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("Cloudflare Worker entrypoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves a shallow health probe", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/health"),
      {}
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers CORS preflight", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", { method: "OPTIONS" }),
      {}
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("404s unknown paths", async () => {
    const res = await worker.fetch(new Request("http://worker.local/nope"), {});
    expect(res.status).toBe(404);
  });

  it("handles MCP initialize", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(body.result?.serverInfo?.name).toBe("datto-rmm-mcp");
  });

  it("lists all tools without credentials", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("datto_list_devices");
    expect(names).toContain("datto_list_sites");
    expect(names.length).toBeGreaterThan(5);
  });

  it("marks read-only tools with readOnlyHint and leaves mutating tools unannotated", async () => {
    const res = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const body = (await res.json()) as {
      result?: {
        tools?: {
          name: string;
          annotations?: { readOnlyHint?: boolean };
        }[];
      };
    };
    const tools = body.result?.tools ?? [];

    // Representative read-only tool: annotated true.
    const listDevices = tools.find((t) => t.name === "datto_list_devices");
    expect(listDevices?.annotations?.readOnlyHint).toBe(true);

    // Known mutating tool: must NOT carry readOnlyHint. This is the
    // assertion that guards against a careless future sweep annotating
    // every tool indiscriminately.
    const runQuickjob = tools.find((t) => t.name === "datto_run_quickjob");
    expect(runQuickjob?.annotations?.readOnlyHint).not.toBe(true);
  });

  it("returns a graceful error for a credential-requiring tool when unconfigured", async () => {
    // Ensure no ambient credentials leak in from the test environment.
    vi.stubEnv("DATTO_API_KEY", "");
    vi.stubEnv("DATTO_API_SECRET", "");
    vi.stubEnv("X_API_KEY", "");
    vi.stubEnv("X_API_SECRET", "");
    const res = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "datto_get_device", arguments: { deviceUid: "x" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/credentials/i);
  });

  it("rejects /mcp in gateway mode without credential headers", async () => {
    const res = await mcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "datto_get_device", arguments: { deviceUid: "x" } },
      },
      { AUTH_MODE: "gateway" }
    );
    expect(res.status).toBe(401);
  });
});
