import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { API_KEY_ENV_VAR, PROVIDER_ID } from "./identity.ts";
import { piAgentDir } from "./paths.ts";
import type { MultiproviderService, MultiproviderServiceContext } from "./multiprovider.ts";

export type UsageCredentialSource = "multilogin" | "pi" | "authFile" | "env";

export type UsageCredential = {
  apiKey: string;
  accountId?: string;
  /** Pooled account label, or the credential source for Pi's own key. */
  label: string;
  source: UsageCredentialSource;
  /** Stable non-secret identity, used to detect account switches. */
  fingerprint: string;
};

function fingerprintOf(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function tokenFromAuthObject(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { apiKey?: unknown; headers?: Record<string, string> };
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) return payload.apiKey.trim();
  const authorization =
    typeof payload.headers?.Authorization === "string" ? payload.headers.Authorization : "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice("bearer ".length).trim() || null;
}

/**
 * Reads an API key from either resolver shape: `getProviderAuth` returns an
 * `AuthResult` (`{ auth: { apiKey } }`) while request-level resolution returns the
 * credential directly (`{ apiKey }` or bearer `headers`).
 */
export function extractApiKey(authLike: unknown): string | null {
  const direct = tokenFromAuthObject(authLike);
  if (direct) return direct;
  if (!authLike || typeof authLike !== "object") return null;
  // An empty `auth` object means "no ambient credential", not a failure.
  return tokenFromAuthObject((authLike as { auth?: unknown }).auth);
}

/** Pi stores API-key credentials as `{ type: "api_key", key }`. */
export function readStoredApiKey(
  env: NodeJS.ProcessEnv = process.env,
  providerId = PROVIDER_ID,
): string | null {
  try {
    const data = JSON.parse(readFileSync(`${piAgentDir(env)}/auth.json`, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const entry = (data as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object") return null;
    const record = entry as { type?: unknown; key?: unknown };
    if (record.type !== "api_key") return null;
    return typeof record.key === "string" && record.key.trim() ? record.key.trim() : null;
  } catch {
    return null;
  }
}

async function resolveRegistryApiKey(ctx: ExtensionContext): Promise<string | null> {
  const registry = ctx?.modelRegistry as unknown as {
    getProviderAuth?: (provider: string) => Promise<unknown>;
  };
  if (typeof registry?.getProviderAuth !== "function") return null;
  try {
    return extractApiKey(await registry.getProviderAuth(PROVIDER_ID));
  } catch {
    return null;
  }
}

export type CredentialResolver = {
  service?: () => MultiproviderService | undefined;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolves the API key to query usage with.
 *
 * A pooled account pinned to this session wins over Pi's own credential because
 * subscription usage is per account. `resolveActiveAccountAuth` returns undefined
 * when the pool's active entry is Pi's own upstream credential (`pi:default`), so
 * an empty result is not an error — it means "use Pi's credential".
 */
export async function resolveUsageCredential(
  ctx: ExtensionContext,
  resolver: CredentialResolver = {},
  signal?: AbortSignal,
): Promise<UsageCredential | null> {
  const env = resolver.env ?? process.env;
  const service = resolver.service?.();
  if (service) {
    try {
      const resolved = await service.resolveActiveAccountAuth(
        PROVIDER_ID,
        ctx as MultiproviderServiceContext,
        signal,
      );
      const apiKey = resolved?.accessToken?.trim();
      if (apiKey) {
        return {
          apiKey,
          label: resolved?.label?.trim() || "pooled",
          source: "multilogin",
          fingerprint: fingerprintOf(apiKey),
        };
      }
    } catch {
      // Never show the upstream account's quota after a pooled credential failure.
      return null;
    }
  }

  const registryKey = await resolveRegistryApiKey(ctx);
  if (registryKey) {
    return {
      apiKey: registryKey,
      label: "pi",
      source: "pi",
      fingerprint: fingerprintOf(registryKey),
    };
  }

  const stored = readStoredApiKey(env);
  if (stored) {
    return {
      apiKey: stored,
      label: "auth.json",
      source: "authFile",
      fingerprint: fingerprintOf(stored),
    };
  }

  const fromEnv = env[API_KEY_ENV_VAR]?.trim();
  if (fromEnv) {
    return {
      apiKey: fromEnv,
      label: API_KEY_ENV_VAR,
      source: "env",
      fingerprint: fingerprintOf(fromEnv),
    };
  }
  return null;
}
