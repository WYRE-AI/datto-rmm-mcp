/**
 * HTTP transport fails closed (CWE-306).
 *
 * Startup refuses to listen when CONDUIT_S2S_SECRET is empty or a known
 * placeholder, unless MCP_ALLOW_INSECURE_DEV=1 (empty secret only). That
 * bypass forces 127.0.0.1 and refuses a non-loopback MCP_HTTP_HOST.
 * A real secret still honors MCP_HTTP_HOST and otherwise binds 0.0.0.0.
 * Gateway-mode /mcp requests without vendor credential headers are 401
 * and must not consult process.env credentials.
 */
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dattoClientMock = vi.hoisted(() => vi.fn());

vi.mock("@wyre-ai/node-datto-rmm", () => ({
  DattoRmmClient: vi.fn().mockImplementation(function (options: unknown) {
    dattoClientMock(options);
    return {
      account: {
        sitesAll() {
          return (async function* sites() {
            yield { uid: "site-1", name: "Site" };
          })();
        },
      },
    };
  }),
}));

import { startHttpTransport } from "../index.js";

const S2S_SECRET = "test-s2s-fail-closed-secret-do-not-log";
const ENV_API_KEY = "env-api-key-must-not-be-used";
const ENV_API_SECRET = "env-api-secret-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "DATTO_API_KEY",
  "DATTO_API_SECRET",
  "DATTO_PLATFORM",
  "X_API_KEY",
  "X_API_SECRET",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${options.port}${options.path}`, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    req.then(async (res) => {
      resolve({ status: res.status, body: await res.text() });
    }).catch(reject);
  });
}

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const sitesCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "datto_list_sites", arguments: {} },
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  dattoClientMock.mockClear();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

function resetEnv(): void {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "info";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.DATTO_API_KEY;
  delete process.env.DATTO_API_SECRET;
  delete process.env.DATTO_PLATFORM;
  delete process.env.X_API_KEY;
  delete process.env.X_API_SECRET;
}

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    resetEnv();
    const logs = captureStderr();
    const exitSpy = mockExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const text = logs.text();
    expect(text).toContain("Refusing to start HTTP transport");
    expect(text).toContain("CONDUIT_S2S_SECRET is empty");
    expect(text).not.toContain(S2S_SECRET);
  });

  it("refuses a whitespace-only secret", async () => {
    resetEnv();
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    mockExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    resetEnv();
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    mockExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("Refusing to start HTTP transport");
    expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it.each(["changeme", "  Your-S2S-Secret  ", "replace-with-a-real-secret"])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      resetEnv();
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exitSpy = mockExit();

      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).toContain("openssl rand -hex 32");
      expect(text).not.toContain(placeholder.trim());
      expect(text).not.toContain(S2S_SECRET);
    },
  );

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    resetEnv();
    process.env.CONDUIT_S2S_SECRET = "changeme";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    mockExit();

    await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
    expect(logs.text()).toContain("known placeholder");
    expect(logs.text()).not.toContain("changeme");
  });

  it("allows startup with a warning and binds 127.0.0.1 when MCP_ALLOW_INSECURE_DEV=1", async () => {
    resetEnv();
    delete process.env.MCP_HTTP_HOST;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    const exitSpy = mockExit();

    const server = await listen();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(server.address).toBe("127.0.0.1");
    const text = logs.text();
    expect(text).toContain("SECURITY WARNING");
    expect(text).toContain("CONDUIT_S2S_SECRET");
    expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
    expect(text).toContain("127.0.0.1");
    expect(text).not.toContain(S2S_SECRET);
  });

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    resetEnv();
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    mockExit();

    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
    expect(logs.text()).toContain("SECURITY WARNING");
    expect(logs.text()).toContain("127.0.0.1");
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "refuses the dev bypass when MCP_HTTP_HOST is %s",
    async (host) => {
      resetEnv();
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = mockExit();

      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("127.0.0.1");
      expect(text).toContain(`MCP_HTTP_HOST=${host}`);
      expect(text).not.toContain(S2S_SECRET);
    },
  );

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    resetEnv();
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    mockExit();

    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
    expect(logs.text()).not.toContain("not loopback");
    expect(logs.text()).not.toContain(S2S_SECRET);
  });

  it("keeps the 0.0.0.0 default when a secret is set and MCP_HTTP_HOST is unset", async () => {
    resetEnv();
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    mockExit();

    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
  });
});

describe("HTTP /mcp authentication", () => {
  async function startGateway(): Promise<{ port: number }> {
    resetEnv();
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.DATTO_API_KEY = ENV_API_KEY;
    process.env.DATTO_API_SECRET = ENV_API_SECRET;
    process.env.DATTO_PLATFORM = "zinfandel";
    process.env.X_API_KEY = ENV_API_KEY;
    process.env.X_API_SECRET = ENV_API_SECRET;
    mockExit();
    const server = await listen();
    return { port: server.port };
  }

  it("returns 401 when the S2S header is missing or invalid and does not use env credentials", async () => {
    const logs = captureStderr();
    const { port } = await startGateway();

    const missing = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-datto-api-key": "header-key",
        "x-datto-api-secret": "header-secret",
      }),
      body: sitesCall,
    });
    const invalid = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader("wrong-secret"),
        "x-datto-api-key": "header-key",
        "x-datto-api-secret": "header-secret",
      }),
      body: sitesCall,
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(missing.body).toContain("X-Gateway-S2S");
    expect(invalid.body).toContain("X-Gateway-S2S");
    expect(missing.body).not.toContain(S2S_SECRET);
    expect(invalid.body).not.toContain(S2S_SECRET);
    expect(missing.body).not.toContain(ENV_API_KEY);
    expect(invalid.body).not.toContain(ENV_API_SECRET);
    expect(logs.text()).not.toContain(S2S_SECRET);
    expect(dattoClientMock).not.toHaveBeenCalled();
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const { port } = await startGateway();

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: sitesCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("Missing credentials");
    expect(response.body).toContain("X-Datto-API-Key");
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain(ENV_API_SECRET);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain("zinfandel");
    expect(dattoClientMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-datto-api-key": "header-key",
      }),
      body: sitesCall,
    });
    expect(partial.status).toBe(401);
    expect(dattoClientMock).not.toHaveBeenCalled();
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const { port } = await startGateway();

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-datto-api-key": "header-key",
        "x-datto-api-secret": "header-secret",
        "x-datto-platform": "merlot",
      }),
      body: sitesCall,
    });

    expect(response.status).toBe(200);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain(ENV_API_SECRET);
    expect(dattoClientMock).toHaveBeenCalledWith({
      apiKey: "header-key",
      apiSecretKey: "header-secret",
      platform: "merlot",
    });
    expect(logs.text()).not.toContain(S2S_SECRET);
    expect(logs.text()).not.toContain(ENV_API_SECRET);
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const { port } = await startGateway();
    const response = await sendHttp({
      port,
      method: "GET",
      path: "/health",
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; authMode?: string };
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain(ENV_API_SECRET);
    expect(dattoClientMock).not.toHaveBeenCalled();
  });
});
