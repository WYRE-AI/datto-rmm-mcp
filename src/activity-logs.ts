/**
 * The account's Activity Log, for `datto_list_activity_logs`.
 *
 *   GET /v2/activity-logs?from=..&until=..&order=desc&size=..
 *       &entities=..&categories=..&actions=..&siteIds=..&userIds=..&searchQuery=..
 *
 * Parameters as documented in the v2 Swagger spec (`getActivities`, checked
 * 2026-11-20): `from`/`until` are UTC `yyyy-MM-ddTHH:mm:ssZ` (without `from`
 * the API returns only the last 15 minutes, so a default window is always
 * sent); `entities` is `device` and/or `user`; `categories`, `actions`,
 * `siteIds` and `userIds` take comma-separated values; `searchQuery` takes
 * Lucene syntax; paging follows `pageDetails.nextPageUrl` (a `searchAfter`
 * pointer). The SDK's `activityLogs` resource sends different parameter
 * names (see device-jobs.ts), so the endpoint is called directly.
 *
 * Row fields come from the spec's `ActivityLog` schema: `entity`,
 * `category`, `action`, `date` (unix seconds.fraction), `site` {id, name},
 * `deviceId`, `hostname`, `user` {id, userName, firstName, lastName} - the
 * RMM user who did the action - and `details`, a JSON object string.
 *
 * USER FILTER. `userIds` needs Datto's numeric user id, which the users
 * endpoint (`/v2/account/users`) does not return. So `userId` is sent to the
 * API, while `user` (a username or name) is matched here against each row's
 * `user`, and the rows' `userId` lets a follow-up call filter server-side.
 *
 * PAGING. A client-side filter can fill `max` part-way through a page, so
 * the continuation cursor is an opaque token holding the page URL, how many
 * rows of it were already consumed, and the client-side filters. Following
 * it re-reads that page (the URL is a fixed `searchAfter` pointer) and skips
 * those rows, so nothing is skipped or repeated.
 *
 * Datto keeps the Activity Log for 180 days. Seeing user (not device)
 * activity needs the Administrator security level.
 */

import type { DattoCredentials } from "./mcp-server.js";
import { PLATFORM_URLS, dattoApiGet } from "./patches.js";
import {
  activityTimeMs,
  parseDateInput,
  parseDetails,
  toApiDate,
  type ActivityLog,
  type ActivityLogsPage,
} from "./device-jobs.js";

/** Default look-back window when `from` is omitted. */
export const DEFAULT_ACTIVITY_LOOKBACK_DAYS = 7;
/** Datto RMM keeps activity logs this long. */
export const ACTIVITY_RETENTION_DAYS = 180;
/** Default / ceiling for rows returned per call. */
export const DEFAULT_MAX_ACTIVITIES = 50;
export const MAX_MAX_ACTIVITIES = 200;
/** Rows per request (the size device-jobs.ts uses against the live API). */
const PAGE_SIZE = 100;
/** Hard cap on pages read per call, to stay well inside Datto's read limit. */
export const MAX_ACTIVITY_PAGES = 10;
/** Compact `details`: per-value and per-row limits. */
const DETAIL_VALUE_CHARS = 200;
const DETAIL_MAX_KEYS = 25;
const DETAIL_STRING_CHARS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A category/action name: words of [A-Za-z0-9_.-] separated by single spaces
 *  (Datto has e.g. "Remote Control" and "Patch Start"), at most 64 chars. */
const LIST_VALUE_RE = /^(?=.{1,64}$)[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/;
const HOSTNAME_RE = /^[A-Za-z0-9._-]{1,253}$/;
const MAX_LIST_VALUES = 20;
const MAX_SEARCH_CHARS = 500;
const MAX_USER_CHARS = 100;

/**
 * Arguments of datto_list_activity_logs. A new search uses the filters; when
 * `cursor` is set it takes precedence and every other filter is ignored: the
 * search continues with the filters saved in the cursor.
 */
export interface ListActivityLogsOptions {
  from?: string;
  until?: string;
  /** Username or first/last name of the RMM user who did the action (client-side). */
  user?: string;
  /** Datto's numeric user id (server-side `userIds`). */
  userId?: number;
  entity?: string;
  /** One or more categories, comma-separated. */
  category?: string;
  /** One or more actions, comma-separated. */
  action?: string;
  /** Datto's numeric site id (server-side `siteIds`). */
  siteId?: number;
  /** Device hostname (server-side search, checked client-side). */
  hostname?: string;
  /** Raw Activity Log search query (Lucene syntax). */
  search?: string;
  order?: string;
  max?: number;
  /** `nextCursor` from a previous call; the other filters are then ignored. */
  cursor?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/** One activity, as returned by datto_list_activity_logs. */
export interface ActivityRow {
  time?: string;
  entity?: string;
  category?: string;
  action?: string;
  /** Username of the RMM user who did the action. */
  user?: string;
  userFullName?: string;
  /** Pass as `userId` to filter on this user server-side. */
  userId?: number;
  site?: string;
  /** Pass as `siteId` to filter on this site. */
  siteId?: number;
  hostname?: string;
  deviceId?: number;
  /** Compacted `details` (long values cut). */
  details?: Record<string, unknown> | string;
}

/**
 * Result of datto_list_activity_logs. `from`, `until` and `order` are only
 * returned for a new search; a call resumed with `cursor` returns the rows,
 * counts, notes and the next cursor, but not the original window.
 */
export interface ActivityLogsResult {
  from?: string;
  until?: string;
  order?: string;
  returned: number;
  /** Rows read from Datto (before the client-side user/hostname filters). */
  scanned: number;
  /** `category/action` counts over the returned rows. */
  summary: Record<string, number>;
  activities: ActivityRow[];
  /** Pass as `cursor` to get the next rows. */
  nextCursor?: string;
  notes?: string[];
}

/** Opaque continuation state (base64url JSON). */
interface Cursor {
  /** Page URL or path to read. */
  u: string;
  /** Rows of that page already consumed. */
  s: number;
  user?: string;
  host?: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function isActivityLogsUrl(u: string, apiUrl: string): boolean {
  return u.startsWith("/v2/activity-logs?") || u.startsWith(`${apiUrl}/api/v2/activity-logs?`);
}

function decodeCursor(token: string, apiUrl: string): Cursor {
  const invalid = new Error("cursor is not a nextCursor from datto_list_activity_logs; start again without it");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.trim(), "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object") throw invalid;
  const c = parsed as Partial<Cursor>;
  if (typeof c.u !== "string" || !isActivityLogsUrl(c.u, apiUrl)) throw invalid;
  if (typeof c.s !== "number" || !Number.isInteger(c.s) || c.s < 0) throw invalid;
  if (c.user !== undefined && (typeof c.user !== "string" || c.user.length > MAX_USER_CHARS)) throw invalid;
  if (c.host !== undefined && (typeof c.host !== "string" || !HOSTNAME_RE.test(c.host))) throw invalid;
  return { u: c.u, s: c.s, user: c.user, host: c.host };
}

function listParam(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const items = String(value)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (items.length === 0) return undefined;
  if (items.length > MAX_LIST_VALUES || !items.every((v) => LIST_VALUE_RE.test(v))) {
    throw new Error(`${field} must be up to ${MAX_LIST_VALUES} comma-separated names (letters, digits, spaces, _ . -)`);
  }
  return items.join(",");
}

function idParam(value: number | string | undefined, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${field} must be a positive whole number`);
  return String(n);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cut(value: string, chars: number): string {
  return value.length > chars ? `${value.slice(0, chars)}…` : value;
}

function compactDetails(raw: ActivityLog["details"]): ActivityRow["details"] {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = parseDetails(raw);
  if (!parsed) return typeof raw === "string" ? cut(raw, DETAIL_STRING_CHARS) : undefined;
  const out: Record<string, unknown> = {};
  let kept = 0;
  let dropped = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined || value === "") continue;
    if (kept >= DETAIL_MAX_KEYS) {
      dropped++;
      continue;
    }
    if (typeof value === "string") out[key] = cut(value, DETAIL_VALUE_CHARS);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = cut(JSON.stringify(value), DETAIL_VALUE_CHARS);
    kept++;
  }
  if (dropped > 0) out["…"] = `${dropped} more field(s) not shown`;
  return kept > 0 ? out : undefined;
}

function fullName(user: ActivityLog["user"]): string | undefined {
  if (!user) return undefined;
  return [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || undefined;
}

function userMatches(row: ActivityLog, needle: string): boolean {
  const user = row.user;
  if (!user) return false;
  return [user.userName, fullName(user), user.firstName, user.lastName].some(
    (v) => typeof v === "string" && v.toLowerCase().includes(needle)
  );
}

function rowHostname(row: ActivityLog): string | undefined {
  return str(row.hostname) ?? str(parseDetails(row.details)?.["device.hostname"]);
}

function toRow(row: ActivityLog): ActivityRow {
  const ms = activityTimeMs(row.date);
  const out: ActivityRow = {
    time: ms !== undefined ? new Date(ms).toISOString() : undefined,
    entity: str(row.entity)?.toLowerCase(),
    category: str(row.category),
    action: str(row.action),
    user: str(row.user?.userName),
    userFullName: fullName(row.user),
    userId: row.user?.id ?? undefined,
    site: str(row.site?.name),
    siteId: row.site?.id ?? undefined,
    hostname: rowHostname(row),
    deviceId: row.deviceId ?? undefined,
    details: compactDetails(row.details),
  };
  // Drop empty fields so the JSON stays compact.
  for (const key of Object.keys(out) as (keyof ActivityRow)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

const STRING_ARGS = ["from", "until", "user", "entity", "category", "action", "hostname", "search", "order", "cursor"] as const;
const NUMBER_ARGS = ["userId", "siteId", "max"] as const;

/**
 * Checks the raw tool arguments before anything is converted or sent to Datto:
 * text fields must be strings and `userId` / `siteId` / `max` numbers (or
 * digit strings), so `siteId: true` is an input error instead of becoming site 1.
 *
 * @throws Error naming the first argument with the wrong type.
 */
export function validateActivityLogsArgs(raw: unknown): ListActivityLogsOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("arguments must be an object");
  const args = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of STRING_ARGS) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    out[key] = v;
  }
  for (const key of NUMBER_ARGS) {
    const v = args[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
    } else if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      out[key] = Number(v.trim());
    } else {
      throw new Error(`${key} must be a number`);
    }
  }
  return out as ListActivityLogsOptions;
}

/**
 * Lists activity-log entries, newest first by default.
 *
 * @throws Error on invalid input or an API failure (including a 429, which
 *   is never retried); the tool handler turns it into an `isError` result.
 */
export async function listActivityLogs(
  creds: DattoCredentials,
  options: ListActivityLogsOptions = {}
): Promise<ActivityLogsResult> {
  const apiUrl = PLATFORM_URLS[creds.platform];
  const max = Math.min(Math.max(1, Math.floor(Number(options.max) || DEFAULT_MAX_ACTIVITIES)), MAX_MAX_ACTIVITIES);
  const notes: string[] = [];

  let start: Cursor;
  let window: { from?: string; until?: string; order?: string } = {};

  if (options.cursor) {
    start = decodeCursor(options.cursor, apiUrl);
  } else {
    const now = options.now ?? new Date();
    const until = options.until ? parseDateInput(options.until, "until") : now;
    const from = options.from
      ? parseDateInput(options.from, "from")
      : new Date(until.getTime() - DEFAULT_ACTIVITY_LOOKBACK_DAYS * DAY_MS);
    // Datto takes whole seconds: compare the bounds as they will be sent, so a window that
    // collapses at that precision is refused instead of sent as an empty range.
    const fromApi = toApiDate(from);
    const untilApi = toApiDate(until);
    if (from.getTime() >= until.getTime() || fromApi >= untilApi) {
      throw new Error("from must be earlier than until (Datto compares whole seconds)");
    }

    const order = options.order === undefined || options.order === "" ? "desc" : options.order;
    if (order !== "asc" && order !== "desc") throw new Error('order must be "asc" or "desc"');

    let entity: string | undefined;
    if (options.entity !== undefined && options.entity !== "") {
      entity = String(options.entity).trim().toLowerCase();
      if (entity !== "device" && entity !== "user") throw new Error('entity must be "device" or "user"');
    }

    const user = options.user?.trim().toLowerCase() || undefined;
    if (user && user.length > MAX_USER_CHARS) throw new Error(`user must be at most ${MAX_USER_CHARS} characters`);

    const host = options.hostname?.trim() || undefined;
    if (host && !HOSTNAME_RE.test(host)) {
      throw new Error("hostname must be a device hostname (letters, digits, . _ -)");
    }

    const search = options.search?.trim() || undefined;
    if (search && search.length > MAX_SEARCH_CHARS) {
      throw new Error(`search must be at most ${MAX_SEARCH_CHARS} characters`);
    }

    const query = new URLSearchParams({
      from: fromApi,
      until: untilApi,
      order,
      size: String(PAGE_SIZE),
    });
    if (entity) query.set("entities", entity);
    const categories = listParam(options.category, "category");
    if (categories) query.set("categories", categories);
    const actions = listParam(options.action, "action");
    if (actions) query.set("actions", actions);
    const siteIds = idParam(options.siteId, "siteId");
    if (siteIds) query.set("siteIds", siteIds);
    const userIds = idParam(options.userId, "userId");
    if (userIds) query.set("userIds", userIds);
    // Hostnames are restricted to [A-Za-z0-9._-], so quoting is enough.
    const searchParts = [host ? `device.hostname : "${host}"` : undefined, search ? `(${search})` : undefined].filter(
      (p): p is string => p !== undefined
    );
    if (searchParts.length > 0) query.set("searchQuery", searchParts.join(" AND "));

    start = { u: `/v2/activity-logs?${query.toString()}`, s: 0, user, host };
    window = { from: fromApi, until: untilApi, order };

    if (now.getTime() - from.getTime() > ACTIVITY_RETENTION_DAYS * DAY_MS) {
      notes.push(`Datto RMM keeps the Activity Log for ${ACTIVITY_RETENTION_DAYS} days; nothing older can be returned.`);
    }
  }

  const userNeedle = start.user;
  const hostNeedle = start.host?.toLowerCase();
  const matches = (row: ActivityLog): boolean => {
    if (userNeedle && !userMatches(row, userNeedle)) return false;
    if (hostNeedle && rowHostname(row)?.toLowerCase() !== hostNeedle) return false;
    return true;
  };

  const rows: ActivityRow[] = [];
  let scanned = 0;
  let pages = 0;
  let pageUrl: string | undefined = start.u;
  let skip = start.s;
  let next: Cursor | undefined;

  pageLoop: while (pageUrl) {
    if (pages >= MAX_ACTIVITY_PAGES) {
      next = { u: pageUrl, s: 0, user: start.user, host: start.host };
      notes.push(
        `Stopped after reading ${MAX_ACTIVITY_PAGES} pages (${scanned} entries) to stay inside Datto's rate limit. ` +
          "Continue with nextCursor, or narrow the window or filters (entity, category, userId, siteId)."
      );
      break;
    }
    pages++;
    const page: ActivityLogsPage = await dattoApiGet<ActivityLogsPage>(creds, pageUrl);
    if (page.error) throw new Error(`Datto RMM activity log error: ${page.error}`);
    const activities = page.activities ?? [];

    for (let i = skip; i < activities.length; i++) {
      if (!matches(activities[i])) {
        scanned++;
        continue;
      }
      if (rows.length >= max) {
        next = { u: pageUrl, s: i, user: start.user, host: start.host };
        break pageLoop;
      }
      scanned++;
      rows.push(toRow(activities[i]));
    }
    skip = 0;

    const nextUrl = page.pageDetails?.nextPageUrl ?? undefined;
    // Follow nextPageUrl until it is null, even past an empty page (the page cap bounds this).
    if (!nextUrl) break;
    if (!isActivityLogsUrl(nextUrl, apiUrl)) {
      throw new Error("Refusing to follow a Datto RMM paging URL outside the activity-log endpoint");
    }
    if (rows.length >= max) {
      next = { u: nextUrl, s: 0, user: start.user, host: start.host };
      break;
    }
    pageUrl = nextUrl;
  }

  const summary: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.category ?? "?"}/${r.action ?? "?"}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }

  if (rows.length === 0) {
    const filters = [
      // The filter actually searched for: the cursor's saved one when resuming.
      userNeedle
        ? `user "${!options.cursor && typeof options.user === "string" ? options.user.trim() : userNeedle}"`
        : undefined,
      start.host ? `hostname "${start.host}"` : undefined,
    ].filter(Boolean);
    notes.push(
      next
        ? "No matching entries in the pages read so far; more remain. Continue with nextCursor, or narrow the window or filters."
        : `No activity-log entries found${filters.length > 0 ? ` for ${filters.join(" and ")}` : ""}` +
            (options.cursor ? " after the cursor." : " between from and until with these filters.") +
            " Widen from (up to 180 days back) or loosen the filters. User activity, such as logins, is only visible" +
            " when the API user has the Administrator security level."
    );
  }

  return {
    ...window,
    returned: rows.length,
    scanned,
    summary,
    activities: rows,
    ...(next ? { nextCursor: encodeCursor(next) } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
