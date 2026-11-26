import { describe, it, expect } from "vitest";
import {
  AuditPacer,
  sharedAuditPacer,
  siteHardware,
  siteHardwareConfig,
  DEFAULT_BUDGET_MS,
  DEFAULT_PAGE_SIZE,
  MAX_BUDGET_MS,
  MAX_PAGE_SIZE,
  MIN_BUDGET_MS,
} from "../site-hardware.js";
import { DattoIpBlockedError, DattoRateLimitedError, rateLimitDetails, resetRateLimitState } from "../rate-limit.js";
import { hiddenUdfKeys, redactUdfs, HIDDEN } from "../udf-redact.js";

function devices(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uid: `uid-${i}`,
    hostname: `HOST-${String(n - i).padStart(3, "0")}`, // reverse order, so sorting is visible
    deviceType: { category: "Laptop" },
    online: i % 2 === 0,
  }));
}

function audit(uid: string) {
  return {
    systemInfo: { manufacturer: "HP", model: `Model ${uid}` },
    bios: { serialNumber: `SN-${uid}` },
  };
}

function clock() {
  let t = 0;
  return {
    pacer: new AuditPacer(),
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("siteHardware ordering, shared pacing and deadline", () => {
  it("breaks hostname ties by device UID, whatever order the list arrives in", async () => {
    const a = { uid: "uid-a", hostname: "PC" };
    const b = { uid: "uid-b", hostname: "pc" };
    const page = async (list: unknown[], offset: number) =>
      (await siteHardware("s", { listDevices: async () => list, audit: async (u) => audit(u), ...clock() }, { offset, max: 1 }))
        .devices[0].deviceUid;
    expect([await page([a, b], 0), await page([b, a], 1)]).toEqual(["uid-a", "uid-b"]);
    expect([await page([b, a], 0), await page([a, b], 1)]).toEqual(["uid-a", "uid-b"]);
  });

  it("spaces audits across concurrent calls that share a pacer", async () => {
    let t = 0;
    const starts: number[] = [];
    const pacer = new AuditPacer();
    const deps = {
      listDevices: async () => devices(4),
      audit: async (u: string) => (starts.push(t), audit(u)),
      now: () => t,
      sleep: async (ms: number) => {
        const target = t + ms;
        await Promise.resolve();
        t = Math.max(t, target);
      },
      pacer,
    };
    await Promise.all([siteHardware("s1", deps, { gapMs: 300 }), siteHardware("s2", deps, { gapMs: 300 })]);
    expect(starts).toHaveLength(8);
    const sorted = [...starts].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(300);
  });

  it("returns the rows read so far when an audit is still pending at the deadline", async () => {
    let calls = 0;
    const r = await siteHardware(
      "s",
      {
        listDevices: async () => devices(3),
        audit: (u) => (calls++ === 0 ? Promise.resolve(audit(u)) : new Promise(() => {})),
        pacer: new AuditPacer(),
      },
      { gapMs: 0, budgetMs: 50 }
    );
    expect(r.returned).toBe(1);
    expect(r.nextOffset).toBe(1);
    expect(r.notes?.join(" ")).toMatch(/waiting for an audit/);
  });

  it("stops a concurrent call's queued audits when another call gets a 429", async () => {
    let t = 0;
    let calls = 0;
    const pacer = new AuditPacer();
    const deps = {
      listDevices: async () => devices(4),
      audit: async (u: string) => {
        if (++calls === 2) throw new DattoRateLimitedError("/v2/audit/device", 20);
        return audit(u);
      },
      now: () => t,
      sleep: async (ms: number) => {
        const target = t + ms;
        await new Promise((r) => setTimeout(r, 0)); // a real wait: other calls finish handling their responses
        t = Math.max(t, target);
      },
      pacer,
    };
    const [a, b] = await Promise.all([siteHardware("s1", deps, { gapMs: 300 }), siteHardware("s2", deps, { gapMs: 300 })]);
    expect(calls).toBe(2); // nothing is sent after the 429
    expect(a.rateLimited?.retryAfterSeconds).toBeGreaterThan(0);
    expect(b.rateLimited?.retryAfterSeconds).toBeGreaterThan(0);
    // A new call during the backoff sends nothing either.
    const later = await siteHardware("s3", deps, { gapMs: 300 });
    expect(calls).toBe(2);
    expect(later.returned).toBe(0);
    expect(later.rateLimited?.message).toMatch(/Try again in [0-9]+ s/);
  });

  it("aborts the device listing when it outlasts the budget, so no more pages are requested", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      siteHardware(
        "s",
        {
          listDevices: (s) => ((signal = s), new Promise(() => {})),
          audit: async (u) => audit(u),
          pacer: new AuditPacer(),
        },
        { budgetMs: 50 }
      )
    ).rejects.toThrow(/took longer/);
    expect(signal?.aborted).toBe(true);
  });

  it("records a 429 from an audit that answers after the deadline", async () => {
    const pacer = new AuditPacer();
    const r = await siteHardware(
      "s",
      {
        listDevices: async () => devices(2),
        audit: () =>
          new Promise((_, reject) => setTimeout(() => reject(new DattoRateLimitedError("/v2/audit/device", 20)), 100)),
        pacer,
      },
      { gapMs: 0, budgetMs: 50 }
    );
    expect(r.returned).toBe(0);
    expect(pacer.backoffSeconds(Date.now())).toBe(0); // not yet answered
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pacer.backoffSeconds(Date.now())).toBeGreaterThan(0);
  });

  it("does not list the devices while another call's backoff is running", async () => {
    const pacer = new AuditPacer();
    pacer.backOff(Date.now() + 20_000);
    let listed = 0;
    const r = await siteHardware(
      "s",
      { listDevices: async () => (listed++, devices(2)), audit: async (u) => audit(u), pacer },
      { offset: 3 }
    );
    expect(listed).toBe(0);
    expect(r.returned).toBe(0);
    expect(r.nextOffset).toBe(3);
    expect(r.rateLimited?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("aborts a listing in progress when another call records a rate limit", async () => {
    const pacer = new AuditPacer();
    let signal: AbortSignal | undefined;
    let audits = 0;
    setTimeout(() => pacer.backOff(Date.now() + 20_000), 10);
    const r = await siteHardware(
      "s",
      {
        // Pages keep coming until the signal is aborted; then the partial list is returned.
        listDevices: (s) =>
          ((signal = s), new Promise((resolve) => s.addEventListener("abort", () => resolve(devices(1))))),
        audit: async (u) => (audits++, audit(u)),
        pacer,
      },
      { budgetMs: 5_000 }
    );
    expect(signal?.aborted).toBe(true);
    expect(audits).toBe(0);
    expect(r.rateLimited?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("records a 429 on the device listing, so other calls back off too", async () => {
    const pacer = new AuditPacer();
    await expect(
      siteHardware(
        "s",
        { listDevices: async () => Promise.reject(new DattoRateLimitedError("/v2/site/devices", 20)), audit: async (u) => audit(u), pacer },
        {}
      )
    ).rejects.toThrow(/HTTP 429/);
    expect(pacer.backoffSeconds(Date.now())).toBeGreaterThan(0);
  });

  it("rechecks the deadline after the pacing wait, so an overrun wait sends nothing", async () => {
    let t = 0;
    let calls = 0;
    const r = await siteHardware(
      "s",
      {
        listDevices: async () => devices(3),
        audit: async (u) => (calls++, audit(u)),
        now: () => t,
        sleep: async (ms: number) => {
          t += ms + 2_000; // the timer fires late
        },
        pacer: new AuditPacer(),
      },
      { gapMs: 500, budgetMs: 2_000 }
    );
    expect(calls).toBe(1);
    expect(r.returned).toBe(1);
    expect(r.nextOffset).toBe(1);
  });

  it("never treats a listing cut short by a rate limit as the whole site, even after the backoff ends", async () => {
    let t = 0;
    const pacer = new AuditPacer();
    let audits = 0;
    const r = await siteHardware(
      "s",
      {
        listDevices: async () => {
          pacer.backOff(t + 1_000); // another call is rate-limited mid-listing: the listing is aborted
          t += 5_000; // the in-flight page answers after that backoff has ended
          return devices(1); // only the devices read before the abort
        },
        audit: async (u) => (audits++, audit(u)),
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
        pacer,
      },
      { offset: 0, budgetMs: 60_000 }
    );
    expect(audits).toBe(0);
    expect(r.returned).toBe(0);
    expect(r.nextOffset).toBe(0);
    expect(r.rateLimited?.message).toMatch(/interrupted the device listing/);
    expect(r.rateLimited?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("backs off the shared pacer for a rate limit reported by any tool, but not for a presumed block", () => {
    sharedAuditPacer.reset();
    resetRateLimitState();
    rateLimitDetails(new DattoIpBlockedError("/v2/device/x/patches", 300, true));
    expect(sharedAuditPacer.backoffSeconds(Date.now())).toBe(0);
    rateLimitDetails(new DattoRateLimitedError("/v2/device/x/patches", 20));
    expect(sharedAuditPacer.backoffSeconds(Date.now())).toBeGreaterThan(15);
    sharedAuditPacer.reset();
    resetRateLimitState();
  });

  it("paces device-list pages and audits together on the shared pacer", async () => {
    let t = 0;
    const starts: number[] = [];
    const pacer = new AuditPacer();
    const deps = {
      listDevices: async (_signal: AbortSignal, pace: () => Promise<void>) => {
        for (let page = 0; page < 3; page++) {
          await pace();
          starts.push(t);
        }
        return devices(2);
      },
      audit: async (u: string) => (starts.push(t), audit(u)),
      now: () => t,
      sleep: async (ms: number) => {
        const target = t + ms;
        await new Promise((r) => setTimeout(r, 0));
        t = Math.max(t, target);
      },
      pacer,
    };
    await Promise.all([siteHardware("s1", deps, { gapMs: 300 }), siteHardware("s2", deps, { gapMs: 300 })]);
    expect(starts).toHaveLength(10); // 2 x (3 pages + 2 audits)
    const sorted = [...starts].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(300);
  });

  it("does not start any audit when listing the devices outlasts the budget", async () => {
    let calls = 0;
    await expect(
      siteHardware(
        "s",
        { listDevices: () => new Promise(() => {}), audit: async (u) => (calls++, audit(u)), pacer: new AuditPacer() },
        { budgetMs: 50 }
      )
    ).rejects.toThrow(/took longer than the 1 s time budget/);
    expect(calls).toBe(0);
  });
});

describe("siteHardware", () => {
  it("returns manufacturer, model and serial, sorted by hostname", async () => {
    const c = clock();
    const r = await siteHardware("site-1", { listDevices: async () => devices(3), audit: async (u) => audit(u), ...c });
    expect(r.totalDevices).toBe(3);
    expect(r.devices.map((d) => d.hostname)).toEqual(["HOST-001", "HOST-002", "HOST-003"]);
    expect(r.devices[0]).toMatchObject({ manufacturer: "HP", model: "Model uid-2", serialNumber: "SN-uid-2", deviceType: "Laptop" });
    expect(r.nextOffset).toBeUndefined();
  });

  it("pages with max and offset", async () => {
    const c = clock();
    const deps = { listDevices: async () => devices(5), audit: async (u: string) => audit(u), ...c };
    const first = await siteHardware("s", deps, { max: 2 });
    expect(first.returned).toBe(2);
    expect(first.nextOffset).toBe(2);
    const second = await siteHardware("s", deps, { offset: first.nextOffset, max: 10 });
    expect(second.devices.map((d) => d.hostname)).toEqual(["HOST-003", "HOST-004", "HOST-005"]);
    expect(second.nextOffset).toBeUndefined();
  });

  it("caps max at the default page size", async () => {
    const c = clock();
    const r = await siteHardware(
      "s",
      { listDevices: async () => devices(DEFAULT_PAGE_SIZE + 20), audit: async (u) => audit(u), ...c },
      { max: 1000, budgetMs: 1e9 }
    );
    expect(r.returned).toBe(DEFAULT_PAGE_SIZE);
    expect(r.nextOffset).toBe(DEFAULT_PAGE_SIZE);
  });

  it("caps max at a configured page size, and lowers the default max to it", async () => {
    const c = clock();
    const deps = { listDevices: async () => devices(30), audit: async (u: string) => audit(u), ...c };
    expect((await siteHardware("s", deps, { max: 1000, pageSize: 10, budgetMs: 1e9 })).returned).toBe(10);
    expect((await siteHardware("s", deps, { pageSize: 5, budgetMs: 1e9 })).returned).toBe(5);
    // A page size above what Datto allows is clamped.
    const big = await siteHardware(
      "s",
      { listDevices: async () => devices(MAX_PAGE_SIZE + 5), audit: async (u) => audit(u), ...c },
      { max: 1000, pageSize: 10_000, budgetMs: 1e9 }
    );
    expect(big.returned).toBe(MAX_PAGE_SIZE);
  });

  it("paces the audits and stops at the time budget with nextOffset", async () => {
    const c = clock();
    let calls = 0;
    const r = await siteHardware(
      "s",
      { listDevices: async () => devices(10), audit: async (u) => (calls++, audit(u)), ...c },
      { gapMs: 500, budgetMs: 2000 }
    );
    expect(calls).toBe(4); // t=0, 500, 1000, 1500; the next would pass 2000
    expect(r.nextOffset).toBe(4);
    expect(r.notes?.join(" ")).toMatch(/time limit/);
  });

  it("stops at once on a rate limit and never retries", async () => {
    const c = clock();
    let calls = 0;
    const r = await siteHardware(
      "s",
      {
        listDevices: async () => devices(5),
        audit: async (u) => {
          calls++;
          if (calls === 2) throw new DattoRateLimitedError("/v2/audit/device", 30);
          return audit(u);
        },
        ...c,
      }
    );
    expect(calls).toBe(2);
    expect(r.returned).toBe(1);
    expect(r.nextOffset).toBe(1);
    expect(r.notes?.join(" ")).toMatch(/HTTP 429.*Try again in 30 s/);
    // Machine-readable, so the tool can return a rate-limit error with the partial rows.
    expect(r.rateLimited?.retryAfterSeconds).toBe(30);
    expect(r.rateLimited?.message).toMatch(/429/);
  });

  it("says so when the site has more devices than the list limit", async () => {
    const c = clock();
    const r = await siteHardware(
      "s",
      { listDevices: async () => devices(5), audit: async (u) => audit(u), ...c },
      { listLimit: 3 }
    );
    expect(r.totalDevices).toBe(3);
    expect(r.listTruncated).toBe(true);
    expect(r.notes?.join(" ")).toMatch(/more than 3 devices.*incomplete/);
    const full = await siteHardware("s", { listDevices: async () => devices(3), audit: async (u) => audit(u), ...c }, { listLimit: 3 });
    expect(full.listTruncated).toBeUndefined();
    expect(full.rateLimited).toBeUndefined();
  });

  it("reports other errors per device and carries on; notes devices with no manufacturer", async () => {
    const c = clock();
    const r = await siteHardware(
      "s",
      {
        listDevices: async () => devices(3),
        audit: async (u) => {
          if (u === "uid-1") throw new Error("audit not found");
          if (u === "uid-0") return { systemInfo: {} };
          return audit(u);
        },
        ...c,
      }
    );
    expect(r.returned).toBe(3);
    expect(r.devices.find((d) => d.deviceUid === "uid-1")?.error).toBe("audit not found");
    expect(r.devices.find((d) => d.deviceUid === "uid-0")?.manufacturer).toBeNull();
    expect(r.notes?.join(" ")).toMatch(/1 device\(s\) report no manufacturer/);
  });
});

describe("siteHardwareConfig", () => {
  it("uses the defaults when the variables are unset or empty", () => {
    expect(siteHardwareConfig({})).toEqual({ budgetMs: DEFAULT_BUDGET_MS, pageSize: DEFAULT_PAGE_SIZE, warnings: [] });
    expect(
      siteHardwareConfig({ DATTO_SITE_HARDWARE_BUDGET_MS: " ", DATTO_SITE_HARDWARE_PAGE_SIZE: "" })
    ).toEqual({ budgetMs: 20_000, pageSize: 100, warnings: [] });
  });

  it("reads valid values", () => {
    expect(
      siteHardwareConfig({ DATTO_SITE_HARDWARE_BUDGET_MS: "45000", DATTO_SITE_HARDWARE_PAGE_SIZE: " 25 " })
    ).toEqual({ budgetMs: 45_000, pageSize: 25, warnings: [] });
  });

  it("clamps out-of-range values and says so", () => {
    const low = siteHardwareConfig({ DATTO_SITE_HARDWARE_BUDGET_MS: "10", DATTO_SITE_HARDWARE_PAGE_SIZE: "0" });
    expect(low.budgetMs).toBe(MIN_BUDGET_MS);
    expect(low.pageSize).toBe(1);
    const high = siteHardwareConfig({ DATTO_SITE_HARDWARE_BUDGET_MS: "999999999", DATTO_SITE_HARDWARE_PAGE_SIZE: "1000" });
    expect(high.budgetMs).toBe(MAX_BUDGET_MS);
    expect(high.pageSize).toBe(MAX_PAGE_SIZE);
    expect(high.warnings.join(" ")).toMatch(/DATTO_SITE_HARDWARE_PAGE_SIZE=1000 is outside 1-250; using 250/);
  });

  it("ignores values that are not whole numbers and says so", () => {
    const r = siteHardwareConfig({ DATTO_SITE_HARDWARE_BUDGET_MS: "20s", DATTO_SITE_HARDWARE_PAGE_SIZE: "-5" });
    expect(r.budgetMs).toBe(DEFAULT_BUDGET_MS);
    expect(r.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/DATTO_SITE_HARDWARE_BUDGET_MS="20s" is not a whole number/);
  });
});

describe("hidden UDFs", () => {
  it("reads DATTO_HIDDEN_UDFS: numbers or udfN, commas or spaces, 1-300 only", () => {
    expect([...hiddenUdfKeys({ DATTO_HIDDEN_UDFS: "3, udf4 28;x 0 301" })].sort()).toEqual(["udf28", "udf3", "udf4"]);
    expect(hiddenUdfKeys({}).size).toBe(0);
  });

  it("hides listed UDFs that have a value, in a device and in a list, without changing the input", () => {
    const device = { hostname: "A", udf: { udf3: "KEY-1", udf4: null, udf5: "keep", udf28: "pw" } };
    const keys = hiddenUdfKeys({ DATTO_HIDDEN_UDFS: "3,4,28" });
    const one = redactUdfs(device, keys);
    expect(one.udf).toEqual({ udf3: HIDDEN, udf4: null, udf5: "keep", udf28: HIDDEN });
    expect(device.udf.udf3).toBe("KEY-1");
    const list = redactUdfs([device, { hostname: "B" }], keys);
    expect((list[0] as typeof device).udf.udf28).toBe(HIDDEN);
    expect(list[1]).toEqual({ hostname: "B" });
  });

  it("changes nothing when no UDFs are listed", () => {
    const device = { udf: { udf3: "KEY-1" } };
    expect(redactUdfs(device, new Set())).toBe(device);
  });
});
