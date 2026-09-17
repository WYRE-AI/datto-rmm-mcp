/**
 * Shared MCP server factory for Datto RMM.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts` — stdio + Node HTTP transport
 * - `worker.ts` — Cloudflare Workers (Web Standard) transport
 *
 * All tools are exposed upfront for universal MCP client compatibility. A fresh
 * server is created per request (for credential isolation in HTTP/Workers mode).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DattoRmmClient,
  type Device,
  type Platform,
  type QuickJobRequest,
} from "@wyre-ai/node-datto-rmm";
import { elicitSelection } from "./utils/elicitation.js";
import {
  ALERT_CARD_META,
  ALERT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
  applyBrandInjection,
  brandFromEnv,
  buildAlertCard,
} from "./alert-card.js";
import { ALERT_CARD_HTML } from "./generated/alert-card-html.js";
import { getDevicePatches, getSitePatches } from "./patches.js";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface DattoCredentials {
  apiKey: string;
  apiSecretKey: string;
  platform: Platform;
}

const VALID_PLATFORMS: Platform[] = [
  "pinotage",
  "merlot",
  "concord",
  "vidal",
  "zinfandel",
  "syrah",
];

/**
 * Resolve a platform string to a valid Platform, defaulting to "concord".
 */
export function resolvePlatform(platform: string | undefined): Platform {
  return platform && VALID_PLATFORMS.includes(platform as Platform)
    ? (platform as Platform)
    : "concord";
}

/**
 * Read credentials from environment variables (stdio / env HTTP mode).
 */
export function getCredentials(): DattoCredentials | null {
  const apiKey = process.env.DATTO_API_KEY || process.env.X_API_KEY;
  const apiSecretKey = process.env.DATTO_API_SECRET || process.env.X_API_SECRET;
  const platformEnv = process.env.DATTO_PLATFORM || "concord";

  if (!apiKey || !apiSecretKey) {
    return null;
  }

  return { apiKey, apiSecretKey, platform: resolvePlatform(platformEnv) };
}

/**
 * Resolve per-request gateway credentials from a header accessor.
 *
 * Works with any transport: pass a getter that returns a (lowercased) header
 * value. Returns `{ creds }` when the required headers are present, or
 * `{ error }` otherwise.
 *
 * Gateway header mapping:
 *   X-Datto-API-Key    -> apiKey
 *   X-Datto-API-Secret -> apiSecretKey
 *   X-Datto-Platform   -> platform (optional, defaults to concord)
 */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): { creds?: DattoCredentials; error?: string } {
  const apiKey = getHeader("x-datto-api-key");
  const apiSecret = getHeader("x-datto-api-secret");
  const platform = getHeader("x-datto-platform");

  if (!apiKey || !apiSecret) {
    return {
      error:
        "Gateway mode requires X-Datto-API-Key and X-Datto-API-Secret headers",
    };
  }

  return {
    creds: {
      apiKey,
      apiSecretKey: apiSecret,
      platform: resolvePlatform(platform),
    },
  };
}

function createClient(creds: DattoCredentials): DattoRmmClient {
  return new DattoRmmClient({
    apiKey: creds.apiKey,
    apiSecretKey: creds.apiSecretKey,
    platform: creds.platform,
  });
}

// ---------------------------------------------------------------------------
// Helper to collect items from async iterator
// ---------------------------------------------------------------------------

async function collectItems<T>(
  iterable: AsyncIterable<T>,
  max: number
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Hostname lookup helper
// ---------------------------------------------------------------------------

/**
 * Query params for device list endpoints. The Datto RMM API supports
 * server-side hostname filtering (substring match) on both
 * `GET /v2/account/devices` and `GET /v2/site/{siteUid}/devices`. The SDK's
 * typed params only cover pagination, but it forwards extra query params
 * verbatim, so we pass `hostname` through and refine the (already narrowed)
 * result client-side for exact matching.
 */
interface DeviceSearchQuery {
  hostname?: string;
  page?: number;
  max?: number;
}

/**
 * The SDK returns raw Datto RMM API payloads; these runtime field names are
 * not part of the SDK's typed `Device` interface yet.
 */
type RawDevice = Device & {
  online?: boolean;
  lastSeen?: number | string;
  intIpAddress?: string;
  portalUrl?: string;
};

/** Lightweight device summary returned by datto_find_device. */
export interface DeviceMatch {
  uid: string;
  hostname: string;
  siteUid?: string;
  siteName?: string;
  online?: boolean;
  intIpAddress?: string;
  operatingSystem?: string;
  lastSeen?: number | string;
  portalUrl?: string;
}

export async function findDevicesByHostname(
  client: DattoRmmClient,
  hostname: string,
  options: { siteUid?: string; exactMatch?: boolean; max?: number } = {}
): Promise<DeviceMatch[]> {
  const needle = hostname.trim().toLowerCase();
  const { siteUid, exactMatch = true, max = 25 } = options;

  // One server-filtered page (API page cap: 250) is plenty for a hostname
  // lookup; the API's hostname filter does the heavy lifting server-side.
  const query: DeviceSearchQuery = { hostname: needle, max: 250 };
  const response = siteUid
    ? await client.sites.devices(siteUid, query)
    : await client.account.devices(query);

  return (response.devices ?? [])
    .filter((device) => {
      const candidate = device.hostname?.trim().toLowerCase();
      if (!candidate) return false;
      return exactMatch ? candidate === needle : candidate.includes(needle);
    })
    .slice(0, Math.max(1, max))
    .map((device) => {
      const raw = device as RawDevice;
      return {
        uid: device.uid,
        hostname: device.hostname,
        siteUid: device.siteUid,
        siteName: device.siteName,
        online: raw.online ?? raw.isOnline,
        intIpAddress: raw.intIpAddress,
        operatingSystem: device.operatingSystem,
        lastSeen: raw.lastSeen ?? raw.lastSeenAt,
        portalUrl: raw.portalUrl,
      };
    });
}

// ---------------------------------------------------------------------------
// Quick job payload shape
// ---------------------------------------------------------------------------

/**
 * The correct `POST/PUT .../device/{uid}/quickjob` request body, verified
 * empirically against the live Datto RMM API (2026-09-14). The API rejects
 * the flat shape the published `@wyre-ai/node-datto-rmm@1.1.0` types declare
 * (`{ jobName, componentUid, variables }`) with HTTP 400
 * `{"errorMessage":"Failed to read request"}` — it never parses and no job
 * is created. It requires `componentUid` and `variables` nested under
 * `jobComponent`, with `variables` as an ARRAY of `{name, value}` pairs
 * rather than a key/value map:
 *
 *   { jobName, jobComponent: { componentUid, variables: [{name, value}] } }
 *
 * The SDK's `createQuickJob` forwards the request body verbatim, so this
 * nested shape works at runtime today even though the library's exported
 * `QuickJobRequest` type is still the wrong flat one. A fix to the library
 * itself is pending upstream but not yet published. Once
 * `@wyre-ai/node-datto-rmm` publishes the corrected type, remove this local
 * interface and the `as unknown as QuickJobRequest` cast at the call site
 * below — do NOT "simplify" the payload back to the flat shape, it will
 * start failing against the real API again.
 */
interface QuickJobRequestBody {
  jobName: string;
  jobComponent: {
    componentUid: string;
    variables: { name: string; value: string }[];
  };
}

// ---------------------------------------------------------------------------
// Server factory — creates a fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

/**
 * The returned server is NOT registered as "the" server anywhere here —
 * callers are responsible for binding it into the per-request `server-ref`
 * AsyncLocalStorage context (via `runWithServerRef` / `bindServerRef`) so
 * elicitation helpers (`utils/elicitation.ts`) resolve the right server
 * even after await gaps. See `utils/server-ref.ts` for why this matters.
 */
/**
 * Who is calling, when the server is fronted by a gateway that authenticates
 * end users itself.
 *
 * The Datto RMM API has no impersonation: every job records the API account
 * that created it, never the person who asked for it. On a shared service
 * account that makes the job history useless for answering "who ran this?" —
 * every entry names the integration. Carrying the caller's identity into the
 * job NAME is the only attribution the API allows.
 *
 * ADVISORY, not enforced. It affects labelling only, never authorization, and
 * a deployment without a gateway simply leaves it unset.
 */
export interface RequestContext {
  /** UPN/email of the end user, from the gateway. */
  callerUpn?: string;
}

/** Longest UPN carried into a job name. Real ones are far shorter; this only
 *  stops a malformed value from dominating the console's activity list. */
const MAX_CALLER_UPN_LENGTH = 64;

/**
 * Makes a gateway-supplied UPN safe to embed in a job name.
 *
 * Square brackets are removed, and that is the part that matters. The
 * attribution suffix is bracket-delimited, so a UPN containing `]` could
 * close it early and open a second one - `x] [admin@corp` would render as
 * `Job [x] [admin@corp]` and read as though the admin had run the job. It
 * would also defeat the idempotency check below. Real UPNs never contain
 * brackets, so removing them costs nothing.
 *
 * Control characters go too (they corrupt the console's rendering and this
 * log line), and the result is capped.
 *
 * @param raw - UPN as received from the gateway, if any.
 * @returns A UPN safe to embed, or undefined if nothing usable remains.
 */
function sanitizeCallerUpn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[ -[\]]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_CALLER_UPN_LENGTH);
}

/**
 * Appends ` [upn]` so a job in the Datto console names the human behind it.
 *
 * The suffix is always the gateway's own attribution and always last. A
 * caller-supplied name that already ends in some other bracketed text keeps
 * it and gains the attribution after it (`Job [ticket-12] [someone@corp]`) -
 * that text is part of the name the caller chose, not a competing claim about
 * who ran the job.
 *
 * @param jobName - Name as supplied by the caller.
 * @param callerUpn - Sanitized caller identity, if the gateway supplied one.
 * @returns The job name, attributed when a caller is known.
 */
function attributeJobName(jobName: string, callerUpn?: string): string {
  const upn = sanitizeCallerUpn(callerUpn);
  if (!upn) return jobName;
  // Idempotent: a retry, or a caller that already attributed the name, must
  // not accumulate duplicate suffixes.
  if (jobName.endsWith(`[${upn}]`)) return jobName;
  return `${jobName} [${upn}]`;
}

/**
 * Creates an MCP server instance for a single request.
 *
 * @param credentialOverrides - Datto credentials for this request. Supplied
 * per request in gateway mode; falls back to the process environment
 * otherwise.
 * @param requestContext - Caller identity from the gateway, used to attribute
 * created quick jobs. Labelling only - never authorization.
 * @returns A configured server, to be connected to a transport and closed
 * when the request completes.
 */
export function createMcpServer(
  credentialOverrides?: DattoCredentials,
  requestContext?: RequestContext
): Server {
  const server = new Server(
    {
      name: "datto-rmm-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "datto_list_devices",
          description:
            "List all devices in Datto RMM. Can filter by site. To look up a single device by hostname, use datto_find_device instead.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              siteUid: {
                type: "string",
                description:
                  "Filter devices by site UID (optional - if omitted, returns all devices)",
              },
              max: {
                type: "number",
                description: "Maximum number of results (default: 50)",
                default: 50,
              },
            },
          },
        },
        {
          name: "datto_find_device",
          description:
            "Find a device by hostname and return its UID plus a lightweight summary. Use this before datto_get_device when the user provides a hostname instead of a UID.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              hostname: {
                type: "string",
                description: "Hostname to search for, for example APP-HV-HOST06",
              },
              siteUid: {
                type: "string",
                description:
                  "Optional site UID to narrow the hostname lookup to one site",
              },
              exactMatch: {
                type: "boolean",
                description:
                  "Require an exact (case-insensitive) hostname match. Set to false for partial/substring matching. Defaults to true.",
                default: true,
              },
              max: {
                type: "number",
                description:
                  "Maximum number of matching devices to return (default: 25)",
                default: 25,
              },
            },
            required: ["hostname"],
          },
        },
        {
          name: "datto_get_device",
          description:
            "Get full details for a specific device by its UID. If you only have a hostname, call datto_find_device first to resolve the UID.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              deviceUid: {
                type: "string",
                description: "The device UID",
              },
            },
            required: ["deviceUid"],
          },
        },
        {
          name: "datto_list_alerts",
          description: "List open alerts. Can filter by site.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              siteUid: {
                type: "string",
                description:
                  "Filter alerts by site UID (optional - if omitted, returns all account alerts)",
              },
              max: {
                type: "number",
                description: "Maximum number of results (default: 50)",
                default: 50,
              },
            },
          },
        },
        {
          name: "datto_get_alert",
          description: "Get details for a specific alert by its UID",
          annotations: { readOnlyHint: true },
          _meta: ALERT_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              alertUid: {
                type: "string",
                description: "The alert UID",
              },
            },
            required: ["alertUid"],
          },
        },
        {
          name: "datto_resolve_alert",
          description: "Resolve an alert by its UID",
          _meta: ALERT_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              alertUid: {
                type: "string",
                description: "The alert UID to resolve",
              },
            },
            required: ["alertUid"],
          },
        },
        {
          name: "datto_list_sites",
          description: "List all sites in the account",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              max: {
                type: "number",
                description: "Maximum number of results (default: 50)",
                default: 50,
              },
            },
          },
        },
        {
          name: "datto_get_site",
          description: "Get details for a specific site by its UID",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              siteUid: {
                type: "string",
                description: "The site UID",
              },
            },
            required: ["siteUid"],
          },
        },
        {
          name: "datto_run_quickjob",
          description:
            "Run a quick job on a device. Returns a job UID — pass it to datto_get_job, datto_get_job_components, datto_get_job_results, datto_get_job_stdout, and datto_get_job_stderr to check the job's status and retrieve its output, since this call itself is fire-and-forget.",
          inputSchema: {
            type: "object",
            properties: {
              deviceUid: {
                type: "string",
                description: "The device UID to run the job on",
              },
              jobName: {
                type: "string",
                description: "Name for the quick job",
              },
              componentUid: {
                type: "string",
                description: "UID of the component to run",
              },
              variables: {
                type: "object",
                description: "Variables to pass to the job (key-value pairs)",
                additionalProperties: { type: "string" },
              },
            },
            required: ["deviceUid", "jobName", "componentUid"],
          },
        },
        {
          name: "datto_get_job",
          description:
            "Get status and details for a quick job by its UID (e.g. queued/running/completed, device count, timestamps). Use this after datto_run_quickjob to check whether the job finished and how it went.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              jobUid: {
                type: "string",
                description: "The job UID, returned by datto_run_quickjob",
              },
            },
            required: ["jobUid"],
          },
        },
        {
          name: "datto_get_job_components",
          description:
            "Get the components (scripts/actions and their variables) that make up a quick job",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              jobUid: {
                type: "string",
                description: "The job UID",
              },
            },
            required: ["jobUid"],
          },
        },
        {
          name: "datto_get_job_results",
          description:
            "Get the result of a quick job on one specific device — status, exit code, timing, and error message if it failed. Use datto_get_job first if you need to find which devices the job ran on.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              jobUid: {
                type: "string",
                description: "The job UID",
              },
              deviceUid: {
                type: "string",
                description: "The device UID to get the job result for",
              },
            },
            required: ["jobUid", "deviceUid"],
          },
        },
        {
          name: "datto_get_job_stdout",
          description:
            "Get the captured stdout output of a quick job on a specific device. Use this to diagnose what a script actually printed when a quick job's outcome is unclear.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              jobUid: {
                type: "string",
                description: "The job UID",
              },
              deviceUid: {
                type: "string",
                description: "The device UID",
              },
            },
            required: ["jobUid", "deviceUid"],
          },
        },
        {
          name: "datto_get_job_stderr",
          description:
            "Get the captured stderr output of a quick job on a specific device. Use this to diagnose why a quick job failed.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              jobUid: {
                type: "string",
                description: "The job UID",
              },
              deviceUid: {
                type: "string",
                description: "The device UID",
              },
            },
            required: ["jobUid", "deviceUid"],
          },
        },
        {
          name: "datto_get_device_audit",
          description:
            "Get audit data for a device (hardware, software, OS information)",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              deviceUid: {
                type: "string",
                description: "The device UID",
              },
              auditType: {
                type: "string",
                enum: ["full", "software"],
                description:
                  "Type of audit: 'full' for complete audit or 'software' for software inventory only",
                default: "full",
              },
            },
            required: ["deviceUid"],
          },
        },
        {
          name: "datto_get_device_patches",
          description:
            "Get Windows patch installation status for a device - per-patch installed/missing/pending status, severity, reboot requirement, and KB article",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              deviceUid: {
                type: "string",
                description: "The device UID",
              },
            },
            required: ["deviceUid"],
          },
        },
        {
          name: "datto_get_site_patches",
          description:
            "Get Windows patch installation status across all devices in a site",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: {
              siteUid: {
                type: "string",
                description: "The site UID",
              },
            },
            required: ["siteUid"],
          },
        },
      ],
    };
  });

  // MCP Apps (SEP-1865): the ui:// alert card is static HTML embedded at
  // build time (src/generated/alert-card-html.ts), so it serves identically
  // from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: ALERT_CARD_RESOURCE_URI,
          name: "Datto RMM Alert Card",
          description: "Interactive MCP Apps card rendering a Datto RMM alert",
          mimeType: MCP_APP_RESOURCE_MIME,
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== ALERT_CARD_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_RESOURCE_MIME,
          // The card ships neutral; operators brand it at serve time via
          // MCP_BRAND_* env vars (no vars = HTML served unchanged).
          text: applyBrandInjection(ALERT_CARD_HTML, brandFromEnv()),
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No API credentials provided. Please configure your Datto RMM API key and secret via DATTO_API_KEY and DATTO_API_SECRET environment variables.",
          },
        ],
        isError: true,
      };
    }

    const client = createClient(creds);

    try {
      switch (name) {
        case "datto_list_devices": {
          const params = args as { siteUid?: string; max?: number };
          const max = params.max || 50;
          let siteUid = params.siteUid;

          // If no site filter, ask the user if they want to narrow by site
          if (!siteUid) {
            const siteFilter = await elicitSelection(
              "Listing all devices across all sites can return a large result set. Would you like to filter by a specific site?",
              "site",
              [
                { value: "__all__", label: "All sites (no filter)" },
                { value: "__enter__", label: "Enter a site UID manually" },
              ]
            );
            if (siteFilter === "__enter__") {
              const { elicitText } = await import("./utils/elicitation.js");
              const enteredUid = await elicitText(
                "Enter the site UID to filter devices by.",
                "siteUid",
                "The site UID from Datto RMM"
              );
              if (enteredUid) {
                siteUid = enteredUid;
              }
            }
          }

          let devices;
          if (siteUid) {
            devices = await collectItems(client.sites.devicesAll(siteUid), max);
          } else {
            devices = await collectItems(client.account.devicesAll(), max);
          }

          return {
            content: [
              { type: "text", text: JSON.stringify(devices ?? [], null, 2) },
            ],
          };
        }

        case "datto_find_device": {
          const {
            hostname,
            siteUid,
            exactMatch = true,
            max = 25,
          } = args as {
            hostname: string;
            siteUid?: string;
            exactMatch?: boolean;
            max?: number;
          };

          if (!hostname?.trim()) {
            return {
              content: [
                { type: "text", text: "Error: hostname must not be empty" },
              ],
              isError: true,
            };
          }

          const devices = await findDevicesByHostname(client, hostname, {
            siteUid,
            exactMatch,
            max,
          });

          // Explicit not-found error instead of an empty success — empty
          // successes invite downstream LLM hallucination.
          if (devices.length === 0) {
            const scope = siteUid ? ` in site ${siteUid}` : "";
            const hint = exactMatch
              ? " Retry with exactMatch: false for partial matching, or verify the hostname with datto_list_devices."
              : " Verify the hostname with datto_list_devices.";
            return {
              content: [
                {
                  type: "text",
                  text: `No devices found matching hostname "${hostname}"${scope}.${hint}`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { count: devices.length, devices },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "datto_get_device": {
          const { deviceUid } = args as { deviceUid: string };
          const device = await client.devices.get(deviceUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(device ?? {}, null, 2) },
            ],
          };
        }

        case "datto_list_alerts": {
          const params = args as { siteUid?: string; max?: number };
          const max = params.max || 50;
          let siteUid = params.siteUid;

          // If no site filter, ask the user if they want to narrow by site
          if (!siteUid) {
            const siteFilter = await elicitSelection(
              "Listing all open alerts can return many results. Would you like to filter by a specific site?",
              "site",
              [
                { value: "__all__", label: "All sites (no filter)" },
                { value: "__enter__", label: "Enter a site UID manually" },
              ]
            );
            if (siteFilter === "__enter__") {
              const { elicitText } = await import("./utils/elicitation.js");
              const enteredUid = await elicitText(
                "Enter the site UID to filter alerts by.",
                "siteUid",
                "The site UID from Datto RMM"
              );
              if (enteredUid) {
                siteUid = enteredUid;
              }
            }
          }

          let alerts;
          if (siteUid) {
            alerts = await collectItems(client.sites.alertsOpenAll(siteUid), max);
          } else {
            alerts = await collectItems(client.account.alertsOpenAll(), max);
          }

          return {
            content: [
              { type: "text", text: JSON.stringify(alerts ?? [], null, 2) },
            ],
          };
        }

        case "datto_get_alert": {
          const { alertUid } = args as { alertUid: string };
          const alert = await client.alerts.get(alertUid);
          // MCP Apps: attach the normalized payload the ui:// alert card
          // renders from. Best-effort — a null card just means no UI surface.
          const card = buildAlertCard(alert);
          const payload = card ? { ...alert, _card: card } : alert;
          return {
            content: [
              { type: "text", text: JSON.stringify(payload ?? {}, null, 2) },
            ],
          };
        }

        case "datto_resolve_alert": {
          const { alertUid } = args as { alertUid: string };
          const result = await client.alerts.resolve(alertUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(result ?? {}, null, 2) },
            ],
          };
        }

        case "datto_list_sites": {
          const params = args as { max?: number };
          const max = params.max || 50;
          const sites = await collectItems(client.account.sitesAll(), max);
          return {
            content: [
              { type: "text", text: JSON.stringify(sites ?? [], null, 2) },
            ],
          };
        }

        case "datto_get_site": {
          const { siteUid } = args as { siteUid: string };
          const site = await client.sites.get(siteUid);
          return {
            content: [{ type: "text", text: JSON.stringify(site, null, 2) }],
          };
        }

        case "datto_run_quickjob": {
          const { deviceUid, jobName, componentUid, variables } = args as {
            deviceUid: string;
            jobName: string;
            componentUid: string;
            variables?: Record<string, string>;
          };

          // Public inputSchema keeps `variables` as a friendly key/value map
          // (a nicer calling convention for an LLM) — convert to the array
          // of {name, value} pairs the live API actually requires. See the
          // QuickJobRequestBody comment above for why this nesting exists.
          const jobRequest: QuickJobRequestBody = {
            // Datto records the API account as the job's creator and offers no
            // way to override it, so the caller's identity goes in the name -
            // the one field that reaches the console's activity list. No-op
            // when no gateway supplied one.
            jobName: attributeJobName(jobName, requestContext?.callerUpn),
            jobComponent: {
              componentUid,
              variables: Object.entries(variables ?? {}).map(
                ([name, value]) => ({ name, value })
              ),
            },
          };

          const result = await client.devices.createQuickJob(
            deviceUid,
            // The published library type for this parameter is the wrong
            // flat shape — see the QuickJobRequestBody comment above.
            jobRequest as unknown as QuickJobRequest
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(result ?? {}, null, 2) },
            ],
          };
        }

        case "datto_get_job": {
          const { jobUid } = args as { jobUid: string };
          const job = await client.jobs.get(jobUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(job ?? {}, null, 2) },
            ],
          };
        }

        case "datto_get_job_components": {
          const { jobUid } = args as { jobUid: string };
          const components = await client.jobs.components(jobUid);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(components ?? [], null, 2),
              },
            ],
          };
        }

        case "datto_get_job_results": {
          const { jobUid, deviceUid } = args as {
            jobUid: string;
            deviceUid: string;
          };
          const result = await client.jobs.results(jobUid, deviceUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(result ?? {}, null, 2) },
            ],
          };
        }

        case "datto_get_job_stdout": {
          const { jobUid, deviceUid } = args as {
            jobUid: string;
            deviceUid: string;
          };
          const stdout = await client.jobs.stdout(jobUid, deviceUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(stdout ?? "", null, 2) },
            ],
          };
        }

        case "datto_get_job_stderr": {
          const { jobUid, deviceUid } = args as {
            jobUid: string;
            deviceUid: string;
          };
          const stderr = await client.jobs.stderr(jobUid, deviceUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(stderr ?? "", null, 2) },
            ],
          };
        }

        case "datto_get_device_audit": {
          const { deviceUid, auditType = "full" } = args as {
            deviceUid: string;
            auditType?: "full" | "software";
          };

          let audit;
          if (auditType === "software") {
            audit = await client.audit.deviceSoftware(deviceUid);
          } else {
            audit = await client.audit.device(deviceUid);
          }

          return {
            content: [
              { type: "text", text: JSON.stringify(audit ?? {}, null, 2) },
            ],
          };
        }

        // Not wrapped by the SDK yet (see src/patches.ts's header comment) -
        // these two call Datto RMM's v2 patch endpoints directly rather than
        // through `client`.
        case "datto_get_device_patches": {
          const { deviceUid } = args as { deviceUid: string };
          const result = await getDevicePatches(creds, deviceUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(result ?? {}, null, 2) },
            ],
          };
        }

        case "datto_get_site_patches": {
          const { siteUid } = args as { siteUid: string };
          const result = await getSitePatches(creds, siteUid);
          return {
            content: [
              { type: "text", text: JSON.stringify(result ?? {}, null, 2) },
            ],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
