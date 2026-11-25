/**
 * Datto RMM write calls and the input checks that run before them.
 *
 * WHY WRITES DO NOT GO THROUGH THE SDK
 * `@wyre-ai/node-datto-rmm` retries any 5xx once, whatever the method. For a
 * read that is harmless; for `PUT /device/{uid}/quickjob` it can start the
 * same job twice (Datto answers 500 for several job failures, including a
 * component Level above the API user's role). Every write here is therefore
 * sent exactly once with `fetch`:
 *   - 429: never retried; fails with "Try again in N s." (DattoRateLimitedError).
 *   - 403 that is the IP block (its body says so, or it arrives in the
 *     cooldown after a 429): never retried; reported as a rate limit.
 *   - 401: never retried; the cached token is dropped so the NEXT call gets a
 *     fresh one, but this write is reported as failed, not re-sent.
 *   - 5xx and anything else: reported as failed, never re-sent.
 *
 * WHY THE CHECKS
 * The write tools carry MCP annotations (readOnlyHint false, destructiveHint,
 * idempotentHint, openWorldHint) so MCP clients and gateways can gate them,
 * for example behind a confirmation. Whoever confirms sees the arguments, not
 * what Datto will do with them. These checks make the arguments mean exactly
 * one thing: a quick job names an existing component from the account's
 * catalogue (no free-form script), every variable is one the component
 * declares, unknown arguments are refused, and the target device exists.
 */

import type { DattoCredentials } from "./mcp-server.js";
import { PLATFORM_URLS, forgetAccessToken, getAccessToken } from "./patches.js";
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Bad tool input. Reported to the caller as is; nothing was sent to Datto. */
export class WriteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteValidationError";
  }
}

// ---------------------------------------------------------------------------
// One-shot write
// ---------------------------------------------------------------------------

/** Longest slice of a Datto error body put in a tool error. */
const MAX_ERROR_BODY = 300;

/**
 * Sends one write request to the Datto RMM API and returns the parsed JSON
 * body ({} when empty). Never retries (see the header comment).
 *
 * @param creds - Datto credentials for this request.
 * @param method - HTTP method.
 * @param path - API path below /api, e.g. `/v2/alert/{uid}/resolve`.
 * @param body - JSON body, if any.
 */
export async function dattoApiWrite(
  creds: DattoCredentials,
  method: "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${PLATFORM_URLS[creds.platform]}/api${path}`;
  const token = await getAccessToken(creds);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Never follow a redirect: a 307/308 would make fetch send the method and
    // body again, which for a quick job could start it twice. A 3xx is
    // reported as a failed write instead.
    redirect: "manual",
  });

  if (response.status === 429) {
    await response.text();
    noteRateLimited();
    throw new DattoRateLimitedError(
      path,
      retryAfterSeconds(response.headers.get("retry-after")) ?? RATE_LIMIT_WAIT_SECONDS
    );
  }

  const text = await response.text();

  if (response.status === 403) {
    if (looksLikeIpBlock(text)) {
      noteRateLimited();
      throw new DattoIpBlockedError(path);
    }
    // Presumed from the cooldown only: reported as the block, but it does not
    // restart the cooldown (see throwIfRateLimited in patches.ts).
    if (ipBlockSuspected()) throw new DattoIpBlockedError(path, IP_BLOCK_WAIT_SECONDS, true);
  }
  if (response.status === 401) {
    forgetAccessToken(creds);
  }
  if (!response.ok) {
    throw new Error(
      `Datto RMM ${method} ${path} failed: HTTP ${response.status} ${response.statusText}. Not retried.` +
        (text.trim() ? ` Detail: ${text.trim().slice(0, MAX_ERROR_BODY)}` : "")
    );
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { response: text.slice(0, MAX_ERROR_BODY) };
  }
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

/** Datto UIDs are GUIDs; this also keeps a value from changing the URL path. */
const UID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Control characters other than tab, CR and LF. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export const MAX_JOB_NAME_LENGTH = 100;
export const MAX_VARIABLE_VALUE_LENGTH = 1024;

/** Throws unless `args` is an object with only the listed keys. */
export function onlyKeys(args: unknown, allowed: string[]): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new WriteValidationError("Arguments must be an object.");
  }
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new WriteValidationError(
      `Unknown argument(s): ${extra.join(", ")}. Allowed: ${allowed.join(", ")}.`
    );
  }
  return args as Record<string, unknown>;
}

/** Returns a trimmed UID, or throws when it is missing or not UID-shaped. */
export function requireUid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UID_RE.test(value.trim())) {
    throw new WriteValidationError(`${field} must be a Datto UID (letters, digits and dashes).`);
  }
  return value.trim();
}

/** Returns a trimmed job name, or throws. */
export function requireJobName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WriteValidationError("jobName must be a non-empty string.");
  }
  const name = value.trim();
  if (name.length > MAX_JOB_NAME_LENGTH) {
    throw new WriteValidationError(`jobName must be at most ${MAX_JOB_NAME_LENGTH} characters.`);
  }
  if (CONTROL_RE.test(name) || /[\r\n]/.test(name)) {
    throw new WriteValidationError("jobName must not contain control characters or line breaks.");
  }
  return name;
}

/** One variable a component declares, read defensively from the raw API shape. */
export interface DeclaredVariable {
  name: string;
  type?: string;
  options?: string[];
}

/** The declared variables of a raw component; entries without a name are skipped. */
export function declaredVariables(component: { variables?: unknown }): DeclaredVariable[] {
  if (!Array.isArray(component.variables)) return [];
  const out: DeclaredVariable[] = [];
  for (const raw of component.variables) {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (typeof v.name !== "string" || !v.name) continue;
    const decl: DeclaredVariable = { name: v.name };
    if (typeof v.type === "string") decl.type = v.type;
    const opts = v.selectionOptions ?? v.options ?? v.selections;
    if (Array.isArray(opts)) {
      const values = opts
        .map((o) =>
          typeof o === "string"
            ? o
            : o && typeof o === "object"
              ? (o as Record<string, unknown>).value ?? (o as Record<string, unknown>).name
              : undefined
        )
        .filter((o): o is string => typeof o === "string");
      if (values.length > 0) decl.options = values;
    }
    out.push(decl);
  }
  return out;
}

/**
 * Checks the quick-job `variables` map against the component's declared
 * variables and returns the {name, value} array the API expects.
 *
 * - Each name must be one the component declares (exact match). A near miss
 *   in case is reported with the declared spelling.
 * - Values are strings, at most MAX_VARIABLE_VALUE_LENGTH characters, with no
 *   control characters (tab and line breaks are allowed).
 * - A boolean variable takes "true" or "false"; a selection variable one of
 *   its options (when the API lists them).
 */
export function validateQuickJobVariables(
  variables: unknown,
  component: { name?: string; variables?: unknown }
): { name: string; value: string }[] {
  if (variables === undefined || variables === null) return [];
  if (typeof variables !== "object" || Array.isArray(variables)) {
    throw new WriteValidationError("variables must be an object of name/value strings.");
  }
  const declared = declaredVariables(component);
  const byName = new Map(declared.map((d) => [d.name, d]));
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(variables as Record<string, unknown>)) {
    const decl = byName.get(name);
    if (!decl) {
      const near = declared.find((d) => d.name.toLowerCase() === name.toLowerCase());
      const known = declared.map((d) => d.name).join(", ") || "none";
      throw new WriteValidationError(
        `Component "${component.name ?? "?"}" has no variable "${name}".` +
          (near ? ` Did you mean "${near.name}"?` : "") +
          ` Its variables: ${known}.`
      );
    }
    if (typeof value !== "string") {
      throw new WriteValidationError(`Variable "${name}" must be a string.`);
    }
    if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
      throw new WriteValidationError(
        `Variable "${name}" must be at most ${MAX_VARIABLE_VALUE_LENGTH} characters.`
      );
    }
    if (CONTROL_RE.test(value)) {
      throw new WriteValidationError(`Variable "${name}" must not contain control characters.`);
    }
    if (decl.type && /bool/i.test(decl.type) && !/^(true|false)$/i.test(value)) {
      throw new WriteValidationError(`Variable "${name}" is a boolean: use "true" or "false".`);
    }
    if (decl.options && !decl.options.includes(value)) {
      throw new WriteValidationError(
        `Variable "${name}" must be one of: ${decl.options.join(", ")}.`
      );
    }
    out.push({ name, value });
  }
  return out;
}
