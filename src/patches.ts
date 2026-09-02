/**
 * Windows patch installation/compliance data for a device or site.
 *
 * Datto RMM 15.1.0 (rolled out July-Aug 2026) added two new v2 endpoints -
 * GET /v2/device/{deviceUid}/patches and GET /v2/sites/{siteUid}/patches -
 * that the upstream @wyre-technology/node-datto-rmm SDK doesn't wrap yet
 * (checked main as of this writing: no resources/patches.ts). DattoRmmClient
 * keeps its HttpClient/AuthManager private, so there's no way to piggyback
 * on the SDK's own token caching from outside it without either forking the
 * SDK too or reaching into its internals - this instead does its own
 * minimal OAuth token acquisition, deliberately mirroring
 * node-datto-rmm's src/auth.ts and src/config.ts exactly (same token
 * endpoint, same public-client:public Basic auth, same platform->URL map),
 * so swapping this out for a real SDK method later (once/if upstream adds
 * one) is a drop-in replacement rather than a behavior change.
 *
 * Live-tested against our own Datto RMM account (syrah platform) before
 * writing this: GET /v2/device/{uid}/patches returns
 * { pageDetails, patches: [{ patchId, category, type, title, description,
 * releaseDate, severity, maxSize, rebootRequired, requireUserInput,
 * kbArticleId, installStatus, manualOverride }] } - installStatus is the
 * per-patch installed/missing/pending signal this module exists to expose.
 */

import type { Platform } from "@wyre-technology/node-datto-rmm";
import type { DattoCredentials } from "./mcp-server.js";

const PLATFORM_URLS: Record<Platform, string> = {
  pinotage: "https://pinotage-api.centrastage.net",
  merlot: "https://merlot-api.centrastage.net",
  concord: "https://concord-api.centrastage.net",
  vidal: "https://vidal-api.centrastage.net",
  zinfandel: "https://zinfandel-api.centrastage.net",
  syrah: "https://syrah-api.centrastage.net",
};

// One token per CREDENTIAL SET (platform + apiKey), refreshed on expiry -
// deliberately not shared with DattoRmmClient's own AuthManager (that
// instance is per-request in gateway mode anyway, per mcp-server.ts's header
// comment on credential isolation), so this trades a little redundant token
// acquisition for staying fully decoupled from the SDK's private internals.
//
// Keyed by platform+apiKey rather than a single module-level slot: this
// server runs in gateway mode, i.e. one process handling many different MSP
// customers' credentials over its lifetime. With only six platform values
// and presumably many more than six customers, a platform-only key meant any
// two customers on the same platform bucket would collide and silently
// receive each other's cached access token - a cross-tenant credential leak,
// not a hypothetical. apiKey uniquely identifies the credential set without
// needing to hash in apiSecretKey too.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function tokenCacheKey(creds: DattoCredentials): string {
  return `${creds.platform}:${creds.apiKey}`;
}

async function getAccessToken(creds: DattoCredentials): Promise<string> {
  const apiUrl = PLATFORM_URLS[creds.platform];
  const cacheKey = tokenCacheKey(creds);

  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.accessToken;
  }

  const basicAuth = Buffer.from("public-client:public").toString("base64");
  const response = await fetch(`${apiUrl}/auth/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: creds.apiKey,
      password: creds.apiSecretKey,
    }).toString(),
  });

  if (!response.ok) {
    // Drain the body (Datto's own OAuth error detail) without relaying it -
    // this can propagate straight through to an MCP tool-call result, and an
    // auth-failure response body gets the same caution as any other one
    // would before being surfaced to a caller.
    await response.text();
    throw new Error(`Failed to acquire Datto RMM token: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

export interface Patch {
  patchId: string;
  category: string[];
  type: string;
  title: string;
  description: string;
  releaseDate: string;
  severity: string;
  maxSize: number;
  rebootRequired: boolean;
  requireUserInput: boolean;
  kbArticleId: string;
  installStatus: string;
  manualOverride: boolean;
}

export interface PatchesResponse {
  pageDetails: {
    count: number;
    totalCount: number;
    prevPageUrl: string | null;
    nextPageUrl: string | null;
  };
  patches: Patch[];
}

async function fetchPatches(creds: DattoCredentials, path: string): Promise<PatchesResponse> {
  const apiUrl = PLATFORM_URLS[creds.platform];
  const token = await getAccessToken(creds);

  const response = await fetch(`${apiUrl}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    // Token may have been invalidated server-side - retry once with a fresh
    // one. Only this credential set's entry, not the whole cache - other
    // customers' still-valid cached tokens shouldn't be forced to
    // re-authenticate because of one unrelated 401.
    tokenCache.delete(tokenCacheKey(creds));
    const retryToken = await getAccessToken(creds);
    const retryResponse = await fetch(`${apiUrl}/api${path}`, {
      headers: { Authorization: `Bearer ${retryToken}` },
    });
    if (!retryResponse.ok) {
      throw new Error(`Datto RMM API error: ${retryResponse.status} ${retryResponse.statusText}`);
    }
    return (await retryResponse.json()) as PatchesResponse;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Datto RMM API error: ${response.status} ${response.statusText} - ${body}`);
  }

  return (await response.json()) as PatchesResponse;
}

export function getDevicePatches(creds: DattoCredentials, deviceUid: string): Promise<PatchesResponse> {
  return fetchPatches(creds, `/v2/device/${encodeURIComponent(deviceUid)}/patches`);
}

export function getSitePatches(creds: DattoCredentials, siteUid: string): Promise<PatchesResponse> {
  return fetchPatches(creds, `/v2/sites/${encodeURIComponent(siteUid)}/patches`);
}
