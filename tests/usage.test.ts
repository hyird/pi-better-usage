import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type UsageConfig } from "../src/config.ts";
import type { UsageCredential } from "../src/credential.ts";
import {
  constrainingWindow,
  fetchUsage,
  formatClock,
  formatCountdown,
  formatDetail,
  formatStatusLine,
  leftPercent,
  parseUsagePayload,
  severityForLeftPercent,
  UsageError,
  usageSegments,
  type FetchLike,
  type UsageSnapshot,
} from "../src/usage.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");

function config(overrides: Partial<UsageConfig> = {}): UsageConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function snapshot(windows: UsageSnapshot["windows"], capturedAt = NOW): UsageSnapshot {
  return { capturedAt, windows };
}

const FULL = snapshot({
  rolling: { status: "ok", percentUsed: 3, resetsAt: NOW + 2 * 3_600_000 + 3 * 60_000 },
  weekly: { status: "ok", percentUsed: 12, resetsAt: NOW + 5 * 86_400_000 },
  monthly: { status: "ok", percentUsed: 95, resetsAt: NOW + 20 * 86_400_000 },
});

const CREDENTIAL: UsageCredential = {
  apiKey: "test-key",
  label: "zhong",
  source: "multilogin",
  fingerprint: "abc",
};

/* ----------------------------------------------------------------- parser -- */

describe("parseUsagePayload", () => {
  const payload = {
    usage: {
      rolling: { status: "ok", percent: 3, resetsAt: "2026-09-22T14:03:00.000Z" },
      weekly: { status: "ok", percent: 12, resetsAt: "2026-09-27T12:00:00.000Z" },
      monthly: { status: "ok", percent: 95, resetsAt: "2026-10-12T12:00:00.000Z" },
    },
  };

  it("reads the three windows", () => {
    const parsed = parseUsagePayload(payload, NOW);
    expect(parsed.capturedAt).toBe(NOW);
    expect(parsed.windows.rolling).toEqual({
      status: "ok",
      percentUsed: 3,
      resetsAt: Date.parse("2026-09-22T14:03:00.000Z"),
    });
    expect(parsed.windows.monthly?.percentUsed).toBe(95);
  });

  it("rejects a payload that is not an object", () => {
    for (const raw of [undefined, null, "nope", 42, []]) {
      expect(() => parseUsagePayload(raw, NOW)).toThrow(UsageError);
    }
  });

  it("rejects a payload without a usage object", () => {
    expect(() => parseUsagePayload({}, NOW)).toThrow(/no usage object/);
    expect(() => parseUsagePayload({ usage: [] }, NOW)).toThrow(/no usage object/);
  });

  it("rejects a payload with no usable window", () => {
    expect(() => parseUsagePayload({ usage: {} }, NOW)).toThrow(/no usable window/);
    expect(() => parseUsagePayload({ usage: { rolling: { percent: "3" } } }, NOW)).toThrow(
      /no usable window/,
    );
  });

  it("ignores unknown windows and unusable entries", () => {
    const parsed = parseUsagePayload(
      { usage: { hourly: { percent: 50 }, weekly: { percent: 1 }, rolling: null } },
      NOW,
    );
    expect(Object.keys(parsed.windows)).toEqual(["weekly"]);
  });

  it("clamps a percentage the endpoint should not send", () => {
    expect(
      parseUsagePayload({ usage: { weekly: { percent: -10 } } }, NOW).windows.weekly?.percentUsed,
    ).toBe(0);
    expect(
      parseUsagePayload({ usage: { weekly: { percent: 300 } } }, NOW).windows.weekly?.percentUsed,
    ).toBe(100);
  });

  it("falls back to ok for an unusable status", () => {
    expect(
      parseUsagePayload({ usage: { weekly: { percent: 1, status: "  " } } }, NOW).windows.weekly
        ?.status,
    ).toBe("ok");
    expect(
      parseUsagePayload({ usage: { weekly: { percent: 1, status: 7 } } }, NOW).windows.weekly
        ?.status,
    ).toBe("ok");
    // Non-ASCII would break the single-line widget; treat it as ok.
    expect(
      parseUsagePayload({ usage: { weekly: { percent: 1, status: "okä" } } }, NOW).windows.weekly
        ?.status,
    ).toBe("ok");
  });

  it("keeps a real non-ok status", () => {
    expect(
      parseUsagePayload({ usage: { weekly: { percent: 100, status: "exhausted" } } }, NOW).windows
        .weekly?.status,
    ).toBe("exhausted");
  });

  it("drops a reset instant that cannot be rendered", () => {
    const cases = ["not a date", "", "x".repeat(80), "1970-01-01T00:00:00.000Z"];
    for (const resetsAt of cases) {
      expect(
        parseUsagePayload({ usage: { weekly: { percent: 1, resetsAt } } }, NOW).windows.weekly
          ?.resetsAt,
      ).toBe(null);
    }
    expect(
      parseUsagePayload({ usage: { weekly: { percent: 1, resetsAt: 42 } } }, NOW).windows.weekly
        ?.resetsAt,
    ).toBe(null);
  });
});

/* ------------------------------------------------------------------ fetch -- */

function credential(): UsageCredential {
  return { apiKey: "secret", label: "pi", source: "pi", fingerprint: "f" };
}

function respond(init: {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  json?: () => Promise<unknown>;
}): FetchLike {
  return async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: {
      get: (name: string) => (name === "content-length" ? (init.contentLength ?? null) : null),
    },
    json: init.json ?? (async () => ({ usage: { weekly: { percent: 1 } } })),
  });
}

describe("fetchUsage", () => {
  it("sends the bearer token to the official endpoint", async () => {
    let seen: { url: string; headers?: Record<string, string> } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, headers: init?.headers };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ usage: { weekly: { percent: 1 } } }),
      };
    };
    const parsed = await fetchUsage(credential(), { fetchImpl, now: NOW });
    expect(seen?.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(seen?.headers?.Authorization).toBe("Bearer secret");
    expect(parsed.windows.weekly?.percentUsed).toBe(1);
  });

  it("explains a rejected key", async () => {
    for (const status of [401, 403]) {
      await expect(
        fetchUsage(credential(), { fetchImpl: respond({ ok: false, status }) }),
      ).rejects.toMatchObject({ kind: "auth", status });
    }
  });

  it("names rate limiting and other failures", async () => {
    await expect(
      fetchUsage(credential(), { fetchImpl: respond({ ok: false, status: 429 }) }),
    ).rejects.toMatchObject({ kind: "http", status: 429 });
    await expect(
      fetchUsage(credential(), { fetchImpl: respond({ ok: false, status: 500 }) }),
    ).rejects.toMatchObject({ kind: "http", status: 500 });
  });

  it("reports a transport failure", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("socket hang up");
    };
    await expect(fetchUsage(credential(), { fetchImpl })).rejects.toMatchObject({
      kind: "transport",
    });
  });

  it("rejects an oversized response before reading it", async () => {
    await expect(
      fetchUsage(credential(), { fetchImpl: respond({ contentLength: String(5_000_000) }) }),
    ).rejects.toMatchObject({ kind: "oversize" });
  });

  it("reports an invalid body", async () => {
    await expect(
      fetchUsage(credential(), {
        fetchImpl: respond({
          json: async () => {
            throw new Error("bad json");
          },
        }),
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

/* ------------------------------------------------------------ formatting :: -- */

describe("formatCountdown", () => {
  it("picks the largest useful unit", () => {
    expect(formatCountdown(20 * 86_400_000)).toBe("20d0h");
    expect(formatCountdown(2 * 3_600_000 + 3 * 60_000)).toBe("2h3m");
    expect(formatCountdown(90_000)).toBe("1m");
    expect(formatCountdown(5_000)).toBe("5s");
    expect(formatCountdown(-1)).toBe("0s");
  });
});

describe("formatClock", () => {
  it("uses a numeric date and 24-hour clock on the current day", () => {
    expect(formatClock(NOW + 3 * 60_000, NOW)).toBe("9/22 12:03");
  });

  it("uses the same date and clock format on another day", () => {
    expect(formatClock(NOW + 20 * 86_400_000, NOW)).toBe("10/12 12:00");
  });
});

describe("constrainingWindow", () => {
  it("picks the window closest to its limit", () => {
    expect(constrainingWindow(FULL, DEFAULT_CONFIG.windows)?.key).toBe("monthly");
    expect(constrainingWindow(FULL, ["rolling"])?.key).toBe("rolling");
    expect(constrainingWindow(snapshot({}), DEFAULT_CONFIG.windows)).toBeUndefined();
  });
});

describe("severity", () => {
  it("maps what is left onto the grok thresholds", () => {
    expect(leftPercent(3)).toBe(97);
    expect(leftPercent(120)).toBe(0);
    expect(severityForLeftPercent(100)).toBe("ok");
    expect(severityForLeftPercent(31)).toBe("ok");
    expect(severityForLeftPercent(30)).toBe("warning");
    expect(severityForLeftPercent(11)).toBe("warning");
    expect(severityForLeftPercent(10)).toBe("critical");
    expect(severityForLeftPercent(0)).toBe("critical");
  });
});

describe("usageSegments", () => {
  const segments = usageSegments(FULL, config(), "zhong", NOW);

  it("renders one coloured percentage per window, grok-style", () => {
    expect(segments).toEqual([
      { text: "Usage: ", severity: "muted" },
      { text: "5h ", severity: "muted" },
      { text: "97%", severity: "ok" },
      { text: " left", severity: "muted" },
      { text: " · ", severity: "muted" },
      { text: "wk ", severity: "muted" },
      { text: "88%", severity: "ok" },
      { text: " left", severity: "muted" },
      { text: " · ", severity: "muted" },
      { text: "mo ", severity: "muted" },
      { text: "5%", severity: "critical" },
      { text: " left", severity: "muted" },
      { text: " · ↺ 20d0h - 10/12 12:00", severity: "muted" },
      { text: " · zhong", severity: "muted" },
    ]);
  });

  it("flattens to the agreed line", () => {
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "Usage: 5h 97% left · wk 88% left · mo 5% left · ↺ 20d0h - 10/12 12:00 · zhong",
    );
  });

  it("paints each window on its own severity", () => {
    const one = (percentUsed: number) =>
      usageSegments(
        snapshot({ weekly: { status: "ok", percentUsed, resetsAt: null } }),
        config({ windows: ["weekly"] }),
        undefined,
        NOW,
      ).find((segment) => segment.text.endsWith("%"))?.severity;
    expect([one(0), one(69), one(70), one(89), one(90)]).toEqual([
      "ok",
      "ok",
      "warning",
      "warning",
      "critical",
    ]);
  });

  it("omits the reset clock when the endpoint gives none", () => {
    expect(
      formatStatusLine(
        snapshot({ weekly: { status: "ok", percentUsed: 1, resetsAt: null } }),
        config({ windows: ["weekly"] }),
      ),
    ).toBe("Usage: wk 99% left");
  });

  it("can hide the account label", () => {
    expect(formatStatusLine(FULL, config({ showAccountLabel: false }), "zhong", NOW)).toBe(
      "Usage: 5h 97% left · wk 88% left · mo 5% left · ↺ 20d0h - 10/12 12:00",
    );
  });

  it("skips a window the endpoint did not report", () => {
    expect(
      formatStatusLine(
        snapshot({ weekly: { status: "ok", percentUsed: 0, resetsAt: null } }),
        config(),
        "zhong",
      ),
    ).toBe("Usage: wk 100% left · zhong");
  });

  it("hides the whole line when no window is displayable", () => {
    expect(formatStatusLine(snapshot({}), config())).toBeUndefined();
    expect(usageSegments(snapshot({}), config())).toEqual([]);
  });

  it("surfaces a non-ok window status", () => {
    expect(
      formatStatusLine(
        snapshot({ rolling: { status: "exhausted", percentUsed: 100, resetsAt: null } }),
        config({ windows: ["rolling"] }),
      ),
    ).toBe("Usage: 5h 0% left !exhausted");
  });

  it("sanitizes the account label on the way in", () => {
    expect(formatStatusLine(FULL, config(), "zh\nong", NOW)).toContain(" · zh ong");
  });
});

describe("formatDetail", () => {
  it("reports used and left per window", () => {
    const detail = formatDetail(FULL, config(), CREDENTIAL, NOW);
    expect(detail).toContain("account: zhong");
    expect(detail).toContain(
      "5h rolling: [███████████████████░] 97% left · 3% used\n  Resets: 9/22 14:03 · in 2h3m",
    );
    expect(detail).toContain(
      "month: [█░░░░░░░░░░░░░░░░░░░] 5% left · 95% used\n  Resets: 10/12 12:00 · in 20d0h",
    );
  });

  it("omits the reset time when there is none", () => {
    const detail = formatDetail(
      snapshot({ weekly: { status: "ok", percentUsed: 1, resetsAt: null } }),
      config({ windows: ["weekly"] }),
      CREDENTIAL,
      NOW,
    );
    expect(detail).toContain("week: [████████████████████] 99% left · 1% used\n");
  });

  it("surfaces a non-ok status", () => {
    const detail = formatDetail(
      snapshot({ weekly: { status: "exhausted", percentUsed: 100, resetsAt: null } }),
      config({ windows: ["weekly"] }),
      CREDENTIAL,
      NOW,
    );
    expect(detail).toContain("week: [░░░░░░░░░░░░░░░░░░░░] 0% left · 100% used · exhausted");
  });
});
