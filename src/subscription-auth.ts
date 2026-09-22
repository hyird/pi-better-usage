import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractApiKey, type CredentialResolver, type UsageCredential } from "./credential.ts";
import { piAgentDir, expandTildePath } from "./paths.ts";
import { UsageError } from "./usage.ts";

export const GROK_PROVIDERS = ["xai", "xai-oauth", "xai-auth"];
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
function credential(
  token: string,
  source: UsageCredential["source"],
  label: string,
  codex: boolean,
  id?: string,
): UsageCredential | null {
  let accountId = id;
  if (codex) {
    try {
      const value = object(JSON.parse(token));
      token = text(value.access) ?? text(value.token) ?? token;
      accountId = text(value.accountId) ?? text(value.account_id) ?? accountId;
    } catch {
      /* Pi normally returns a plain bearer token. */
    }
    accountId ??= accountIdFromToken(token);
    if (!accountId) return null;
  }
  return {
    apiKey: token,
    accountId,
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
  const ids = codex
    ? ["openai-codex"]
    : GROK_PROVIDERS.includes(ctx.model?.provider ?? "")
      ? [ctx.model!.provider]
      : GROK_PROVIDERS;
  const service = resolver.service?.();
  const stored = readJson(join(piAgentDir(env), "auth.json"));
  const registry = ctx.modelRegistry;
  for (const id of ids) {
    signal?.throwIfAborted();
    if (service) {
      try {
        const active = await service.getActiveAccount(id, ctx);
        if (active && active.id !== "pi:default" && active.authKind !== "oauth") return null;
        const resolved = await service.resolveActiveAccountAuth(id, ctx, signal);
        if (resolved?.accessToken) {
          const result = credential(
            resolved.accessToken,
            "multilogin",
            resolved.label || "pooled",
            codex,
          );
          if (!result) throw new Error("Invalid pooled credential");
          return result;
        }
        if (active && active.id !== "pi:default") throw new Error("Missing pooled credential");
      } catch {
        throw new UsageError(
          "auth",
          `${kind} pooled account is unavailable. Sign in again with /multilogin ${id}.`,
        );
      }
    }
    const entry = object(stored[id]);
    // xAI API keys do not represent a SuperGrok subscription.
    let usesOAuth = codex || entry.type === "oauth";
    try {
      if (!codex) {
        if (ctx.model?.provider === id && registry.isUsingOAuth)
          usesOAuth = registry.isUsingOAuth(ctx.model);
      }
      if (usesOAuth) {
        const auth = await registry.getProviderAuth?.(id);
        const token = extractApiKey(auth) ?? (await registry.getApiKeyForProvider?.(id));
        if (token) {
          const result = credential(token, "pi", "pi", codex);
          if (result) return result;
        }
      }
    } catch {
      /* Local OAuth fallback below; never execute auth.json shell values. */
    }
    if (!codex && ctx.model?.provider === id && entry.type === "api_key") return null;
    if (entry.type === "oauth" && !expired(entry.expires, Date.now())) {
      const token = text(entry.access);
      if (token) {
        const result = credential(
          token,
          "authFile",
          "auth.json",
          codex,
          text(entry.accountId) ?? text(entry.account_id),
        );
        if (result) return result;
      }
    }
  }
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
        return credential(token, "authFile", "Grok CLI", false);
    }
    const token = text(data.access_token) ?? text(data.token);
    if (token && !expired(data.expires_at, Date.now()))
      return credential(token, "authFile", "Grok CLI", false);
  }
  return null;
}
