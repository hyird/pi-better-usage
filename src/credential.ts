import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { awaitWithAbort } from "./abort.ts";
import { accountEmail } from "./account-identity.ts";
import { API_KEY_ENV_VAR, PROVIDER_ID } from "./identity.ts";
import { piAgentDir } from "./paths.ts";
import type { MultiproviderService, MultiproviderServiceContext } from "./multiprovider.ts";

export type UsageCredentialSource = "multilogin" | "pi" | "authFile" | "env";

export type UsageCredential = {
  apiKey: string;
  accountId?: string;
  /** Provider alias that supplied this credential, when it was resolved across aliases. */
  providerId?: string;
  email?: string;
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
  const payload = value as { apiKey?: unknown; headers?: unknown };
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) return payload.apiKey.trim();
  const headers = payload.headers;
  const authorization =
    headers instanceof Headers
      ? (headers.get("authorization") ?? "")
      : headers && typeof headers === "object"
        ? (Object.entries(headers).find(
            ([name, header]) =>
              name.toLowerCase() === "authorization" && typeof header === "string",
          )?.[1] ?? "")
        : "";
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

type StoredApiKey = { key: string | null; configured: boolean };

function storedApiKey(
  env: NodeJS.ProcessEnv = process.env,
  providerId = PROVIDER_ID,
): StoredApiKey {
  try {
    const data = JSON.parse(readFileSync(`${piAgentDir(env)}/auth.json`, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data))
      return { key: null, configured: true };
    if (!Object.hasOwn(data, providerId)) return { key: null, configured: false };
    const entry = (data as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object") return { key: null, configured: true };
    const record = entry as { type?: unknown; key?: unknown };
    if (record.type !== "api_key") return { key: null, configured: true };
    const key = typeof record.key === "string" ? record.key.trim() : "";
    // Pi resolves commands and $-templates before sending a request. This
    // direct fallback cannot safely use the unexpanded value.
    return {
      key: key && !key.startsWith("!") && !key.includes("$") ? key : null,
      configured: true,
    };
  } catch (error) {
    return { key: null, configured: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
}

/** Pi stores API-key credentials as `{ type: "api_key", key }`. */
export function readStoredApiKey(
  env: NodeJS.ProcessEnv = process.env,
  providerId = PROVIDER_ID,
): string | null {
  return storedApiKey(env, providerId).key;
}

async function resolveRegistryApiKey(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const registry = ctx?.modelRegistry as unknown as {
    getProviderAuth?: (provider: string) => Promise<unknown>;
  };
  if (typeof registry?.getProviderAuth !== "function") return null;
  try {
    const resolved = await awaitWithAbort(registry.getProviderAuth(PROVIDER_ID), signal);
    signal?.throwIfAborted();
    return extractApiKey(resolved);
  } catch {
    signal?.throwIfAborted();
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
 * subscription usage is per account. An empty pool result permits Pi fallback
 * only when no pooled slot is active (or an older service reports `pi:default`).
 */
export async function resolveUsageCredential(
  ctx: ExtensionContext,
  resolver: CredentialResolver = {},
  signal?: AbortSignal,
): Promise<UsageCredential | null> {
  signal?.throwIfAborted();
  const env = resolver.env ?? process.env;
  const service = resolver.service?.();
  if (service) {
    try {
      const resolved = await awaitWithAbort(
        service.resolveActiveAccountAuth(PROVIDER_ID, ctx as MultiproviderServiceContext, signal),
        signal,
      );
      signal?.throwIfAborted();
      const apiKey = resolved?.accessToken?.trim();
      if (apiKey) {
        return {
          apiKey,
          label: resolved?.label?.trim() || "pooled",
          email: accountEmail(resolved?.email),
          source: "multilogin",
          fingerprint: fingerprintOf(apiKey),
        };
      }
      const active = await awaitWithAbort(
        service.getActiveAccount(PROVIDER_ID, ctx as MultiproviderServiceContext),
        signal,
      );
      signal?.throwIfAborted();
      if (active && active.id !== "pi:default") return null;
    } catch {
      signal?.throwIfAborted();
      // Never show the upstream account's quota after a pooled credential failure.
      return null;
    }
  }

  const registryKey = await resolveRegistryApiKey(ctx, signal);
  signal?.throwIfAborted();
  if (registryKey) {
    return {
      apiKey: registryKey,
      label: "pi",
      source: "pi",
      fingerprint: fingerprintOf(registryKey),
    };
  }

  const stored = storedApiKey(env);
  if (stored.key) {
    return {
      apiKey: stored.key,
      label: "auth.json",
      source: "authFile",
      fingerprint: fingerprintOf(stored.key),
    };
  }
  if (stored.configured) return null;

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
