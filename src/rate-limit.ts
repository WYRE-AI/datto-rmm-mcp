/**
 * Datto RMM rate-limit reporting.
 *
 * Datto RMM allows 600 reads and 100 writes per rolling 60 s, answers 429
 * above that, and blocks the source IP with a 403 (about 5 minutes) when
 * requests continue after a 429. So a 429 is never retried here: the call
 * fails at once with "HTTP 429" and "Try again in N s.", which tells the
 * caller (and any rate-limit monitor reading tool errors) how long to wait.
 *
 * A 403 is a rate limit when it is Datto's IP block: either its body says so
 * ("rate limit", "blocked", "too many requests"), or it arrives while this
 * process is in the cooldown that follows a 429 or a confirmed block. Any
 * other 403 (a permissions error) stays an ordinary error.
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

/**
 * Datto blocked this IP after rate-limit violations (HTTP 403), seen on a
 * direct (non-SDK) call. `presumed` is true for a bare 403 taken to be the
 * block only because it arrived during the cooldown: it is still reported as
 * a rate limit, but it never renews the cooldown.
 */
export class DattoIpBlockedError extends Error {
  readonly statusCode = 403;
  readonly cooldownMs: number;

  constructor(
    path: string,
    seconds: number = IP_BLOCK_WAIT_SECONDS,
    readonly presumed: boolean = false
  ) {
    super(
      "Datto RMM blocked this IP after rate-limit violations (HTTP 403 Forbidden). Not retried. " +
        `Try again in ${seconds} s. Detail: ${path}`
    );
    // Same name as the SDK's error, so both are recognised the same way.
    this.name = "DattoRmmIpBlockedError";
    this.cooldownMs = seconds * 1000;
  }
}

function rateLimitMessage(retryAfterSeconds: number, detail?: string): string {
  return (
    "Datto RMM rate-limited the request (HTTP 429 Too Many Requests). Not retried: continuing after a 429 " +
    `gets this IP blocked (HTTP 403). Try again in ${retryAfterSeconds} s.` +
    (detail ? ` Detail: ${detail}` : "")
  );
}

// Until when (epoch ms) a 403 without a telling body is taken to be the IP
// block. Process-wide, because Datto blocks the source IP, not a credential.
let ipBlockSuspectedUntil = 0;

/**
 * Records a 429 or a confirmed IP block. For the next `seconds` (default: the
 * 60 s rate window plus the 5-minute block) a bare 403 is reported as the IP
 * block instead of a permissions error. A 403 that is only presumed to be the
 * block does not extend the window.
 */
export function noteRateLimited(
  seconds: number = RATE_LIMIT_WAIT_SECONDS + IP_BLOCK_WAIT_SECONDS,
  now: number = Date.now()
): void {
  ipBlockSuspectedUntil = Math.max(ipBlockSuspectedUntil, now + seconds * 1000);
}

/** True while a bare 403 is presumed to be the IP block (see noteRateLimited). */
export function ipBlockSuspected(now: number = Date.now()): boolean {
  return now < ipBlockSuspectedUntil;
}


/** Clears the cooldown state (for tests). */
export function resetRateLimitState(): void {
  ipBlockSuspectedUntil = 0;
}

/** True when a 403 body or message reads as Datto's rate-limit IP block. */
export function looksLikeIpBlock(text: string): boolean {
  return /rate[\s_-]?limit|\bblocked\b|too many requests/i.test(text);
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
  presumed?: unknown;
  message?: unknown;
  response?: unknown;
}

/**
 * A 429, a named IP block, or a 403 whose text says it is the IP block. A
 * block presumed only from the cooldown is not confirmed, so it cannot renew it.
 */
function isConfirmedRateLimit(e: ErrorShape): boolean {
  if (e.presumed === true) return false;
  if (e.statusCode === 429 || e.name === "DattoRmmIpBlockedError") return true;
  if (e.statusCode !== 403) return false;
  // The SDK only spots an IP block in a JSON body; a plain-text one arrives
  // as an ordinary 403 whose message or response carries the wording.
  const message = typeof e.message === "string" ? e.message : "";
  const body = typeof e.response === "string" ? e.response : "";
  return looksLikeIpBlock(message) || looksLikeIpBlock(body);
}

/**
 * True for a 429 or an IP block (SDK or direct call), duck-typed so SDK
 * versions needn't match. A bare 403 counts while the cooldown after a 429
 * or a block is running (see noteRateLimited), and not otherwise.
 */
export function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as ErrorShape;
  if (e.name === "DattoRmmIpBlockedError") return true;
  return isConfirmedRateLimit(e) || (e.statusCode === 403 && ipBlockSuspected());
}

/**
 * Tool-error text for any thrown error, plus, for a rate limit, the wait in
 * whole seconds (at least 1). A rate-limit error that does not already say
 * how long to wait (older SDK messages) is reworded so it says "HTTP 429" or
 * "HTTP 403" and "Try again in N s."; `retryAfterSeconds` is always that N,
 * and a stated wait below 1 s is raised to 1 in the text as well.
 */
export function rateLimitDetails(error: unknown): { message: string; retryAfterSeconds?: number } {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRateLimitError(error)) return { message };
  const e = error as ErrorShape;
  if (isConfirmedRateLimit(e)) noteRateLimited();
  const stated = /(try again in )(\d+)( s)/i.exec(message);
  if (stated) {
    const seconds = Math.max(1, Number(stated[2]));
    return {
      message: message.replace(stated[0], `${stated[1]}${seconds}${stated[3]}`),
      retryAfterSeconds: seconds,
    };
  }
  if (e.statusCode === 429) {
    return { message: rateLimitMessage(RATE_LIMIT_WAIT_SECONDS, message), retryAfterSeconds: RATE_LIMIT_WAIT_SECONDS };
  }
  const seconds =
    typeof e.cooldownMs === "number" && e.cooldownMs > 0 ? Math.ceil(e.cooldownMs / 1000) : IP_BLOCK_WAIT_SECONDS;
  return {
    message:
      `Datto RMM blocked this IP after rate-limit violations (HTTP 403 Forbidden). Try again in ${seconds} s. ` +
      `Detail: ${message}`,
    retryAfterSeconds: seconds,
  };
}

/** Tool-error text for any thrown error (see rateLimitDetails). */
export function describeError(error: unknown): string {
  return rateLimitDetails(error).message;
}
