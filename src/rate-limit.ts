/**
 * Datto RMM rate-limit reporting.
 *
 * Datto RMM allows 600 reads and 100 writes per rolling 60 s, answers 429
 * above that, and blocks the source IP with a 403 (about 5 minutes) when
 * requests continue after a 429. So a 429 is never retried here: the call
 * fails at once with "HTTP 429" and "Try again in N s.", which tells the
 * caller (and any rate-limit monitor reading tool errors) how long to wait.
 */

/** Wait reported for a 429 without Retry-After (Datto's window is 60 s). */
export const RATE_LIMIT_WAIT_SECONDS = 60;

/** Datto's IP block after continued 429s lasts about 5 minutes. */
export const IP_BLOCK_WAIT_SECONDS = 300;

/** A 429 from a direct (non-SDK) Datto RMM call. */
export class DattoRateLimitedError extends Error {
  readonly statusCode = 429;

  constructor(
    readonly path: string,
    readonly retryAfterSeconds: number
  ) {
    super(rateLimitMessage(retryAfterSeconds, path));
    this.name = "DattoRateLimitedError";
  }
}

function rateLimitMessage(retryAfterSeconds: number, detail?: string): string {
  return (
    "Datto RMM rate-limited the request (HTTP 429 Too Many Requests). Not retried: continuing after a 429 " +
    `gets this IP blocked (HTTP 403). Try again in ${retryAfterSeconds} s.` +
    (detail ? ` Detail: ${detail}` : "")
  );
}

/** Whole seconds from a Retry-After header (seconds or HTTP date), at least 1; undefined if absent or invalid. */
export function retryAfterSeconds(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    if (!/[a-z]/i.test(trimmed)) return undefined;
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    ms = date - now;
  }
  return Math.max(1, Math.ceil(ms / 1000));
}

interface ErrorShape {
  statusCode?: unknown;
  name?: unknown;
  cooldownMs?: unknown;
}

/** True for a 429 or an IP block (SDK or direct call), duck-typed so SDK versions needn't match. */
export function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as ErrorShape;
  return e.statusCode === 429 || e.name === "DattoRmmIpBlockedError";
}

/**
 * Tool-error text for any thrown error. A rate-limit error that does not
 * already say how long to wait (older SDK messages) is reworded so it says
 * "HTTP 429" or "HTTP 403" and "Try again in N s.".
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRateLimitError(error) || /try again in \d+/i.test(message)) return message;
  const e = error as ErrorShape;
  if (e.statusCode === 429) return rateLimitMessage(RATE_LIMIT_WAIT_SECONDS, message);
  const seconds =
    typeof e.cooldownMs === "number" && e.cooldownMs > 0 ? Math.ceil(e.cooldownMs / 1000) : IP_BLOCK_WAIT_SECONDS;
  return (
    `Datto RMM blocked this IP after rate-limit violations (HTTP 403 Forbidden). Try again in ${seconds} s. ` +
    `Detail: ${message}`
  );
}
