/**
 * Instrumented call-counter probe for the S2S guard ordering invariant
 * (boss's ordering-catch rule, 2026-07-28 S2S rollout evidence report).
 *
 * datto-rmm-mcp's own credential resolution (resolveGatewayCredentials in
 * src/mcp-server.ts) is a pure header read, but the vendored
 * @wyre-ai/node-datto-rmm SDK's AuthManager has its own lazy
 * side effect: getToken() calls acquireToken() -> doAcquireToken(), a real
 * outbound OAuth2 password-grant POST to
 * `${apiUrl}/auth/oauth/token` (apiUrl derives from the "platform" -- default
 * "concord" -> https://concord-api.centrastage.net), the first time any
 * tool needing API access executes. A generic grant/deny test can't catch a
 * future ordering regression here since the token acquisition only fires
 * lazily inside tool dispatch, currently correctly ordered after the S2S
 * guard -- this test is regression insurance, not proof of a current bug.
 *
 * Drives a real tools/call round-trip (datto_list_sites, no required args)
 * through the actual HTTP server -- no mocking of index.ts/mcp-server.ts.
 * Only the network boundary (Datto's own host) is stubbed, with a
 * passthrough for the test's own loopback request.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';

const TEST_PORT = 47006;
const TEST_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';
const DATTO_HOST = 'https://concord-api.centrastage.net';

let tokenCalls = 0;
let sitesCalls = 0;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      tokenCalls++;
      return new Response(
        JSON.stringify({
          access_token: 'fake-access-token',
          token_type: 'bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.startsWith(`${DATTO_HOST}/api/v2/`)) {
      sitesCalls++;
      return new Response(JSON.stringify({ items: [], pageDetails: { count: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Everything else (notably the test's own loopback calls into the
    // in-process server below) goes through to the real fetch untouched.
    return realFetch(input, init);
  }) as typeof fetch;

  process.env.MCP_TRANSPORT = 'http';
  process.env.AUTH_MODE = 'gateway';
  process.env.MCP_HTTP_PORT = String(TEST_PORT);
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.CONDUIT_S2S_SECRET = TEST_SECRET;
  await import('../index.js');
  await waitForServerReady();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await realFetch(`http://127.0.0.1:${TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('datto-rmm-mcp test HTTP server did not become ready in time');
}

async function callListSites(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'datto_list_sites', arguments: {} },
      id: 1,
    }),
  });
}

const VALID_DATTO_HEADERS = {
  'x-datto-api-key': 'test-api-key',
  'x-datto-api-secret': 'test-api-secret',
};

describe('S2S guard ordering vs. lazy Datto RMM OAuth token acquisition', () => {
  it('does NOT call the Datto OAuth token endpoint when the S2S header is missing', async () => {
    tokenCalls = 0;
    sitesCalls = 0;
    const res = await callListSites(VALID_DATTO_HEADERS);
    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(sitesCalls).toBe(0);
  });

  it('does NOT call the Datto OAuth token endpoint when the S2S header is present but invalid', async () => {
    tokenCalls = 0;
    sitesCalls = 0;
    const res = await callListSites({
      'x-gateway-s2s': mintS2sHeader('wrong-secret', Math.floor(Date.now() / 1000)),
      ...VALID_DATTO_HEADERS,
    });
    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(sitesCalls).toBe(0);
  });

  it('DOES call the Datto OAuth token endpoint exactly once on a real accepted tool call (negative control)', async () => {
    tokenCalls = 0;
    sitesCalls = 0;
    const res = await callListSites({
      'x-gateway-s2s': mintS2sHeader(TEST_SECRET, Math.floor(Date.now() / 1000)),
      ...VALID_DATTO_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBeFalsy();
    expect(tokenCalls).toBe(1);
    expect(sitesCalls).toBe(1);
  });
});
