import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredApiKey, resolveUsageCredential } from "../src/credential.ts";
import type { MultiproviderService, MultiproviderServiceContext } from "../src/multiprovider.ts";

const tempDirs: string[] = [];

afterEach(() => {
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
      async () => {
        throw new Error("pool exploded");
      },
    ]) {
      const credential = await resolveUsageCredential(
        ctxWithRegistry({ getProviderAuth: async () => ({ auth: { apiKey: "registry-key" } }) }),
        { env: tempEnv(), service: () => service({ resolveActiveAccountAuth }) },
      );
      expect(credential).toMatchObject({ apiKey: "registry-key", source: "pi" });
    }
  });

  it("accepts either resolver shape from the registry", async () => {
    const shapes: [unknown, string][] = [
      [{ auth: { apiKey: "from-auth" } }, "from-auth"],
      [{ apiKey: "from-direct" }, "from-direct"],
      [{ headers: { Authorization: "Bearer from-header" } }, "from-header"],
      [{ auth: { headers: { Authorization: "bearer lower-case" } } }, "lower-case"],
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
    expect(readStoredApiKey(tempEnv({ "opencode-go": { type: "oauth", key: "k" } }))).toBeNull();
    expect(readStoredApiKey(tempEnv({ "opencode-go": { type: "api_key" } }))).toBeNull();
    expect(readStoredApiKey(tempEnv({ "opencode-go": "nope" }))).toBeNull();
    expect(readStoredApiKey(tempEnv({ other: { type: "api_key", key: "k" } }))).toBeNull();
    expect(readStoredApiKey(tempEnv(["nope"]))).toBeNull();
    expect(readStoredApiKey(tempEnv())).toBeNull();
  });
});
