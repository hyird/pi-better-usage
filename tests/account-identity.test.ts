import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountEmail, emailFromToken } from "../src/account-identity.ts";
import { reportSavedAccounts } from "../src/account-report.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { UsageCredential } from "../src/credential.ts";
import type { MultiproviderService, SavedUsageAccount } from "../src/multiprovider.ts";
import { fetchGrokUsage, GROK_USER_URL, parseOpenAIUsage } from "../src/providers.ts";
import { accountLabel, formatDetail, usageSegments, type FetchLike } from "../src/usage.ts";

const credential: UsageCredential = {
  apiKey: "fixture",
  label: "default-2",
  source: "multilogin",
  fingerprint: "fixture",
};
const snapshot = {
  capturedAt: 0,
  windows: { weekly: { percentUsed: 10, status: "ok", resetsAt: null } },
};

it("prefers response email, then token email, then the saved label", () => {
  const identity = { ...credential, email: "token@example.com" };
  const reading = { ...snapshot, accountEmail: "server@example.com" };
  expect(accountLabel(identity, reading)).toBe("server@example.com");
  expect(accountLabel(identity, snapshot)).toBe("token@example.com");
  expect(accountLabel(credential, snapshot)).toBe("default-2");
  expect(formatDetail(reading, DEFAULT_CONFIG, identity)).toContain("server@example.com");
  const footer = usageSegments(
    reading,
    { ...DEFAULT_CONFIG, showAccountLabel: true },
    accountLabel(identity, reading),
  )
    .map((s) => s.text)
    .join("");
  expect(footer).toContain("server@example.com");
  expect(footer).not.toContain("default-2");
});

it("reads display email from OAuth claims and rejects missing or unsafe values", () => {
  const jwt = (payload: unknown) =>
    `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
  expect(
    emailFromToken(jwt({ "https://api.openai.com/profile": { email: "alice@example.com" } })),
  ).toBe("alice@example.com");
  expect(emailFromToken(jwt({ email: "grok@example.com" }))).toBe("grok@example.com");
  expect(emailFromToken("opaque-token")).toBeUndefined();
  for (const value of [null, {}, "not-an-email", "x\u001b[31m@example.com", "x\u202e@example.com"])
    expect(accountEmail(value)).toBeUndefined();
});

it("uses email from existing provider responses without additional requests", async () => {
  expect(
    parseOpenAIUsage({
      email: "codex@example.com",
      rate_limit: { primary_window: { used_percent: 10 } },
    }).accountEmail,
  ).toBe("codex@example.com");
  let calls = 0;
  const fetchImpl: FetchLike = async (url) => {
    calls++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        url === GROK_USER_URL
          ? { userId: "fixture-user", email: "grok@example.com" }
          : { config: { creditUsagePercent: 10 } },
    };
  };
  expect((await fetchGrokUsage(credential, { fetchImpl })).accountEmail).toBe("grok@example.com");
  expect(calls).toBe(2);
});

it("keeps accounts separate when server emails match and falls back when missing", async () => {
  const updateAccountEmail = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new Error("temporary storage failure"));
  const accounts: SavedUsageAccount[] = ["a", "b", "c"].map((id, i) => ({
    id,
    label: `default-${i + 1}`,
    providerId: "opencode-go",
    authKind: "api_key",
    active: i === 0,
  }));
  const service = {
    updateAccountEmail,
    resolveAccountAuth: async (id: string) => ({
      accessToken: id,
      label: accounts.find((a) => a.id === id)!.label,
    }),
  } as unknown as MultiproviderService;
  const fetchImpl: FetchLike = async (_url, init) => {
    const key = new Headers(init?.headers).get("authorization");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        email: key === "Bearer c" ? undefined : "same@example.com",
        usage: { weekly: { percent: key === "Bearer a" ? 10 : 70 } },
      }),
    };
  };
  const ctx = {
    model: { provider: "opencode-go", id: "fixture" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const result = await reportSavedAccounts(ctx, service, accounts, DEFAULT_CONFIG, { fetchImpl });
  expect(result.match(/same@example.com/g)).toHaveLength(2);
  expect(result).toContain("same@example.com [Current]");
  expect(result).not.toContain("default-1");
  expect(result).not.toContain("default-2");
  expect(result).toContain("default-3");
  expect(result).toContain("90% left");
  expect(result).toContain("30% left");
  expect(updateAccountEmail).toHaveBeenCalledTimes(2);
  expect(updateAccountEmail).toHaveBeenCalledWith("a", "same@example.com", "a");
  expect(updateAccountEmail).toHaveBeenCalledWith("b", "same@example.com", "b");
  expect(result).not.toContain("Usage unavailable");
});
