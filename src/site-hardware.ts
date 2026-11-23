/**
 * Hardware summary (manufacturer, model, serial number) for the devices in one site.
 *
 * Datto RMM's device list and device details do not carry the manufacturer or model; only
 * each device's audit (GET /v2/audit/device/{uid}) does. So a question like "which devices
 * at this site are HP" or "which have no manufacturer" needs one audit call per device.
 * This does those calls for one site, sequentially and paced, so it stays well inside
 * Datto's API rate limit (600 reads a minute per account, shared by everything using the
 * account) and inside a caller's time limit:
 *
 * - one audit at a time, `gapMs` apart (default 300 ms, about 200 a minute);
 * - it stops after `budgetMs` and returns what it has with `nextOffset`, so the caller can
 *   continue from there. The default (20 s) suits MCP clients and gateways that time out a
 *   tool call well under a minute; set DATTO_SITE_HARDWARE_BUDGET_MS to change it;
 * - at most `pageSize` devices are read per call (default 100, DATTO_SITE_HARDWARE_PAGE_SIZE);
 * - a rate-limit error stops it at once (never retried: Datto blocks the source IP when
 *   requests continue after a 429) and is reported with how long to wait;
 * - any other error on one device is reported on that device and the rest carry on.
 *
 * Devices are sorted by hostname, so `offset` / `nextOffset` page through a stable order.
 */

import { rateLimitDetails, isRateLimitError } from "./rate-limit.js";

/** Devices read per call when the caller does not pass `max` (never more than the page size). */
export const DEFAULT_MAX_DEVICES = 50;
export const DEFAULT_GAP_MS = 300;
/** Upper bound on the site's device list we read and sort. */
export const SITE_DEVICE_LIST_LIMIT = 5000;

/** Time budget per call. Override with DATTO_SITE_HARDWARE_BUDGET_MS. */
export const DEFAULT_BUDGET_MS = 20_000;
export const MIN_BUDGET_MS = 1_000;
export const MAX_BUDGET_MS = 300_000;

/** Most devices read per call. Override with DATTO_SITE_HARDWARE_PAGE_SIZE. */
export const DEFAULT_PAGE_SIZE = 100;
/** Datto RMM's API returns at most 250 items per page, so the page size is clamped to it. */
export const MAX_PAGE_SIZE = 250;

export interface SiteHardwareConfig {
  budgetMs: number;
  pageSize: number;
  /** One line per environment value that was ignored or clamped. */
  warnings: string[];
}

function envInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  lo: number,
  hi: number,
  warnings: string[]
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    warnings.push(`${name}="${raw.slice(0, 40)}" is not a whole number; using the default ${fallback}.`);
    return fallback;
  }
  const n = Number(raw);
  if (n < lo || n > hi) {
    const clamped = Math.min(hi, Math.max(lo, n));
    warnings.push(`${name}=${raw} is outside ${lo}-${hi}; using ${clamped}.`);
    return clamped;
  }
  return n;
}

function processEnv(): Record<string, string | undefined> {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * Reads DATTO_SITE_HARDWARE_BUDGET_MS (milliseconds, MIN_BUDGET_MS-MAX_BUDGET_MS, default
 * DEFAULT_BUDGET_MS) and DATTO_SITE_HARDWARE_PAGE_SIZE (devices, 1-MAX_PAGE_SIZE, default
 * DEFAULT_PAGE_SIZE). A value that is not a whole number is ignored; one out of range is
 * clamped. Either way a warning says so.
 */
export function siteHardwareConfig(env: Record<string, string | undefined> = processEnv()): SiteHardwareConfig {
  const warnings: string[] = [];
  const budgetMs = envInt(env, "DATTO_SITE_HARDWARE_BUDGET_MS", DEFAULT_BUDGET_MS, MIN_BUDGET_MS, MAX_BUDGET_MS, warnings);
  const pageSize = envInt(env, "DATTO_SITE_HARDWARE_PAGE_SIZE", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, warnings);
  return { budgetMs, pageSize, warnings };
}

export interface HardwareRow {
  deviceUid: string;
  hostname: string;
  deviceType?: string;
  online?: boolean;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  error?: string;
}

export interface SiteHardwareResult {
  siteUid: string;
  totalDevices: number;
  offset: number;
  returned: number;
  devices: HardwareRow[];
  nextOffset?: number;
  /** The site has more devices than SITE_DEVICE_LIST_LIMIT; only that many are covered. */
  listTruncated?: boolean;
  /** Set when Datto rate-limited the audits: the caller must wait before continuing. */
  rateLimited?: { message: string; retryAfterSeconds?: number };
  notes?: string[];
}

export interface SiteHardwareDeps {
  /** Every device in the site (list entries as Datto returns them). */
  listDevices: () => Promise<unknown[]>;
  /** One device's full audit. */
  audit: (deviceUid: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SiteHardwareOptions {
  offset?: number;
  max?: number;
  gapMs?: number;
  budgetMs?: number;
  /** Most devices read per call; `max` is clamped to it (default DEFAULT_PAGE_SIZE). */
  pageSize?: number;
  /** How many listed devices to cover at most (default SITE_DEVICE_LIST_LIMIT). */
  listLimit?: number;
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Clamps a caller-supplied number to a whole number within [lo, hi], or the fallback. */
export function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

export async function siteHardware(
  siteUid: string,
  deps: SiteHardwareDeps,
  opts: SiteHardwareOptions = {}
): Promise<SiteHardwareResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(opts.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const max = clampInt(opts.max, Math.min(DEFAULT_MAX_DEVICES, pageSize), 1, pageSize);
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = now();

  const listLimit = opts.listLimit ?? SITE_DEVICE_LIST_LIMIT;
  const listedRaw = await deps.listDevices();
  const listTruncated = listedRaw.length > listLimit;
  const listed = listTruncated ? listedRaw.slice(0, listLimit) : listedRaw;
  const all = listed
    .map((d) => ({
      uid: str(field(d, "uid")),
      hostname: str(field(d, "hostname")) ?? "",
      deviceType: str(field(field(d, "deviceType"), "category")) ?? undefined,
      online: typeof field(d, "online") === "boolean" ? (field(d, "online") as boolean) : undefined,
    }))
    .filter((d): d is { uid: string; hostname: string; deviceType: string | undefined; online: boolean | undefined } => d.uid !== null)
    .sort((a, b) => a.hostname.toLowerCase().localeCompare(b.hostname.toLowerCase()));

  const slice = all.slice(offset, offset + max);
  const rows: HardwareRow[] = [];
  const notes: string[] = [];
  let stoppedAt: number | undefined;
  let rateLimited: SiteHardwareResult["rateLimited"];

  for (let i = 0; i < slice.length; i++) {
    const d = slice[i];
    if (i > 0) {
      if (now() - started + gapMs >= budgetMs) {
        stoppedAt = offset + i;
        notes.push(`Stopped at the time limit after ${rows.length} devices; continue with offset ${stoppedAt}.`);
        break;
      }
      await sleep(gapMs);
    }
    const base = { deviceUid: d.uid, hostname: d.hostname, deviceType: d.deviceType, online: d.online };
    try {
      const audit = await deps.audit(d.uid);
      const sys = field(audit, "systemInfo");
      rows.push({
        ...base,
        manufacturer: str(field(sys, "manufacturer")),
        model: str(field(sys, "model")),
        serialNumber: str(field(field(audit, "bios"), "serialNumber")),
      });
    } catch (error) {
      if (isRateLimitError(error)) {
        // Never retried: continuing after a 429 gets the source IP blocked.
        const { message, retryAfterSeconds } = rateLimitDetails(error);
        rateLimited = { message, retryAfterSeconds };
        stoppedAt = offset + i;
        notes.push(
          `Stopped: Datto RMM rate-limited the requests (HTTP 429). Try again in ${retryAfterSeconds ?? 60} s, ` +
            `continuing with offset ${stoppedAt}.`
        );
        break;
      }
      rows.push({
        ...base,
        manufacturer: null,
        model: null,
        serialNumber: null,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      });
    }
  }

  let nextOffset = stoppedAt;
  if (nextOffset === undefined && offset + slice.length < all.length) {
    nextOffset = offset + slice.length;
  }
  if (nextOffset !== undefined && stoppedAt === undefined) {
    notes.push(`${all.length - nextOffset} more devices; continue with offset ${nextOffset}.`);
  }
  if (listTruncated) {
    notes.push(
      `This site has more than ${listLimit} devices; only the first ${listLimit} (in Datto's order) are covered, so the results are incomplete.`
    );
  }
  const missing = rows.filter((r) => !r.error && r.manufacturer === null).length;
  if (missing > 0) {
    notes.push(`${missing} device(s) report no manufacturer in their audit (often an audit that has not run yet).`);
  }

  return {
    siteUid,
    totalDevices: all.length,
    offset,
    returned: rows.length,
    devices: rows,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(listTruncated ? { listTruncated } : {}),
    ...(rateLimited ? { rateLimited } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
