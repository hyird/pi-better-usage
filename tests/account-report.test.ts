import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportSavedAccounts } from "../src/account-report.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MultiproviderService, SavedUsageAccount } from "../src/multiprovider.ts";
import type { FetchLike } from "../src/usage.ts";

it("reports every account with labels and Current, isolates credentials and failures", async () => {
  const accounts: SavedUsageAccount[] = [
    { id: "a", label: "work", providerId: "opencode-go", authKind: "api_key", active: true },
    { id: "b", label: "personal", providerId: "opencode-go", authKind: "api_key", active: false },
    { id: "c", label: "expired", providerId: "opencode-go", authKind: "api_key", active: false },
    { id: "d", label: "other", providerId: "unsupported", authKind: "api_key", active: false },
  ];
  const resolve = vi.fn(async (id: string) => {
    if (id === "c") throw new Error("secret-token-must-not-leak");
    return { accessToken: `key-${id}`, label: accounts.find((a) => a.id === id)!.label };
  });
  const service = { resolveAccountAuth: resolve } as unknown as MultiproviderService;
  const keys: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    keys.push(key);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ usage: { weekly: { percent: key.includes("key-a") ? 10 : 80 } } }),
    };
  };
  const ctx = {
    model: { provider: "opencode-go", id: "model" },
    modelRegistry: {
      getProviderAuth: () => {
        throw new Error("Must not read ambient credentials");
      },
    },
  } as unknown as ExtensionContext;
  const result = await reportSavedAccounts(ctx, service, accounts, DEFAULT_CONFIG, { fetchImpl });
  expect(result).toContain("work [Current]");
  expect(result).toContain("personal");
  expect(result).toContain("90% left");
  expect(result).toContain("20% left");
  expect(result).toContain("expired\nUsage unavailable");
  expect(result).toContain("not supported for this provider");
  expect(result).not.toContain("secret-token");
  expect(keys.sort()).toEqual(["Bearer key-a", "Bearer key-b"]);
});
