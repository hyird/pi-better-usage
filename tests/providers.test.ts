import { describe, expect, it, vi } from "vitest";
import {
  fetchGrokUsage,
  fetchOpenAIUsage,
  GROK_USAGE_URL,
  GROK_USER_URL,
  OPENAI_USAGE_URL,
  parseGrokUsage,
  parseOpenAIUsage,
} from "../src/providers.ts";
import type { UsageCredential } from "../src/credential.ts";
import type { FetchLike } from "../src/usage.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const credential: UsageCredential = {
  apiKey: "secret-token",
  accountId: "test-account",
  label: "test",
  source: "pi",
  fingerprint: "test",
};
const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});
const codex = {
  rate_limit: {
    primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_after_seconds: 120 },
    secondary_window: {
      used_percent: 72,
      limit_window_seconds: 604800,
      reset_at: NOW / 1000 + 86400,
    },
  },
};
const grok = {
  config: {
    creditUsagePercent: 37,
    isUnifiedBillingUser: true,
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-27T12:00:00Z" },
  },
};

describe("subscription payloads", () => {
  it("parses Codex windows, preserving reset instants", () => {
    const result = parseOpenAIUsage(codex, NOW);
    expect(result.windows.rolling).toMatchObject({ percentUsed: 23, resetsAt: NOW + 120000 });
    expect(result.windows.weekly).toMatchObject({ percentUsed: 72, resetsAt: NOW + 86400_000 });
  });
  it("recognizes a weekly-only primary window", () => {
    const result = parseOpenAIUsage(
      { rate_limit: { primary_window: codex.rate_limit.secondary_window } },
      NOW,
    );
    expect(result.windows.rolling).toBeUndefined();
    expect(result.windows.weekly?.percentUsed).toBe(72);
  });
  it("uses the separate Spark quota and rejects a missing Spark bucket", () => {
    const data = {
      ...codex,
      additional_rate_limits: [
        { limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 90 } } },
      ],
    };
    expect(parseOpenAIUsage(data, NOW, "gpt-5.3-codex-spark").windows.rolling?.percentUsed).toBe(
      90,
    );
    expect(() => parseOpenAIUsage(codex, NOW, "gpt-5.3-codex-spark")).toThrow("no usable window");
  });
  it("surfaces a blocked Codex bucket even with a non-exhausted percentage", () => {
    expect(
      parseOpenAIUsage({ rate_limit: { ...codex.rate_limit, allowed: false } }, NOW).windows.rolling
        ?.status,
    ).toBe("limited");
  });
  it.each([
    null,
    {},
    { rate_limit: { primary_window: { used_percent: "0" } } },
    { rate_limit: { primary_window: { used_percent: -1 } } },
  ])("does not invent Codex quota from %j", (data) => {
    expect(() => parseOpenAIUsage(data, NOW)).toThrow();
  });
  it("reads Grok's unified weekly percentage", () => {
    expect(parseGrokUsage(grok, NOW).windows.weekly).toEqual({
      percentUsed: 37,
      status: "ok",
      resetsAt: Date.parse("2026-09-27T12:00:00Z"),
    });
  });
  it("derives legacy monthly usage only when a positive limit exists", () => {
    const config = {
      used: { val: 250 },
      monthlyLimit: { val: 1000 },
      billingPeriodEnd: "2026-10-01T00:00:00Z",
    };
    expect(parseGrokUsage({ config }, NOW).windows.monthly?.percentUsed).toBe(25);
    expect(() =>
      parseGrokUsage({ config: { ...config, isUnifiedBillingUser: true } }, NOW),
    ).toThrow();
    expect(() =>
      parseGrokUsage({ config: { ...config, monthlyLimit: { val: 0 } } }, NOW),
    ).toThrow();
  });
  it("labels unknown Grok periods without calling them 5h windows", () => {
    expect(parseGrokUsage({ config: { creditUsagePercent: 0 } }, NOW).windows.rolling?.label).toBe(
      "period",
    );
  });
  it.each([
    {},
    { config: {} },
    { config: { creditUsagePercent: null } },
    { config: { creditUsagePercent: 101 } },
  ])("rejects unknown Grok usage %j", (data) => {
    expect(() => parseGrokUsage(data, NOW)).toThrow();
  });
});

describe("subscription requests", () => {
  it("sends Codex auth only to its fixed endpoint", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(ok(codex));
    await fetchOpenAIUsage(credential, { fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledWith(
      OPENAI_USAGE_URL,
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "chatgpt-account-id": "test-account",
        }),
      }),
    );
  });
  it("verifies Grok identity before billing and supplies the required headers", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(ok({ userId: "test-user" }))
      .mockResolvedValueOnce(ok(grok));
    await fetchGrokUsage(credential, { fetchImpl, now: NOW });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([GROK_USER_URL, GROK_USAGE_URL]);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-userid": "test-user",
      "X-XAI-Token-Auth": "xai-grok-cli",
    });
  });
  it("does not request Grok billing with invalid identity", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(ok({ userId: "unsafe\r\nheader" }));
    await expect(fetchGrokUsage(credential, { fetchImpl })).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 500])(
    "reports HTTP %i without rendering server bodies",
    async (status) => {
      const json = vi.fn().mockResolvedValue({ error: "secret-token" });
      const fetchImpl: FetchLike = async () => ({ ...ok({}), ok: false, status, json });
      await expect(fetchOpenAIUsage(credential, { fetchImpl })).rejects.toMatchObject({
        kind: status === 401 || status === 403 ? "auth" : "http",
        status,
      });
      expect(json).not.toHaveBeenCalled();
    },
  );
  it("does not leak tokens from transport errors", async () => {
    await expect(
      fetchOpenAIUsage(credential, {
        fetchImpl: async () => {
          throw new Error("secret-token");
        },
      }),
    ).rejects.toThrow("Check your connection");
  });
  it("retries only the failed Grok request", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url === GROK_USAGE_URL && urls.length === 2)
        throw new Error("temporary connection failure");
      return ok(
        url === GROK_USER_URL
          ? { userId: "test-user" }
          : { config: { creditUsagePercent: 10, currentPeriod: { type: "WEEK" } } },
      );
    };
    const snapshot = await fetchGrokUsage(credential, { fetchImpl });
    expect(snapshot.windows.weekly?.percentUsed).toBe(10);
    expect(urls).toEqual([GROK_USER_URL, GROK_USAGE_URL, GROK_USAGE_URL]);
  });
  it("rejects oversized responses before parsing", async () => {
    const json = vi.fn();
    await expect(
      fetchOpenAIUsage(credential, {
        fetchImpl: async () => ({ ...ok({}), headers: { get: () => "9999999" }, json }),
      }),
    ).rejects.toMatchObject({ kind: "oversize" });
    expect(json).not.toHaveBeenCalled();
  });
  it("passes cancellation into the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("aborted");
    });
    await expect(
      fetchOpenAIUsage(credential, { fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "transport" });
  });
});
