import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportSavedAccounts } from "../src/account-report.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { MultiproviderService, SavedUsageAccount } from "../src/multiprovider.ts";
import type { FetchLike } from "../src/http.ts";

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
  expect(result).toContain("OpenCode Go usage · work [Current] · API key");
  expect(result).toContain("personal");
  expect(result).toContain("90% left");
  expect(result).toContain("20% left");
  expect(result).toContain("OpenCode Go usage · expired · API key\nUsage unavailable");
  expect(result).toContain("not supported for this provider");
  expect(result).not.toContain("secret-token");
  expect(keys.sort()).toEqual(["Bearer key-a", "Bearer key-b"]);
});

it("identifies providers and credential types when account labels are identical", async () => {
  const accounts: SavedUsageAccount[] = [
    {
      id: "opencode-go/hyird",
      label: "hyird",
      providerId: "opencode-go",
      authKind: "api_key",
      active: true,
    },
    { id: "xai/hyird", label: "hyird", providerId: "xai", authKind: "oauth", active: true },
  ];
  const service = {
    resolveAccountAuth: async () => {
      throw new Error("fixture failure");
    },
  } as unknown as MultiproviderService;
  const ctx = {
    model: { provider: "opencode-go", id: "model" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const result = await reportSavedAccounts(ctx, service, accounts, DEFAULT_CONFIG);
  expect(result).toContain("OpenCode Go usage · hyird [Current] · API key\nUsage unavailable");
  expect(result).toContain("Grok usage · hyird [Current] · Subscription\nUsage unavailable");
});

it("reports a connection failure without suggesting the account must sign in", async () => {
  const account: SavedUsageAccount = {
    id: "opencode-go/current",
    label: "current",
    providerId: "opencode-go",
    authKind: "api_key",
    active: true,
  };
  const service = {
    resolveAccountAuth: async () => ({ accessToken: "fixture-key", label: "current" }),
  } as unknown as MultiproviderService;
  const ctx = {
    model: { provider: "opencode-go", id: "model" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const result = await reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, {
    fetchImpl: async () => {
      throw new Error("secret connection detail");
    },
  });
  expect(result).toContain("Usage unavailable. OpenCode Go usage request failed or timed out.");
  expect(result).not.toContain("sign in again");
  expect(result).not.toContain("secret connection detail");
});

it("stops waiting for a final account roster read when the report is cancelled", async () => {
  const account: SavedUsageAccount = {
    id: "unsupported/work",
    label: "work",
    providerId: "unsupported",
    authKind: "api_key",
    active: false,
  };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = {
    listAccounts: async () => {
      entered();
      await gate;
      return [account];
    },
  } as unknown as MultiproviderService;
  const ctx = {
    model: { provider: "unsupported", id: "model" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  const pending = reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, {
    signal: controller.signal,
  });
  try {
    await started;
    controller.abort();
    expect(
      await Promise.race([
        pending.then(
          () => "resolved",
          () => "cancelled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 200)),
      ]),
    ).toBe("cancelled");
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
});

it("does not query or display an account removed after the report started", async () => {
  const account: SavedUsageAccount = {
    id: "openai-codex/removed",
    label: "removed",
    providerId: "openai-codex",
    authKind: "oauth",
    active: true,
  };
  const fetchImpl = vi.fn() as unknown as FetchLike;
  const service = {
    listAccounts: async () => [],
    resolveAccountAuth: async () => {
      throw new Error("Account not found");
    },
  } as unknown as MultiproviderService;
  const ctx = {
    model: { provider: "openai-codex", id: "test" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  expect(await reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, { fetchImpl })).toBe(
    "",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("does not display an old quota after the same account ID receives a new credential", async () => {
  const account: SavedUsageAccount = {
    id: "opencode-go/work",
    label: "work",
    providerId: "opencode-go",
    authKind: "api_key",
    active: true,
    credentialRevision: "old-revision",
  };
  let revision = account.credentialRevision;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = {
    listAccounts: async () => [{ ...account, credentialRevision: revision }],
    resolveAccountAuth: async () => ({ accessToken: "old-key", label: "work" }),
  } as unknown as MultiproviderService;
  const ctx = {
    model: { provider: "opencode-go", id: "test" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const onVerifiedRoster = vi.fn();
  const pending = reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, {
    onVerifiedRoster,
    fetchImpl: async () => {
      started();
      await paused;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ usage: { weekly: { percent: 10 } } }),
      };
    },
  });
  await entered;
  revision = "new-revision";
  finish();
  expect(await pending).toBe("");
  expect(onVerifiedRoster).not.toHaveBeenCalled();
});

it.each([{ label: "renamed" }, { email: "new@example.com" }, { providerId: "xai" }])(
  "omits a report row when the same account ID changes display identity during lookup: %j",
  async (change) => {
    const account: SavedUsageAccount = {
      id: "opencode-go/work",
      label: "work",
      email: "old@example.com",
      providerId: "opencode-go",
      authKind: "api_key",
      active: true,
      credentialRevision: "same-revision",
    };
    let current: SavedUsageAccount = { ...account };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = {
      listAccounts: async () => [current],
      resolveAccountAuth: async () => ({ accessToken: "same-key", label: "work" }),
    } as unknown as MultiproviderService;
    const ctx = {
      model: { provider: "opencode-go", id: "test" },
      modelRegistry: {},
    } as unknown as ExtensionContext;
    const verified = vi.fn();
    const pending = reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, {
      onVerifiedRoster: verified,
      fetchImpl: async () => {
        entered();
        await gate;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ usage: { weekly: { percent: 10 } } }),
        };
      },
    });
    await started;
    current = { ...account, ...change };
    release();
    expect(await pending).toBe("");
    expect(verified).not.toHaveBeenCalled();
  },
);

it.each(["openai", "openai-codex"])(
  "shows an inactive %s OAuth account after its own authentication refreshes the credential",
  async (providerId) => {
    const account: SavedUsageAccount = {
      id: `${providerId}/work`,
      label: "work",
      providerId,
      authKind: "oauth",
      active: false,
      credentialRevision: "expired-token",
    };
    const access = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.s`;
    const service = {
      listAccounts: async () => [{ ...account, credentialRevision: "refreshed-token" }],
      resolveAccountAuth: async () => ({
        accessToken: access,
        label: "work",
        credentialRevision: "refreshed-token",
      }),
    } as unknown as MultiproviderService;
    const ctx = {
      model: { provider: providerId, id: "test" },
      modelRegistry: {},
    } as unknown as ExtensionContext;
    const onVerifiedRoster = vi.fn();
    const result = await reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, {
      onVerifiedRoster,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ rate_limit: { primary_window: { used_percent: 25 } } }),
      }),
    });
    expect(result).toContain("OpenAI Codex usage · work · Subscription");
    expect(result).toContain("75% left");
    const refreshed = [{ ...account, credentialRevision: "refreshed-token" }];
    expect(onVerifiedRoster).toHaveBeenCalledWith(refreshed, refreshed);
  },
);

it("keeps the usage report when a final account-list refresh is briefly unavailable", async () => {
  const account: SavedUsageAccount = {
    id: "opencode-go/current",
    label: "current",
    providerId: "opencode-go",
    authKind: "api_key",
    active: true,
  };
  const service = {
    listAccounts: async () => {
      throw new Error("Storage is temporarily locked");
    },
    resolveAccountAuth: async () => ({ accessToken: "fixture-key", label: "current" }),
  } as unknown as MultiproviderService;
  const ctx = {
    model: { provider: "opencode-go", id: "model" },
    modelRegistry: {},
  } as unknown as ExtensionContext;
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ usage: { weekly: { percent: 10 } } }),
  });
  expect(
    await reportSavedAccounts(ctx, service, [account], DEFAULT_CONFIG, { fetchImpl }),
  ).toContain("current [Current]");
});
