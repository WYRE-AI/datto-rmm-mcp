#!/usr/bin/env node
/**
 * Datto RMM MCP Server
 *
 * This MCP server provides tools for interacting with Datto RMM API.
 * It accepts credentials via environment variables from the MCP Gateway.
 * Supports both stdio (default) and HTTP (StreamableHTTP) transports.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real
 * secret. A known placeholder is rejected. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch: it logs a warning, skips X-Gateway-S2S, and
 * binds 127.0.0.1 only. A non-loopback MCP_HTTP_HOST is refused in that
 * mode. A configured secret still honors MCP_HTTP_HOST and otherwise
 * binds 0.0.0.0, so container deploys are unchanged. Gateway mode never
 * falls back to DATTO_* env credentials. /health stays unauthenticated.
 * stdio does not use S2S auth.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createMcpServer,
  resolveGatewayCredentials,
  type DattoCredentials,
} from "./mcp-server.js";
import { runWithServerRef, bindServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret and must not boot the HTTP server.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const LOOPBACK_HOST = "127.0.0.1";

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 127.0.0.0/8, localhost, and IPv6 loopback. Anything else is refused in insecure-dev. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty or a known placeholder is fail-closed: the process exits unless the
 * secret is empty AND MCP_ALLOW_INSECURE_DEV=1. A placeholder never counts
 * as set, including when the dev flag is present. The secret value is never
 * written to logs.
 */
function resolveHttpS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (secret && KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    console.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(INSECURE_DEV_WARNING);
    return "";
  }

  console.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * Bind address. A real secret keeps honoring MCP_HTTP_HOST, and an unset
 * host stays on 0.0.0.0 so container deploys (the image sets 0.0.0.0) do
 * not change. No secret is only reachable via MCP_ALLOW_INSECURE_DEV=1,
 * which forces 127.0.0.1. A non-loopback host in that mode refuses to start.
 */
function resolveHttpBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) {
    return configured || "0.0.0.0";
  }
  if (configured === "" || isLoopbackHost(configured)) {
    return LOOPBACK_HOST;
  }
  console.error(
    "Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET " +
      `only binds 127.0.0.1. MCP_HTTP_HOST=${configured} is not loopback. ` +
      "Unset MCP_HTTP_HOST or set it to 127.0.0.1.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session (one process = one caller), so there is no
  // concurrent tenant to isolate from — bind once for the process
  // lifetime rather than per-request. See utils/server-ref.ts.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Datto RMM MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

export async function startHttpTransport(): Promise<HttpServer> {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveHttpBindHost(s2sSecret);
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        transport: "http",
        authMode: isGatewayMode ? "gateway" : "env",
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // MCP endpoint — stateless: fresh server + transport per request
    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
      // A configured secret is always enforced, before credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      // Only POST is supported in stateless mode
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }));
        return;
      }

      // In gateway mode, credentials must arrive on this request. Do not
      // fall through to DATTO_* / X_API_* in process.env: that is not
      // request-scoped and would let any caller who reached this process
      // use the container's vendor credentials (CWE-306).
      let gatewayCredentials: DattoCredentials | undefined;
      if (isGatewayMode) {
        const { creds, error } = resolveGatewayCredentials(
          (name) => headerValue(req.headers[name])
        );
        if (error || !creds) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: "Missing credentials",
            message: error ?? "Gateway mode requires X-Datto-API-Key and X-Datto-API-Secret headers",
            required: ["X-Datto-API-Key", "X-Datto-API-Secret"],
          }));
          return;
        }
        gatewayCredentials = creds;
      }

      // Stateless: create fresh server + transport for each request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      // Bind this request's server into the per-request async context (not
      // a module-level global) so elicitation helpers resolve *this*
      // server/transport even after await gaps, and never a concurrent
      // request's — see utils/server-ref.ts. The whole connect/handleRequest
      // chain, including the .catch(), must stay inside this callback so the
      // bound context survives every await/then gap it spans.
      runWithServerRef(server, () => {
        server.connect(transport as unknown as Transport).then(() => {
          transport.handleRequest(req, res);
        }).catch((err) => {
          console.error("MCP transport error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            }));
          }
        });
      });

      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer!.once("error", onError);
    httpServer!.listen(port, host, () => {
      httpServer!.off("error", onError);
      console.error(`Datto RMM MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`);
      resolve();
    });
  });

  return httpServer!;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Datto RMM MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandlers();

  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch(console.error);
}
