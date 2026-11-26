import type { UdfUpdateRequest } from "@wyre-ai/node-datto-rmm";
import { DEVICE_UID_RE } from "./device-jobs.js";

/** The Datto RMM v2 `Udf` request schema defines udf1 through udf3000. */
const UDF_KEY_RE = /^udf([1-9]\d?|[12]\d\d|300)$/;

/** Datto RMM stores at most 255 characters in a UDF. */
export const MAX_UDF_VALUE_LENGTH = 255;

/** Control characters, including line breaks (a UDF is a single line); tab is allowed. */
// eslint-disable-next-line no-control-regex
const UDF_CONTROL_RE = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * Validates the deviceUid of datto_set_device_udf. The SDK interpolates it
 * into the request path unencoded, so anything but a GUID-shaped value
 * (e.g. `../alert/X/resolve?`) could redirect this write tool to another
 * Datto endpoint.
 */
export function parseDeviceUid(input: unknown): string {
  if (typeof input !== "string" || !DEVICE_UID_RE.test(input)) {
    throw new Error(
      "deviceUid must be a Datto RMM device UID (letters, digits and hyphens)"
    );
  }
  return input;
}

/**
 * Validates the `udf` argument of datto_set_device_udf. Rejecting unknown
 * keys and non-string values here gives the caller a clear error instead of
 * a silently ignored field or an opaque Datto 400.
 */
export function parseUdfFields(input: unknown): UdfUpdateRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("udf must be an object keyed udf1 through udf300");
  }
  const entries = Object.entries(input);
  if (entries.length === 0) {
    throw new Error("udf must contain at least one field");
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!UDF_KEY_RE.test(key)) {
      throw new Error(`Invalid UDF key "${key}": use udf1 through udf300`);
    }
    if (typeof value !== "string") {
      throw new Error(`UDF "${key}" must be a string`);
    }
    if (value.length > MAX_UDF_VALUE_LENGTH) {
      throw new Error(`UDF "${key}" must be at most ${MAX_UDF_VALUE_LENGTH} characters`);
    }
    if (UDF_CONTROL_RE.test(value)) {
      throw new Error(`UDF "${key}" must not contain control characters or line breaks`);
    }
    fields[key] = value;
  }
  return fields as UdfUpdateRequest;
}

/**
 * Refuses an update that names a UDF listed in DATTO_HIDDEN_UDFS (see
 * udf-redact.ts): those hold secrets, so this server neither shows nor
 * writes them. Opt-in: with DATTO_HIDDEN_UDFS unset, `hidden` is empty and
 * nothing is refused. The value is never repeated in the error.
 */
export function refuseHiddenUdfs(fields: UdfUpdateRequest, hidden: ReadonlySet<string>): void {
  const refused = Object.keys(fields).filter((key) => hidden.has(key));
  if (refused.length > 0) {
    throw new Error(
      `${refused.join(", ")} ${refused.length === 1 ? "is a hidden UDF" : "are hidden UDFs"} ` +
        "(DATTO_HIDDEN_UDFS) and cannot be written through this server. Nothing was changed."
    );
  }
}
