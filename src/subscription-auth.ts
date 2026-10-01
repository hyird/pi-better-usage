import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { awaitWithAbort } from "./abort.ts";
import { extractApiKey, type CredentialResolver, type UsageCredential } from "./credential.ts";
import { piAgentDir, expandTildePath } from "./paths.ts";
import { UsageError } from "./http.ts";
import { accountEmail, emailFromToken } from "./account-identity.ts";

export const GROK_PROVIDERS = ["xai", "xai-oauth", "xai-auth"];
export const OPENAI_PROVIDERS = ["openai", "openai-codex"];
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readJson(path: string): Record<string, unknown> {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = object(
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
    return text(object(payload["https://api.openai.com/auth"]).chatgpt_account_id);
  } catch {
    return undefined;
  }
}
export function isDirectOpenAIToken(token: string): boolean {
  try {
    if (token.length > 65536) return false;
    const payload = object(
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return (
      audiences.includes("https://api.openai.com/v1") &&
      typeof payload.scope === "string" &&
      payload.scope.split(/\s+/).includes("chatgpt.tokens.use.direct")
    );
  } catch {
    return false;
  }
}
function credential(
  token: string,
  source: UsageCredential["source"],
  label: string,
  codex: boolean,
  id?: string,
  savedEmail?: string,
): UsageCredential | null {
  let accountId = id;
  let openaiAuthMode: UsageCredential["openaiAuthMode"];
  if (codex) {
    try {
      const value = object(JSON.parse(token));
      token = text(value.access) ?? text(value.token) ?? token;
      accountId = text(value.accountId) ?? text(value.account_id) ?? accountId;
    } catch {
      /* Pi normally returns a plain bearer token. */
    }
    openaiAuthMode = isDirectOpenAIToken(token) ? "direct" : "codex";
    if (openaiAuthMode === "direct") accountId = undefined;
    else {
      accountId ??= accountIdFromToken(token);
      if (!accountId) return null;
    }
  }
  return {
    apiKey: token,
    accountId,
    ...(openaiAuthMode ? { openaiAuthMode } : {}),
    email: emailFromToken(token) ?? accountEmail(savedEmail),
    source,
    label,
    fingerprint: createHash("sha256")
      .update(`${token}\0${accountId ?? ""}`)
      .digest("hex")
      .slice(0, 16),
  };
}
function expired(value: unknown, now: number): boolean {
  if (value === undefined || value === null) return false;
  let expiry = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(expiry) && typeof value === "string") expiry = Date.parse(value);
  if (expiry > 0 && expiry < 100_000_000_000) expiry *= 1000;
  return !Number.isFinite(expiry) || expiry <= now;
}

/** Pool affinity is authoritative: a failed pooled login must not show another account. */
export async function resolveSubscriptionCredential(
  kind: "openai" | "grok",
  ctx: ExtensionContext,
  resolver: CredentialResolver = {},
  signal?: AbortSignal,
): Promise<UsageCredential | null> {
  const env = resolver.env ?? process.env;
  const codex = kind === "openai";
  const selectedGrokProvider =
    !codex && GROK_PROVIDERS.includes(ctx.model?.provider ?? "") ? ctx.model!.provider : undefined;
  const selectedOpenAIProvider =
    codex && OPENAI_PROVIDERS.includes(ctx.model?.provider ?? "") ? ctx.model!.provider : undefined;
  const ids = codex
    ? selectedOpenAIProvider
      ? [selectedOpenAIProvider]
      : OPENAI_PROVIDERS
    : selectedGrokProvider
      ? [selectedGrokProvider]
      : GROK_PROVIDERS;
  const service = resolver.service?.();
  let stored: Record<string, unknown> | undefined;
  const registry = ctx.modelRegistry;
  for (const id of ids) {
    signal?.throwIfAborted();
    if (service) {
      try {
        const active = await awaitWithAbort(service.getActiveAccount(id, ctx), signal);
        signal?.throwIfAborted();
        if (active && active.id !== "pi:default" && active.authKind !== "oauth") {
          // A selected model owns this alias. For a general subscription report, a
          // different alias may still have a subscription login.
          if (ctx.model?.provider === id) return null;
          continue;
        }
        const resolved = await awaitWithAbort(
          service.resolveActiveAccountAuth(id, ctx, signal),
          signal,
        );
        signal?.throwIfAborted();
        if (resolved?.accessToken) {
          if (resolved.slotId && resolved.authKind) {
            if (resolved.slotId !== active?.id || resolved.authKind !== "oauth") return null;
          } else {
            // Older account services do not return the final account identity.
            // Recheck it after authentication so a switch cannot change the type.
            const current = await awaitWithAbort(service.getActiveAccount(id, ctx), signal);
            signal?.throwIfAborted();
            if (
              current?.id !== active?.id ||
              current?.authKind !== active?.authKind ||
              (current && current.id !== "pi:default" && current.authKind !== "oauth")
            )
              return null;
          }
          const result = credential(
            resolved.accessToken,
            "multilogin",
            resolved.label || "pooled",
            codex,
            undefined,
            resolved.email,
          );
          if (!result) throw new Error("Invalid pooled credential");
          return { ...result, providerId: id };
        }
        if (active && active.id !== "pi:default") throw new Error("Missing pooled credential");
      } catch {
        signal?.throwIfAborted();
        throw new UsageError(
          "auth",
          `${kind} pooled account is unavailable. Sign in again with /login ${id}.`,
        );
      }
    }
    // A pooled credential already resolved above needs no synchronous read of
    // auth.json. Reuse one snapshot only if local fallback is necessary.
    const entry = object((stored ??= readJson(join(piAgentDir(env), "auth.json")))[id]);
    // Native OpenAI also accepts API keys; only OAuth represents subscription quota.
    let usesOAuth = (codex && id === "openai-codex") || entry.type === "oauth";
    let runtimeOAuth: boolean | undefined;
    const selectedGrok = selectedGrokProvider === id;
    const selectedNativeOpenAI = selectedOpenAIProvider === "openai" && id === "openai";
    try {
      if (!codex || id === "openai") {
        if ((selectedGrok || selectedNativeOpenAI) && ctx.model && registry.isUsingOAuth) {
          runtimeOAuth = registry.isUsingOAuth(ctx.model);
          usesOAuth = runtimeOAuth;
        }
      }
      if (usesOAuth) {
        const auth = registry.getProviderAuth
          ? await awaitWithAbort(registry.getProviderAuth(id), signal)
          : undefined;
        const token =
          extractApiKey(auth) ??
          (registry.getApiKeyForProvider
            ? await awaitWithAbort(registry.getApiKeyForProvider(id), signal)
            : undefined);
        signal?.throwIfAborted();
        if (token) {
          const result = credential(
            token,
            "pi",
            "pi",
            codex,
            undefined,
            entry.access === token ? text(entry.email) : undefined,
          );
          if (result) return { ...result, providerId: id };
        }
      }
    } catch {
      signal?.throwIfAborted();
      /* Local OAuth fallback below; never execute auth.json shell values. */
    }
    if (
      (selectedGrok || selectedNativeOpenAI) &&
      (runtimeOAuth === false || entry.type === "api_key")
    )
      return null;
    if (entry.type === "oauth" && !expired(entry.expires, Date.now())) {
      const token = text(entry.access);
      if (token) {
        const result = credential(
          token,
          "authFile",
          "auth.json",
          codex,
          text(entry.accountId) ?? text(entry.account_id),
          text(entry.email),
        );
        if (result) return { ...result, providerId: id };
      }
    }
    // A configured selected OAuth login must not silently use a different
    // Grok CLI account when its own token is expired or unavailable.
    if (selectedGrok && (runtimeOAuth === true || entry.type === "oauth")) return null;
  }
  signal?.throwIfAborted();
  if (!codex) {
    const data = readJson(
      env.PI_GROK_AUTH_PATH
        ? expandTildePath(env.PI_GROK_AUTH_PATH)
        : join(homedir(), ".grok", "auth.json"),
    );
    const scopes = [
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828",
      "https://accounts.x.ai/sign-in",
    ];
    for (const scope of scopes) {
      const entry = object(data[scope]);
      const token = text(entry.key) ?? text(entry.access_token) ?? text(entry.token);
      if (token && !expired(entry.expires_at, Date.now()))
        return {
          ...credential(token, "authFile", "Grok CLI", false)!,
          providerId: selectedGrokProvider,
        };
    }
    const token = text(data.access_token) ?? text(data.token);
    if (token && !expired(data.expires_at, Date.now()))
      return {
        ...credential(token, "authFile", "Grok CLI", false)!,
        providerId: selectedGrokProvider,
      };
  }
  return null;
}
