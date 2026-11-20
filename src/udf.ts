import type { UdfUpdateRequest } from "@wyre-ai/node-datto-rmm";
import { DEVICE_UID_RE } from "./device-jobs.js";

/** The Datto RMM v2 `Udf` request schema defines udf1 through udf3000. */
const UDF_KEY_RE = /^udf([1-9]\d?|[12]\d\d|300)$/;

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
    fields[key] = value;
  }
  return fields as UdfUpdateRequest;
}
