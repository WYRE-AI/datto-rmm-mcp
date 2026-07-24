/**
 * Cloudflare Workers entry point for the Datto RMM MCP Server.
 *
 * Serves the full MCP server over the Streamable HTTP transport using the SDK's
 * Web Standard transport (Request/Response), which runs natively on Workers.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node HTTP
 * entrypoints (see `mcp-server.ts`), so there is no second tool implementation
 * to maintain.
 *
 * Credentials are resolved per request, in order:
 * 1. Gateway headers (when AUTH_MODE=gateway):
 *    - X-Datto-API-Key    -> apiKey
 *    - X-Datto-API-Secret -> apiSecretKey
 *    - X-Datto-Platform   -> platform (optional; defaults to concord)
 * 2. Worker secrets / vars (env mode):
 *    - DATTO_API_KEY (or X_API_KEY)
 *    - DATTO_API_SECRET (or X_API_SECRET)
 *    - DATTO_PLATFORM (optional)
 *
 * `tools/list` and `initialize` work without credentials; only `tools/call`
 * requires them.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  resolveGatewayCredentials,
  resolvePlatform,
  type DattoCredentials,
} from "./mcp-server.js";
import { runWithServerRef } from "./utils/server-ref.js";

export interface Env {
  DATTO_API_KEY?: string;
  X_API_KEY?: string;
  DATTO_API_SECRET?: string;
  X_API_SECRET?: string;
  DATTO_PLATFORM?: string;
  AUTH_MODE?: string;
  LOG_LEVEL?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-Datto-API-Key, X-Datto-API-Secret, X-Datto-Platform",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Build credentials from Worker env bindings (env mode). Returns undefined
 * when the required vars are absent (tools/list still works; tools/call errors).
 */
function credentialsFromEnv(env: Env): DattoCredentials | undefined {
  const apiKey = env.DATTO_API_KEY || env.X_API_KEY;
  const apiSecretKey = env.DATTO_API_SECRET || env.X_API_SECRET;
  if (!apiKey || !apiSecretKey) {
    return undefined;
  }
  return {
    apiKey,
    apiSecretKey,
    platform: resolvePlatform(env.DATTO_PLATFORM),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Shallow, unauthenticated liveness probe.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/mcp") {
      const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";

      let credOverrides: DattoCredentials | undefined;
      if (isGatewayMode) {
        const { creds, error } = resolveGatewayCredentials(
          (name) => request.headers.get(name) ?? undefined
        );
        if (error) {
          return json(
            {
              error: "Missing credentials",
              message: error,
              required: ["X-Datto-API-Key", "X-Datto-API-Secret"],
              optional: ["X-Datto-Platform"],
            },
            401
          );
        }
        credOverrides = creds;
      } else {
        credOverrides = credentialsFromEnv(env);
      }

      // Fresh server + transport per request (stateless). The server is
      // bound to the per-request async context (not a module-level global)
      // so elicitation helpers resolve *this* request's server even after
      // await gaps, and never a concurrent request's — see
      // utils/server-ref.ts.
      const server = createMcpServer(credOverrides);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      return runWithServerRef(server, async () => {
        await server.connect(transport);

        try {
          const response = await transport.handleRequest(request);
          return withCors(response);
        } finally {
          await transport.close();
          await server.close();
        }
      });
    }

    return json({ error: "Not found", endpoints: ["/mcp", "/health"] }, 404);
  },
};
