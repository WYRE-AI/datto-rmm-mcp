import type { UdfUpdateRequest } from "@wyre-ai/node-datto-rmm";

/** Datto RMM devices expose exactly udf1 through udf30. */
const UDF_KEY_RE = /^udf([1-9]|[12][0-9]|30)$/;

/**
 * Validates the `udf` argument of datto_set_device_udf. Rejecting unknown
 * keys and non-string values here gives the caller a clear error instead of
 * a silently ignored field or an opaque Datto 400.
 */
export function parseUdfFields(input: unknown): UdfUpdateRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("udf must be an object keyed udf1 through udf30");
  }
  const entries = Object.entries(input);
  if (entries.length === 0) {
    throw new Error("udf must contain at least one field");
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!UDF_KEY_RE.test(key)) {
      throw new Error(`Invalid UDF key "${key}": use udf1 through udf30`);
    }
    if (typeof value !== "string") {
      throw new Error(`UDF "${key}" must be a string`);
    }
    fields[key] = value;
  }
  return fields as UdfUpdateRequest;
}
