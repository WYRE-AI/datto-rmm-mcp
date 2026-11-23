/**
 * Hides chosen Datto RMM user-defined fields (UDFs) in device results.
 *
 * UDFs are free-form device fields that scripts often use for things that should not be
 * handed to every caller of a read tool: licence keys, recovery or BIOS passwords, and
 * similar. `DATTO_HIDDEN_UDFS` lists the UDF numbers to hide, comma or space separated
 * (example: `3,4,28`). In every device object of a result (`datto_get_device`,
 * `datto_list_devices`), each listed UDF that has a value is replaced with "[hidden]",
 * so the caller can still see that it is set. Empty (null) UDFs stay null. Unset or empty
 * `DATTO_HIDDEN_UDFS` changes nothing.
 */

export const HIDDEN = "[hidden]";

/** UDF keys ("udf3", "udf28", ...) to hide, from DATTO_HIDDEN_UDFS. Invalid items are ignored. */
export function hiddenUdfKeys(env: Record<string, string | undefined> = process.env): Set<string> {
  const keys = new Set<string>();
  for (const item of (env.DATTO_HIDDEN_UDFS ?? "").split(/[\s,;]+/)) {
    const m = /^(?:udf)?(\d{1,3})$/i.exec(item.trim());
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 300) keys.add(`udf${n}`);
    }
  }
  return keys;
}

/**
 * Returns a copy of `value` (a device, a list of devices, or any JSON value) with the
 * listed UDFs hidden wherever a `udf` object appears. The input is not changed.
 */
export function redactUdfs<T>(value: T, keys: Set<string>): T {
  if (keys.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (k === "udf" && child && typeof child === "object" && !Array.isArray(child)) {
          const udf: Record<string, unknown> = {};
          for (const [uk, uv] of Object.entries(child as Record<string, unknown>)) {
            udf[uk] = keys.has(uk.toLowerCase()) && uv !== null && uv !== undefined && uv !== "" ? HIDDEN : uv;
          }
          out[k] = udf;
        } else {
          out[k] = walk(child);
        }
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
