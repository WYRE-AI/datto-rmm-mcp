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
 * - one audit at a time, `gapMs` apart (default 300 ms, about 200 a minute). The pacing is
 *   shared by every call in this process, so concurrent calls together stay at that rate;
 * - it stops after `budgetMs` and returns what it has with `nextOffset`, so the caller can
 *   continue from there. The budget also bounds a request that is still pending: a slow
 *   audit is abandoned at the deadline and that device is the one to continue from. The default (20 s) suits MCP clients and gateways that time out a
 *   tool call well under a minute; set DATTO_SITE_HARDWARE_BUDGET_MS to change it;
 * - at most `pageSize` devices are read per call (default 100, DATTO_SITE_HARDWARE_PAGE_SIZE);
 * - a rate-limit error stops it at once (never retried: Datto blocks the source IP when
 *   requests continue after a 429) and is reported with how long to wait;
 * - any other error on one device is reported on that device and the rest carry on.
 *
 * Devices are sorted by hostname, then device UID, so `offset` / `nextOffset` page through a
 * stable order even when hostnames repeat.
 */

import { rateLimitDetails, isRateLimitError, onRateLimited } from "./rate-limit.js";

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

/**
 * Spaces audits `gapMs` apart across every caller that shares it. Datto's limit is per
 * account and its IP block is per source IP, so one pacer serves the whole process.
 */
export class AuditPacer {
  private nextSlot = 0;
  private backoffUntil = 0;
  private readonly listeners = new Set<() => void>();

  /** Milliseconds a caller asking at `at` would wait for its slot (without taking it). */
  waitFor(at: number): number {
    return Math.max(0, this.nextSlot - at);
  }

  /** Takes the slot at `at + waitFor(at)` and returns the wait. */
  reserve(at: number, gapMs: number): number {
    const wait = this.waitFor(at);
    this.nextSlot = at + wait + gapMs;
    return wait;
  }

  /** Records a rate limit seen by any caller: no request may be sent before `until`. */
  backOff(until: number): void {
    if (until <= this.backoffUntil) return;
    this.backoffUntil = until;
    for (const listener of [...this.listeners]) listener();
  }

  /** Calls `listener` whenever a backoff is recorded; returns the unsubscribe function. */
  onBackOff(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whole seconds left in a recorded backoff (at least 1), or 0 when none is running. */
  backoffSeconds(at: number): number {
    return at < this.backoffUntil ? Math.max(1, Math.ceil((this.backoffUntil - at) / 1000)) : 0;
  }

  reset(): void {
    this.nextSlot = 0;
    this.backoffUntil = 0;
    this.listeners.clear();
  }
}

/** The process-wide pacer used when a call does not pass its own. */
export const sharedAuditPacer = new AuditPacer();

// A rate limit reported by any tool (patches, jobs, the SDK...) backs off the hardware
// scans too: Datto's limit is per account and its IP block per source IP.
onRateLimited((seconds) => sharedAuditPacer.backOff(Date.now() + seconds * 1000));

const TIMED_OUT = Symbol("timed out");

/**
 * Resolves to the promise's value, or TIMED_OUT if `ms` passes first. On a timeout
 * `onTimeout` runs (to cancel the work) and the promise is left to settle.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) {
    onTimeout?.();
    promise.catch(() => {});
    return TIMED_OUT;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const winner = await Promise.race([promise, deadline]);
    if (winner === TIMED_OUT) {
      onTimeout?.();
      promise.catch(() => {});
    }
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

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
  /**
   * Every device in the site (list entries as Datto returns them). Call `pace` before each
   * page request: it waits for a slot on the shared pacer, so listing pages and audits from
   * every call together stay one request per gap. Stop when `signal` is aborted.
   */
  listDevices: (signal: AbortSignal, pace: () => Promise<void>) => Promise<unknown[]>;
  /** One device's full audit. */
  audit: (deviceUid: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Shared audit pacing (default: sharedAuditPacer, one per process). */
  pacer?: AuditPacer;
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
  const pacer = deps.pacer ?? sharedAuditPacer;
  const started = now();
  const remaining = () => budgetMs - (now() - started);

  /**
   * Records a rate limit from a listing or audit request on the shared pacer, even when
   * it arrives after this call has stopped waiting for that request, so no call sends
   * more requests during Datto's cooldown. The promise itself is returned unchanged.
   */
  const observeRateLimit = <T>(request: Promise<T>): Promise<T> => {
    request.catch((error: unknown) => {
      if (!isRateLimitError(error)) return;
      const { retryAfterSeconds } = rateLimitDetails(error);
      pacer.backOff(now() + (retryAfterSeconds ?? 60) * 1000);
    });
    return request;
  };

  /**
   * Result for a call that audited nothing because of a rate limit: a backoff was running
   * before or after the listing, or the listing was cut short by one (`interrupted`), in
   * which case the devices it returned are incomplete and must not be used.
   */
  const backedOffBeforeListing = (seconds: number, interrupted = false): SiteHardwareResult => ({
    siteUid,
    totalDevices: 0,
    offset,
    returned: 0,
    devices: [],
    nextOffset: offset,
    rateLimited: {
      message:
        (interrupted
          ? "A Datto RMM rate limit (HTTP 429) interrupted the device listing, so the list is incomplete and nothing was audited. "
          : "Datto RMM rate-limited another request (HTTP 429), so the site's devices were not listed. ") +
        `Try again in ${seconds} s.`,
      retryAfterSeconds: seconds,
    },
    notes: [`Stopped before listing the devices: Datto RMM rate-limited the requests (HTTP 429). Try again in ${seconds} s, continuing with offset ${offset}.`],
  });

  const listLimit = opts.listLimit ?? SITE_DEVICE_LIST_LIMIT;
  const backoffBefore = pacer.backoffSeconds(now());
  if (backoffBefore > 0) return backedOffBeforeListing(backoffBefore);
  // Aborted at the deadline, or when any call records a rate limit, so a multi-page
  // listing stops requesting pages.
  const listing = new AbortController();
  // Why the listing was stopped: the time budget ran out, or a rate limit was recorded.
  let listingStop: "deadline" | "backoff" | undefined;
  const stopListing = (reason: "deadline" | "backoff") => {
    listingStop ??= reason;
    listing.abort();
  };
  const stopListening = pacer.onBackOff(() => stopListing("backoff"));
  let listedOrTimeout: unknown[] | typeof TIMED_OUT;
  try {
    const paceListingPage = async (): Promise<void> => {
      // Like the audit loop: never take a slot that cannot be used within the budget
      // (an unused slot would hold up every other call), and recheck after the wait,
      // which can overrun.
      const at = now();
      if (at - started + pacer.waitFor(at) >= budgetMs) return stopListing("deadline");
      const wait = pacer.reserve(at, gapMs);
      if (wait > 0) await sleep(wait);
      if (remaining() <= 0) stopListing("deadline");
    };
    listedOrTimeout = await withDeadline(observeRateLimit(deps.listDevices(listing.signal, paceListingPage)), remaining(), () =>
      stopListing("deadline")
    );
  } finally {
    stopListening();
  }
  if (listedOrTimeout === TIMED_OUT || listingStop === "deadline") {
    throw new Error(
      `Listing the devices in site ${siteUid} took longer than the ${Math.ceil(budgetMs / 1000)} s time budget, so no audits were read. Try again.`
    );
  }
  // A listing aborted by a rate limit returns only the devices read before the abort.
  // Never treat that as the whole site, even when the backoff has already ended.
  if (listing.signal.aborted) return backedOffBeforeListing(Math.max(1, pacer.backoffSeconds(now())), true);
  const backoffAfterListing = pacer.backoffSeconds(now());
  if (backoffAfterListing > 0) return backedOffBeforeListing(backoffAfterListing);
  const listedRaw = listedOrTimeout;
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
    .sort(
      (a, b) =>
        a.hostname.toLowerCase().localeCompare(b.hostname.toLowerCase()) ||
        (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
    );

  const slice = all.slice(offset, offset + max);
  const rows: HardwareRow[] = [];
  const notes: string[] = [];
  let stoppedAt: number | undefined;
  let rateLimited: SiteHardwareResult["rateLimited"];

  for (let i = 0; i < slice.length; i++) {
    const d = slice[i];
    // Checked and taken with no await in between, so concurrent calls cannot share a slot.
    const at = now();
    if (at - started + pacer.waitFor(at) >= budgetMs) {
      stoppedAt = offset + i;
      notes.push(`Stopped at the time limit after ${rows.length} devices; continue with offset ${stoppedAt}.`);
      break;
    }
    const wait = pacer.reserve(at, gapMs);
    if (wait > 0) await sleep(wait);
    // The wait can overrun (a delayed timer): send nothing whose answer cannot be used.
    if (remaining() <= 0) {
      stoppedAt = offset + i;
      notes.push(`Stopped at the time limit after ${rows.length} devices; continue with offset ${stoppedAt}.`);
      break;
    }
    // Another call may have been rate-limited while this one waited for its slot (or
    // before it started): send nothing more until that backoff ends.
    const backoff = pacer.backoffSeconds(now());
    if (backoff > 0) {
      stoppedAt = offset + i;
      rateLimited = {
        message:
          "Datto RMM rate-limited another datto_site_hardware call (HTTP 429), so no more audits were sent. " +
          `Try again in ${backoff} s.`,
        retryAfterSeconds: backoff,
      };
      notes.push(`Stopped: Datto RMM rate-limited the requests (HTTP 429). Try again in ${backoff} s, continuing with offset ${stoppedAt}.`);
      break;
    }
    const base = { deviceUid: d.uid, hostname: d.hostname, deviceType: d.deviceType, online: d.online };
    try {
      const audit = await withDeadline(observeRateLimit(deps.audit(d.uid)), remaining());
      if (audit === TIMED_OUT) {
        stoppedAt = offset + i;
        notes.push(
          `Stopped at the time limit while waiting for an audit, after ${rows.length} devices; continue with offset ${stoppedAt}.`
        );
        break;
      }
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
        // Concurrent calls sharing the pacer stop too, instead of sending queued audits.
        pacer.backOff(now() + (retryAfterSeconds ?? 60) * 1000);
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
