import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredApiKey, resolveUsageCredential } from "../src/credential.ts";
import { accountLabel } from "../src/usage.ts";
import type { MultiproviderService, MultiproviderServiceContext } from "../src/multiprovider.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempEnv(authJson?: unknown): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-better-opencode-go-cred-"));
  tempDirs.push(dir);
  if (authJson !== undefined) {
    writeFileSync(join(dir, "auth.json"), JSON.stringify(authJson));
  }
  return { PI_CODING_AGENT_DIR: dir };
}

type RegistryShape = { getProviderAuth?: (provider: string) => Promise<unknown> };

function ctxWithRegistry(registry: RegistryShape | undefined): ExtensionContext {
  return {
    modelRegistry: registry,
    model: undefined,
    sessionManager: undefined,
  } as unknown as ExtensionContext;
}

function service(overrides: Partial<MultiproviderService> = {}): MultiproviderService {
  return {
    getActiveAccount: async () => undefined,
    resolveActiveAccountAuth: async () => undefined,
    onActiveAccountChanged: () => () => undefined,
    ...overrides,
  } as unknown as MultiproviderService;
}

describe("resolveUsageCredential", () => {
  it("prefers a pooled account over Pi's own credential", async () => {
    const credential = await resolveUsageCredential(
      ctxWithRegistry({ getProviderAuth: async () => ({ auth: { apiKey: "registry-key" } }) }),
      {
        env: tempEnv(),
        service: () =>
          service({
            resolveActiveAccountAuth: async () => ({ accessToken: "pooled-key", label: " zhong " }),
          }),
      },
    );
    expect(credential).toMatchObject({
      apiKey: "pooled-key",
      label: "zhong",
      source: "multilogin",
    });
  });

  it("uses a saved pooled email when the usage endpoint has none", async () => {
    const resolved = await resolveUsageCredential(ctxWithRegistry(undefined), {
      env: tempEnv(),
      service: () =>
        service({
          resolveActiveAccountAuth: async () => ({
            accessToken: "pooled-key",
            label: "work",
            email: "saved@example.com",
          }),
        }),
    });
    expect(resolved?.email).toBe("saved@example.com");
    expect(accountLabel(resolved!)).toBe("saved@example.com");
  });

  it("names an unlabelled pooled account", async () => {
    const credential = await resolveUsageCredential(ctxWithRegistry(undefined), {
      env: tempEnv(),
      service: () =>
        service({
          resolveActiveAccountAuth: async () => ({ accessToken: "pooled-key", label: "" }),
        }),
    });
    expect(credential?.label).toBe("pooled");
  });

  it("passes the session context through to the pool", async () => {
    const seen: MultiproviderServiceContext[] = [];
    const ctx = ctxWithRegistry(undefined);
    await resolveUsageCredential(ctx, {
      env: tempEnv(),
      service: () =>
        service({
          resolveActiveAccountAuth: async (_providerId, serviceCtx) => {
            seen.push(serviceCtx);
            return undefined;
          },
        }),
    });
    expect(seen).toEqual([ctx]);
  });

  it("falls back to Pi's credential when the pool has nothing", async () => {
    for (const resolveActiveAccountAuth of [
      async () => undefined,
      async () => ({ accessToken: "   ", label: "" }),
    ]) {
      const credential = await resolveUsageCredential(
        ctxWithRegistry({ getProviderAuth: async () => ({ auth: { apiKey: "registry-key" } }) }),
        { env: tempEnv(), service: () => service({ resolveActiveAccountAuth }) },
      );
      expect(credential).toMatchObject({ apiKey: "registry-key", source: "pi" });
    }
  });

  it("stops waiting for Pi's registry when the lookup is cancelled", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = ctxWithRegistry({
      getProviderAuth: async () => {
        entered();
        await gate;
        return { auth: { apiKey: "late-key" } };
      },
    });
    const controller = new AbortController();
    const pending = resolveUsageCredential(ctx, { env: tempEnv() }, controller.signal);
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

  it("does not borrow Pi's credential when an active pool slot returns no token", async () => {
    const registry = vi.fn(async () => ({ auth: { apiKey: "wrong-account" } }));
    for (const resolveActiveAccountAuth of [
      async () => undefined,
      async () => ({ accessToken: "   ", label: "work" }),
    ]) {
      const credential = await resolveUsageCredential(
        ctxWithRegistry({ getProviderAuth: registry }),
        {
          env: tempEnv(),
          service: () =>
            service({
              getActiveAccount: async () => ({
                id: "opencode-go/work",
                label: "work",
                authKind: "api_key",
              }),
              resolveActiveAccountAuth,
            }),
        },
      );
      expect(credential).toBeNull();
    }
    expect(registry).not.toHaveBeenCalled();
  });

  it("keeps Pi fallback for an older service's pi:default slot", async () => {
    const credential = await resolveUsageCredential(
      ctxWithRegistry({ getProviderAuth: async () => ({ auth: { apiKey: "registry-key" } }) }),
      {
        env: tempEnv(),
        service: () =>
          service({
            getActiveAccount: async () => ({ id: "pi:default", label: "Pi", authKind: "api_key" }),
          }),
      },
    );
    expect(credential).toMatchObject({ apiKey: "registry-key", source: "pi" });
  });

  it("does not borrow Pi's account when pooled authentication fails", async () => {
    const credential = await resolveUsageCredential(
      ctxWithRegistry({ getProviderAuth: async () => ({ auth: { apiKey: "wrong-account" } }) }),
      {
        env: tempEnv(),
        service: () =>
          service({
            resolveActiveAccountAuth: async () => {
              throw new Error("pool failed");
            },
          }),
      },
    );
    expect(credential).toBeNull();
  });

  it("accepts either resolver shape from the registry", async () => {
    const shapes: [unknown, string][] = [
      [{ auth: { apiKey: "from-auth" } }, "from-auth"],
      [{ apiKey: "from-direct" }, "from-direct"],
      [{ headers: { Authorization: "Bearer from-header" } }, "from-header"],
      [{ auth: { headers: { Authorization: "bearer lower-case" } } }, "lower-case"],
      [{ headers: { authorization: "Bearer lower-header" } }, "lower-header"],
      [{ headers: { AUTHORIZATION: "Bearer upper-header" } }, "upper-header"],
      [{ headers: new Headers({ authorization: "Bearer headers-object" }) }, "headers-object"],
    ];
    for (const [shape, expected] of shapes) {
      const credential = await resolveUsageCredential(
        ctxWithRegistry({ getProviderAuth: async () => shape }),
        { env: tempEnv() },
      );
      expect(credential?.apiKey).toBe(expected);
    }
  });

  it("keeps going when the registry is missing, empty or broken", async () => {
    const broken: (RegistryShape | undefined)[] = [
      undefined,
      {},
      { getProviderAuth: async () => undefined },
      { getProviderAuth: async () => ({}) },
      { getProviderAuth: async () => ({ auth: {} }) },
      {
        getProviderAuth: async () => {
          throw new Error("registry exploded");
        },
      },
    ];
    for (const registry of broken) {
      const credential = await resolveUsageCredential(ctxWithRegistry(registry), {
        env: tempEnv({ "opencode-go": { type: "api_key", key: "stored-key" } }),
      });
      expect(credential).toMatchObject({ apiKey: "stored-key", source: "authFile" });
    }
  });

  it("reads auth.json before the environment", async () => {
    const credential = await resolveUsageCredential(ctxWithRegistry(undefined), {
      env: {
        ...tempEnv({ "opencode-go": { type: "api_key", key: "stored-key" } }),
        OPENCODE_API_KEY: "env-key",
      },
    });
    expect(credential).toMatchObject({ apiKey: "stored-key", source: "authFile" });
  });

  it("does not replace an unresolved stored credential with another environment key", async () => {
    for (const entry of [
      { type: "api_key", key: "!read-secret" },
      { type: "api_key", key: "$STORED_KEY" },
      { type: "api_key", key: "prefix-${STORED_KEY}" },
      { type: "oauth", access: "stored-token" },
    ]) {
      const env = { ...tempEnv({ "opencode-go": entry }), OPENCODE_API_KEY: "different-account" };
      const credential = await resolveUsageCredential(
        ctxWithRegistry({
          getProviderAuth: async () => {
            throw new Error("unavailable");
          },
        }),
        { env },
      );
      expect(credential).toBeNull();
    }
  });

  it("uses Pi's resolved value for a stored template", async () => {
    const credential = await resolveUsageCredential(
      ctxWithRegistry({ getProviderAuth: async () => ({ auth: { apiKey: "resolved-key" } }) }),
      { env: tempEnv({ "opencode-go": { type: "api_key", key: "$STORED_KEY" } }) },
    );
    expect(credential).toMatchObject({ apiKey: "resolved-key", source: "pi" });
  });

  it("falls back to OPENCODE_API_KEY", async () => {
    const credential = await resolveUsageCredential(ctxWithRegistry(undefined), {
      env: { ...tempEnv(), OPENCODE_API_KEY: " env-key " },
    });
    expect(credential).toMatchObject({
      apiKey: "env-key",
      source: "env",
      label: "OPENCODE_API_KEY",
    });
  });

  it("returns null when nothing is configured", async () => {
    expect(await resolveUsageCredential(ctxWithRegistry(undefined), { env: tempEnv() })).toBeNull();
  });

  it("fingerprints the key without exposing it", async () => {
    const resolve = (apiKey: string) =>
      resolveUsageCredential(ctxWithRegistry({ getProviderAuth: async () => ({ apiKey }) }), {
        env: tempEnv(),
      });
    const first = await resolve("key-a");
    const again = await resolve("key-a");
    const other = await resolve("key-b");

    expect(first?.fingerprint).toBe(again?.fingerprint);
    expect(first?.fingerprint).not.toBe(other?.fingerprint);
    expect(first?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(first?.fingerprint).not.toContain("key-a");
  });
});

describe("readStoredApiKey", () => {
  it("accepts only a stored api_key entry", () => {
    expect(readStoredApiKey(tempEnv({ "opencode-go": { type: "api_key", key: "k" } }))).toBe("k");
    expect(readStoredApiKey(tempEnv({ "opencode-go": { type: "api_key", key: " k " } }))).toBe("k");
    expect(
      readStoredApiKey(tempEnv({ "opencode-go": { type: "api_key", key: "!read-secret" } })),
    ).toBeNull();
    expect(
      readStoredApiKey(tempEnv({ "opencode-go": { type: "api_key", key: "$STORED_KEY" } })),
    ).toBeNull();
    expect(readStoredApiKey(tempEnv({ "opencode-go": { type: "oauth", key: "k" } }))).toBeNull();
    expect(readStoredApiKey(tempEnv({ "opencode-go": { type: "api_key" } }))).toBeNull();
    expect(readStoredApiKey(tempEnv({ "opencode-go": "nope" }))).toBeNull();
    expect(readStoredApiKey(tempEnv({ other: { type: "api_key", key: "k" } }))).toBeNull();
    expect(readStoredApiKey(tempEnv(["nope"]))).toBeNull();
    expect(readStoredApiKey(tempEnv())).toBeNull();
  });
});
