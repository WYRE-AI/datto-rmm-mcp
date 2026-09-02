/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the alert card:
 *   1. renderable tools advertise the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. datto_get_alert results carry the normalized `_card` payload the
 *      iframe renders from
 *
 * Wire-level checks drive the Cloudflare Worker fetch handler (the same
 * Server + transport as production); buildAlertCard is unit-tested directly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { type Env } from "../src/worker.js";
import {
  applyBrandInjection,
  buildAlertCard,
  ALERT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../src/alert-card.js";
import { ALERT_CARD_HTML } from "../src/generated/alert-card-html.js";

const mockAlertsGet = vi.fn();

vi.mock("@wyre-ai/node-datto-rmm", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@wyre-ai/node-datto-rmm")>();
  return {
    ...actual,
    DattoRmmClient: class {
      alerts = { get: mockAlertsGet };
    },
  };
});

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

const RENDERABLE_TOOLS = ["datto_get_alert", "datto_resolve_alert"];

const openAlert = {
  alertUid: "3f8a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8",
  deviceUid: "device-1",
  hostname: "SRV-DC01",
  siteUid: "site-1",
  siteName: "Main Office",
  priority: "Critical",
  status: "open",
  alertCategory: "Performance",
  message: "Drive C: has 4% free space remaining",
  alertContext: { "@class": "perf_disk_usage_ctx", diskName: "C:" },
  muted: false,
  createdAt: 1752742800000,
};

describe("MCP Apps alert card", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          tools?: { name: string; _meta?: Record<string, unknown> }[];
        };
      };
      const tool = body.result?.tools?.find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(ALERT_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        ALERT_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const body = (await res.json()) as {
        result?: {
          tools?: { name: string; _meta?: Record<string, unknown> }[];
        };
      };
      const others = (body.result?.tools ?? []).filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/list",
        params: {},
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { resources?: { uri: string; mimeType?: string }[] };
      };
      const card = body.result?.resources?.find(
        (r) => r.uri === ALERT_CARD_RESOURCE_URI
      );
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: ALERT_CARD_RESOURCE_URI },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { contents?: { uri: string; mimeType?: string; text?: string }[] };
      };
      const content = body.result?.contents?.[0];
      expect(content?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      expect(content?.text).toBe(ALERT_CARD_HTML);
      expect(content?.text).toContain("card__bar");
      expect(content?.text).toContain("BRAND_INJECT");
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content?.text).not.toContain('src="./alert-card.ts"');
    });

    it("injects MCP_BRAND_* env branding at serve time", async () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      const res = await mcp({
        jsonrpc: "2.0",
        id: 7,
        method: "resources/read",
        params: { uri: ALERT_CARD_RESOURCE_URI },
      });
      const body = (await res.json()) as {
        result?: { contents?: { text?: string }[] };
      };
      const text = body.result?.contents?.[0]?.text ?? "";
      expect(text).toContain('window.__BRAND__={"name":"Acme MSP"}');
      expect(text).not.toContain("BRAND_INJECT");
    });

    it("rejects unknown resource URIs", async () => {
      const res = await mcp({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "ui://datto-rmm/nope.html" },
      });
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/Unknown resource/);
    });
  });

  describe("datto_get_alert result", () => {
    it("carries the normalized _card payload alongside the raw alert", async () => {
      mockAlertsGet.mockResolvedValue(openAlert);
      const res = await mcp(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "datto_get_alert",
            arguments: { alertUid: openAlert.alertUid },
          },
        },
        { DATTO_API_KEY: "key", DATTO_API_SECRET: "secret" }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      expect(body.result?.isError).toBeFalsy();
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(payload.alertUid).toBe(openAlert.alertUid);
      expect(payload.message).toBe(openAlert.message);
      expect(payload._card).toEqual({
        alertUid: openAlert.alertUid,
        title: "Disk Usage",
        message: "Drive C: has 4% free space remaining",
        priority: "Critical",
        status: "Open",
        device: "SRV-DC01",
        site: "Main Office",
        category: "Performance",
        createdAt: new Date(1752742800000).toISOString(),
        canResolve: true,
      });
    });
  });

  describe("applyBrandInjection", () => {
    it("replaces the BRAND_INJECT marker with a window.__BRAND__ script", () => {
      const out = applyBrandInjection(ALERT_CARD_HTML, {
        name: "Acme MSP",
        primaryColor: "#ff0000",
      });
      expect(out).not.toContain("BRAND_INJECT");
      expect(out).toContain(
        'window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}'
      );
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(ALERT_CARD_HTML, {
        name: "</script><script>alert(1)",
      });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script");
    });

    it("returns the HTML unchanged for an empty brand", () => {
      expect(applyBrandInjection(ALERT_CARD_HTML, {})).toBe(ALERT_CARD_HTML);
      expect(applyBrandInjection(ALERT_CARD_HTML, { name: "" })).toBe(ALERT_CARD_HTML);
    });
  });

  describe("buildAlertCard", () => {
    it("resolves the alert type label from the context @class", () => {
      const card = buildAlertCard(openAlert);
      expect(card?.title).toBe("Disk Usage");
    });

    it("prefers an explicit alertType over the context label", () => {
      const card = buildAlertCard({ ...openAlert, alertType: "Disk Space" });
      expect(card?.title).toBe("Disk Space");
    });

    it("marks resolved alerts as not resolvable", () => {
      const card = buildAlertCard({
        ...openAlert,
        status: "resolved",
        resolvedAt: 1752750000000,
        resolvedBy: "Dana Ruiz",
      });
      expect(card?.status).toBe("Resolved");
      expect(card?.canResolve).toBe(false);
      expect(card?.resolvedBy).toBe("Dana Ruiz");
    });

    it("truncates long messages", () => {
      const card = buildAlertCard({ ...openAlert, message: "x".repeat(2000) });
      expect(card?.message).toHaveLength(500);
    });

    it("returns null for payloads that are not an alert", () => {
      expect(buildAlertCard(undefined)).toBeNull();
      expect(buildAlertCard({} as never)).toBeNull();
    });

    it("survives sparse alerts (card is best-effort)", () => {
      const card = buildAlertCard({ alertUid: "abc" } as never);
      expect(card).toEqual({
        alertUid: "abc",
        title: "Alert",
        canResolve: true,
      });
    });
  });
});
