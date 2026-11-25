/**
 * Windows patch installation/compliance data for a device or site.
 *
 * Datto RMM 15.1.0 (rolled out July-Aug 2026) added two new v2 endpoints -
 * GET /v2/device/{deviceUid}/patches and GET /v2/site/{siteUid}/patches -
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

import type { Platform } from "@wyre-ai/node-datto-rmm";
import type { DattoCredentials } from "./mcp-server.js";
import {
  DattoIpBlockedError,
  DattoRateLimitedError,
  IP_BLOCK_WAIT_SECONDS,
  RATE_LIMIT_WAIT_SECONDS,
  ipBlockSuspected,
  looksLikeIpBlock,
  noteRateLimited,
  retryAfterSeconds,
} from "./rate-limit.js";

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

/**
 * A 429 or an IP-block 403 is reported, never retried (Datto blocks the IP
 * when calls continue after a 429). A 403 is the IP block when its body says
 * so or when it arrives during the cooldown after a 429; any other 403 is
 * left to the caller's ordinary error path.
 */
async function throwIfRateLimited(response: Response, path: string): Promise<void> {
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response.headers.get("retry-after")) ?? RATE_LIMIT_WAIT_SECONDS;
    noteRateLimited();
    throw new DattoRateLimitedError(path, seconds);
  }
  if (response.status === 403) {
    // Read a copy: the caller may still need the body for its own error.
    const confirmed = looksLikeIpBlock(await response.clone().text());
    if (confirmed) {
      noteRateLimited();
      throw new DattoIpBlockedError(path);
    }
    // A bare 403 during the cooldown is presumed to be the block. It reports
    // the usual wait but does not restart the cooldown (only a 429 or a
    // confirmed block does), so a permissions error cannot keep itself
    // looking like a rate limit.
    if (ipBlockSuspected()) throw new DattoIpBlockedError(path, IP_BLOCK_WAIT_SECONDS, true);
  }
}

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

  await throwIfRateLimited(response, "/auth/oauth/token");
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

/**
 * Authenticated GET against a Datto RMM v2 endpoint the SDK doesn't wrap (or
 * wraps incorrectly), sharing this module's per-credential token cache.
 *
 * `pathOrUrl` is either an API path (`/v2/...`) or a full URL the API itself
 * handed back for paging (`pageDetails.nextPageUrl`). A full URL must point
 * at this credential set's own platform API - the bearer token is never sent
 * to any other host, whatever a response body says.
 */
export async function dattoApiGet<T>(creds: DattoCredentials, pathOrUrl: string): Promise<T> {
  const apiUrl = PLATFORM_URLS[creds.platform];
  let url: string;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    if (!pathOrUrl.startsWith(`${apiUrl}/api/`)) {
      throw new Error("Refusing to follow a Datto RMM paging URL outside the configured platform API");
    }
    url = pathOrUrl;
  } else {
    url = `${apiUrl}/api${pathOrUrl}`;
  }

  const token = await getAccessToken(creds);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await throwIfRateLimited(response, new URL(url).pathname);
  if (response.status === 401) {
    // Token may have been invalidated server-side - retry once with a fresh
    // one. Only this credential set's entry, not the whole cache - other
    // customers' still-valid cached tokens shouldn't be forced to
    // re-authenticate because of one unrelated 401.
    tokenCache.delete(tokenCacheKey(creds));
    const retryToken = await getAccessToken(creds);
    const retryResponse = await fetch(url, {
      headers: { Authorization: `Bearer ${retryToken}` },
    });
    await throwIfRateLimited(retryResponse, new URL(url).pathname);
    if (!retryResponse.ok) {
      throw new Error(`Datto RMM API error: ${retryResponse.status} ${retryResponse.statusText}`);
    }
    return (await retryResponse.json()) as T;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Datto RMM API error: ${response.status} ${response.statusText} - ${body}`);
  }

  return (await response.json()) as T;
}

function fetchPatches(creds: DattoCredentials, path: string): Promise<PatchesResponse> {
  return dattoApiGet<PatchesResponse>(creds, path);
}

export function getDevicePatches(creds: DattoCredentials, deviceUid: string): Promise<PatchesResponse> {
  return fetchPatches(creds, `/v2/device/${encodeURIComponent(deviceUid)}/patches`);
}

// Datto RMM's site routes are singular (/v2/site/{uid}/...). The plural
// /v2/sites/{uid}/patches this used to call does not exist and 404'd.
export function getSitePatches(creds: DattoCredentials, siteUid: string): Promise<PatchesResponse> {
  return fetchPatches(creds, `/v2/site/${encodeURIComponent(siteUid)}/patches`);
}
