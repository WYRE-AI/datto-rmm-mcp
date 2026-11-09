/**
 * Recent job runs on one device, for `datto_list_device_jobs`.
 *
 * Every other job tool needs a jobUid, and the Datto RMM API has no "jobs for
 * a device" endpoint. The only listing is the activity log, so that is the
 * source here:
 *
 *   GET /v2/activity-logs?categories=job&entities=device&from=..&until=..
 *       &order=desc&size=..&searchQuery=device.uid : "<uid>"
 *
 * The published `@wyre-ai/node-datto-rmm@1.1.0` SDK has an `activityLogs`
 * resource, but it sends parameter names the API doesn't document (`startDate`,
 * `deviceUid`, `max`) and drops `categories`, `from` and `searchQuery`, so this
 * calls the endpoint directly through `dattoApiGet` (see patches.ts).
 *
 * FIELD NAMES. The Swagger spec documents the activity row (`id`, `entity`,
 * `category`, `action`, `date`, `site`, `deviceId`, `hostname`, `user`,
 * `details`, `hasStdOut`, `hasStdErr`) but types `details` as an opaque string.
 * Checked live against a real account (syrah, 2026-11-09): for job rows
 * `details` is a JSON object string with dotted keys - `job.uid`, `job.name`,
 * `job.status`, `job.id`, `job.scheduled_job_uid`, `device.uid`,
 * `device.hostname`, `note`, ... `job.uid` is the jobUid the other job tools
 * take: `GET /v2/job/{job.uid}` and `/results/{deviceUid}` both returned 200,
 * while `job.scheduled_job_uid` and the row's own `uid` returned 404.
 *
 * SERVER-SIDE DEVICE FILTER. The endpoint has no deviceUid parameter. Verified
 * live, `searchQuery=device.uid : "<uid>"` returns only that device's rows
 * (36/36 in a 7-day window), so a busy site isn't paged through to find one
 * device. Rows are still checked against `details["device.uid"]` client-side,
 * so the result stays correct if the search syntax ever stops filtering.
 *
 * STATUS. A job row's `job.status` is always "scheduled" - the row records the
 * deployment, not the outcome. The outcome comes from
 * `GET /v2/job/{jobUid}/results/{deviceUid}` (`jobDeploymentStatus`, `ranOn`,
 * `componentResults[].componentName`). Recurring jobs reuse ONE job.uid for
 * every run, and that endpoint only holds the most recent run (verified live:
 * `ranOn` matched the newest of two runs). So a result is attached only to the
 * row whose deployment time matches its `ranOn`; older runs say so instead of
 * borrowing the latest run's outcome.
 */

import type { DattoCredentials } from "./mcp-server.js";
import { dattoApiGet } from "./patches.js";

/** Default look-back window when `since` is omitted. */
export const DEFAULT_LOOKBACK_DAYS = 7;
/** Default / ceiling for the number of job rows returned. */
export const DEFAULT_MAX_JOBS = 25;
export const MAX_MAX_JOBS = 100;
/** Activity-log page size (rows per request). */
const PAGE_SIZE = 100;
/** Hard cap on activity-log pages read per call, to respect rate limits. */
const MAX_PAGES = 10;
/** Hard cap on per-job results lookups per call. */
const MAX_RESULT_LOOKUPS = 50;
/** How close a result's `ranOn` must be to a row's deployment time to belong to it. */
const RAN_ON_MATCH_MS = 5 * 60 * 1000;

/** Datto RMM device UIDs are GUIDs; anything else can't be one, and is never
 *  placed into a search query. */
const DEVICE_UID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Activity-log row, as documented in the v2 Swagger spec. */
interface ActivityLog {
  id?: string;
  entity?: string;
  category?: string;
  action?: string;
  /** Unix seconds with a fractional part ("seconds.nanoseconds"). */
  date?: number | string;
  deviceId?: number;
  hostname?: string;
  user?: {
    id?: number;
    userName?: string;
    firstName?: string;
    lastName?: string;
  } | null;
  details?: string | Record<string, unknown>;
  hasStdOut?: boolean;
  hasStdErr?: boolean;
}

interface ActivityLogsPage {
  pageDetails?: { nextPageUrl?: string | null };
  activities?: ActivityLog[];
  /** Set when the request fails at Datto's database layer. */
  error?: string;
}

/** `GET /v2/job/{jobUid}/results/{deviceUid}` (Swagger `JobResults`). */
interface JobResults {
  jobUid?: string;
  deviceUid?: string;
  /** Swagger says date-time; the live API returns epoch milliseconds. */
  ranOn?: number | string | null;
  jobDeploymentStatus?: string;
  componentResults?: {
    componentUid?: string;
    componentName?: string;
    componentStatus?: string;
    numberOfWarnings?: number;
    hasStdOut?: boolean;
    hasStdErr?: boolean;
  }[];
}

/** One job run on the device, as returned by datto_list_device_jobs. */
export interface DeviceJobRun {
  /** Pass to datto_get_job / _results / _stdout / _stderr with the deviceUid. */
  jobUid: string;
  jobName?: string;
  /** When the job was deployed to the device (activity-log time, ISO 8601). */
  deployedAt?: string;
  /** Component(s) the job runs, from the job's latest result. */
  componentNames?: string[];
  /** Outcome of THIS run, only when the job's stored result is for this run. */
  status?: string;
  ranOn?: string;
  components?: {
    name?: string;
    status?: string;
    warnings?: number;
    hasStdOut?: boolean;
    hasStdErr?: boolean;
  }[];
  /** Explains a missing status. */
  statusNote?: string;
  hasStdOut?: boolean;
  hasStdErr?: boolean;
  /** RMM user the activity row names, when Datto records one. */
  startedBy?: string;
}

export interface DeviceJobsResult {
  deviceUid: string;
  since: string;
  until: string;
  returned: number;
  jobs: DeviceJobRun[];
  notes?: string[];
}

export interface ListDeviceJobsOptions {
  since?: string;
  until?: string;
  name?: string;
  max?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

/** `yyyy-MM-ddTHH:mm:ssZ` - the format the endpoint documents (no millis). */
function toApiDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A date-time with no `Z` / `±hh:mm` offset. JS would read it in the host's
 *  local zone; the tool promises UTC, so `Z` is appended. Date-only strings
 *  are already parsed as UTC by `Date`. */
const OFFSET_FREE_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function parseDateInput(value: string, field: string): Date {
  const trimmed = value.trim();
  const d = new Date(OFFSET_FREE_DATE_TIME_RE.test(trimmed) ? `${trimmed}Z` : trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${field} must be an ISO 8601 date or date-time, e.g. 2026-11-01 or 2026-11-01T09:00:00Z`);
  }
  return d;
}

function activityTimeMs(date: ActivityLog["date"]): number | undefined {
  if (date === undefined || date === null) return undefined;
  const seconds = Number(date);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

function ranOnMs(ranOn: JobResults["ranOn"]): number | undefined {
  if (ranOn === undefined || ranOn === null) return undefined;
  if (typeof ranOn === "number") return ranOn;
  const asNumber = Number(ranOn);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(ranOn);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseDetails(details: ActivityLog["details"]): Record<string, unknown> | undefined {
  if (!details) return undefined;
  if (typeof details === "object") return details;
  try {
    const parsed: unknown = JSON.parse(details);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function startedBy(user: ActivityLog["user"]): string | undefined {
  if (!user) return undefined;
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return str(user.userName) ?? (full || undefined);
}

/** Outcome of one `/results/{deviceUid}` lookup. */
type Lookup =
  | { kind: "ok"; result: JobResults }
  /** 404 or an empty body: Datto holds no result for this job/device. */
  | { kind: "missing" }
  /** Any other failure (permission, rate limit, server, network). */
  | { kind: "failed"; message: string }
  /** Not attempted: per-call lookup cap reached. */
  | { kind: "skipped" };

/** The SDK throws `DattoRmmNotFoundError` (statusCode 404) for a missing
 *  resource; duck-typed so a test stub or SDK upgrade needn't share the class. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

interface Candidate {
  jobUid: string;
  jobName?: string;
  timeMs?: number;
  row: ActivityLog;
}

/**
 * Lists job runs on a device, newest first.
 *
 * @param creds - Credentials for the direct activity-log call.
 * @param getResult - Fetches `/v2/job/{jobUid}/results/{deviceUid}` for this
 *   device (the SDK's `client.jobs.results`, so it shares the SDK's rate
 *   limiter).
 * @throws Error on invalid input or an API failure; the tool handler turns it
 *   into an `isError` result like every other tool.
 */
export async function listDeviceJobs(
  creds: DattoCredentials,
  deviceUid: string,
  getResult: (jobUid: string) => Promise<unknown>,
  options: ListDeviceJobsOptions = {}
): Promise<DeviceJobsResult> {
  const uid = deviceUid?.trim() ?? "";
  if (!DEVICE_UID_RE.test(uid)) {
    throw new Error("deviceUid must be a Datto RMM device UID (letters, digits and hyphens)");
  }

  const now = options.now ?? new Date();
  const until = options.until ? parseDateInput(options.until, "until") : now;
  const since = options.since
    ? parseDateInput(options.since, "since")
    : new Date(until.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (since.getTime() >= until.getTime()) {
    throw new Error("since must be earlier than until");
  }

  const max = Math.min(Math.max(1, Math.floor(options.max || DEFAULT_MAX_JOBS)), MAX_MAX_JOBS);
  const nameFilter = options.name?.trim().toLowerCase() || undefined;
  const notes: string[] = [];

  // Per-job results, fetched at most once each and capped per call. A 404
  // means Datto holds no result; any other failure (403, 429, 5xx, network)
  // is kept apart so it is reported, never mistaken for "no result".
  const results = new Map<string, Lookup>();
  let lookups = 0;
  let lookupCapHit = false;
  const resultFor = async (jobUid: string): Promise<Lookup> => {
    const cached = results.get(jobUid);
    if (cached) return cached;
    if (lookups >= MAX_RESULT_LOOKUPS) {
      lookupCapHit = true;
      return { kind: "skipped" };
    }
    lookups++;
    let lookup: Lookup;
    try {
      const raw = (await getResult(jobUid)) as JobResults | undefined;
      lookup = raw && typeof raw === "object" ? { kind: "ok", result: raw } : { kind: "missing" };
    } catch (error) {
      lookup = isNotFound(error)
        ? { kind: "missing" }
        : { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    results.set(jobUid, lookup);
    return lookup;
  };
  const componentNamesOf = (l: Lookup): string[] =>
    (l.kind === "ok" ? (l.result.componentResults ?? []) : [])
      .map((c) => c.componentName)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  // Jobs a name filter could not be checked against (lookup failed/skipped).
  const uncheckedByFilter = new Set<string>();

  const query = new URLSearchParams({
    categories: "job",
    entities: "device",
    order: "desc",
    size: String(PAGE_SIZE),
    from: toApiDate(since),
    until: toApiDate(until),
    searchQuery: `device.uid : "${uid}"`,
  });

  const accepted: Candidate[] = [];
  let next: string | null | undefined = `/v2/activity-logs?${query.toString()}`;
  let pages = 0;

  while (next && pages < MAX_PAGES && accepted.length < max) {
    pages++;
    const page: ActivityLogsPage = await dattoApiGet<ActivityLogsPage>(creds, next);
    if (page.error) {
      throw new Error(`Datto RMM activity log error: ${page.error}`);
    }

    for (const row of page.activities ?? []) {
      const details = parseDetails(row.details);
      const jobUid = str(details?.["job.uid"]);
      if (!jobUid || str(details?.["device.uid"]) !== uid) continue;

      const candidate: Candidate = {
        jobUid,
        jobName: str(details?.["job.name"]),
        timeMs: activityTimeMs(row.date),
        row,
      };

      if (nameFilter && !candidate.jobName?.toLowerCase().includes(nameFilter)) {
        // Job names often differ from the component they run (scheduled
        // jobs), so fall back to the component names from the job's result.
        const lookup = await resultFor(jobUid);
        if (lookup.kind === "failed" || lookup.kind === "skipped") {
          uncheckedByFilter.add(jobUid);
          continue;
        }
        if (!componentNamesOf(lookup).some((n) => n.toLowerCase().includes(nameFilter))) continue;
      }

      accepted.push(candidate);
      if (accepted.length >= max) break;
    }

    next = page.pageDetails?.nextPageUrl;
  }

  if (next && accepted.length < max) {
    notes.push(
      `Stopped after ${MAX_PAGES} activity-log pages; older runs in the window were not read. Narrow since/until to see them.`
    );
  }

  // An untimed result (pending/running) can only be pinned to a deployment
  // when the window reaches the present: then the first (newest) row for
  // that job is its latest deployment. Older rows, or a historical window
  // that may exclude the latest deployment, get no borrowed status.
  const windowReachesNow = now.getTime() - until.getTime() <= RAN_ON_MATCH_MS;
  const seenJob = new Set<string>();

  const jobs: DeviceJobRun[] = [];
  let olderRunWithoutStatus = false;
  let lookupFailed = false;
  for (const c of accepted) {
    const lookup = await resultFor(c.jobUid);
    const isNewestForJob = !seenJob.has(c.jobUid);
    seenJob.add(c.jobUid);
    const result = lookup.kind === "ok" ? lookup.result : undefined;
    const run: DeviceJobRun = {
      jobUid: c.jobUid,
      jobName: c.jobName,
      deployedAt: c.timeMs !== undefined ? new Date(c.timeMs).toISOString() : undefined,
      hasStdOut: c.row.hasStdOut,
      hasStdErr: c.row.hasStdErr,
      startedBy: startedBy(c.row.user),
    };

    const names = componentNamesOf(lookup);
    if (names.length > 0) run.componentNames = names;

    const ran = ranOnMs(result?.ranOn);
    if (result && ran !== undefined && c.timeMs !== undefined && Math.abs(ran - c.timeMs) <= RAN_ON_MATCH_MS) {
      run.status = result.jobDeploymentStatus;
      run.ranOn = new Date(ran).toISOString();
      run.components = (result.componentResults ?? []).map((cr) => ({
        name: cr.componentName,
        status: cr.componentStatus,
        warnings: cr.numberOfWarnings,
        hasStdOut: cr.hasStdOut,
        hasStdErr: cr.hasStdErr,
      }));
    } else if (lookup.kind === "skipped") {
      run.statusNote = "Not looked up (per-call results lookup limit reached).";
    } else if (lookup.kind === "missing") {
      run.statusNote = "Datto RMM returned no stored result for this job on this device.";
    } else if (lookup.kind === "failed") {
      lookupFailed = true;
      run.statusNote = `Results lookup failed, so this run's outcome is unknown: ${lookup.message}`;
    } else if (ran === undefined) {
      if (isNewestForJob && windowReachesNow) {
        run.status = result?.jobDeploymentStatus;
        run.statusNote = "Result has no run time yet (job may be pending or running).";
      } else {
        run.statusNote =
          "The job's latest result has no run time yet, so it can't be matched to this run; this run's outcome is unknown.";
      }
    } else {
      olderRunWithoutStatus = true;
      run.statusNote =
        "Earlier run of a recurring job: Datto RMM stores results only for the latest run, so this run's outcome and output are no longer available.";
    }

    jobs.push(run);
  }

  if (olderRunWithoutStatus) {
    notes.push(
      "datto_get_job_results / _stdout / _stderr return the LATEST run of a job on a device. For a recurring job, rows without a status are earlier runs whose output is gone."
    );
  }
  if (lookupCapHit) {
    notes.push(`Results were looked up for at most ${MAX_RESULT_LOOKUPS} jobs this call; some rows have no status or component names.`);
  }
  if (lookupFailed) {
    notes.push("Some results lookups failed (see statusNote); those runs' outcomes are unknown, not missing.");
  }
  if (uncheckedByFilter.size > 0) {
    notes.push(
      `Incomplete search: ${uncheckedByFilter.size} job(s) whose name didn't match could not be checked against the component-name filter because their results lookup failed or hit the per-call limit. Retry, or narrow since/until.`
    );
  }
  if (jobs.length === 0 && uncheckedByFilter.size === 0) {
    notes.push(
      nameFilter
        ? `No job runs matching "${options.name}" on this device between since and until.`
        : "No job runs on this device between since and until. Widen the window with since."
    );
  }

  return {
    deviceUid: uid,
    since: toApiDate(since),
    until: toApiDate(until),
    returned: jobs.length,
    jobs,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
