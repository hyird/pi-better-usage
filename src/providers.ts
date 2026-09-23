import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  resolveUsageCredential,
  type CredentialResolver,
  type UsageCredential,
} from "./credential.ts";
import { GROK_PROVIDERS, object, resolveSubscriptionCredential } from "./subscription-auth.ts";
import {
  fetchUsage,
  fetchWithTransportRetry,
  UsageError,
  type FetchLike,
  type UsageSnapshot,
  type UsageWindow,
} from "./usage.ts";

export type QueryOptions = {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: number;
  modelId?: string;
};
export type UsageProvider = {
  id: "openai" | "grok" | "opencode";
  name: string;
  providerIds: readonly string[];
  loginHint: string;
  resolve(
    ctx: ExtensionContext,
    resolver: CredentialResolver,
    signal?: AbortSignal,
  ): Promise<UsageCredential | null>;
  fetch(credential: UsageCredential, options: QueryOptions): Promise<UsageSnapshot>;
};
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
export const GROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function percent(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 100;
}
function resetAt(value: unknown, now: number): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : finite(value) ? value : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed - now) < 400 * 86400_000 ? parsed : null;
}
function requireWindows(snapshot: UsageSnapshot): UsageSnapshot {
  if (!Object.keys(snapshot.windows).length)
    throw new UsageError(
      "invalid",
      `${snapshot.providerLabel} usage response contained no usable window.`,
    );
  return snapshot;
}
export function parseOpenAIUsage(data: unknown, now = Date.now(), modelId?: string): UsageSnapshot {
  const root = object(data);
  let bucket = object(root.rate_limit);
  if (modelId === "gpt-5.3-codex-spark") {
    const extra = Array.isArray(root.additional_rate_limits)
      ? root.additional_rate_limits
      : Object.values(object(root.additional_rate_limits));
    // A separate model bucket must never silently display the default quota.
    bucket = object(
      object(extra.find((v) => object(v).limit_name === "GPT-5.3-Codex-Spark")).rate_limit,
    );
  }
  const snapshot: UsageSnapshot = { capturedAt: now, providerLabel: "OpenAI Codex", windows: {} };
  for (const [field, fallback] of [
    ["primary_window", "rolling"],
    ["secondary_window", "weekly"],
  ] as const) {
    const raw = object(bucket[field]);
    if (!percent(raw.used_percent)) continue;
    const seconds = raw.limit_window_seconds;
    const key = finite(seconds) ? (seconds >= 6 * 86400 ? "weekly" : "rolling") : fallback;
    const reset = finite(raw.reset_at)
      ? raw.reset_at * (raw.reset_at < 100_000_000_000 ? 1000 : 1)
      : finite(raw.reset_after_seconds)
        ? now + raw.reset_after_seconds * 1000
        : null;
    snapshot.windows[key] = {
      percentUsed: raw.used_percent,
      resetsAt: resetAt(reset, now),
      status: bucket.limit_reached === true || bucket.allowed === false ? "limited" : "ok",
      ...(finite(seconds) && seconds !== 18000 && seconds !== 604800
        ? { label: `${Math.round(seconds / 3600)}h` }
        : {}),
    };
  }
  return requireWindows(snapshot);
}
export function parseGrokUsage(data: unknown, now = Date.now()): UsageSnapshot {
  const config = object(object(data).config);
  const period = object(config.currentPeriod);
  let used = config.creditUsagePercent;
  if (!percent(used)) {
    const amount = object(config.used).val;
    const limit = object(config.monthlyLimit).val;
    // Legacy monthly credits only; unified billing missing a percentage is unknown.
    if (
      config.isUnifiedBillingUser !== true &&
      finite(amount) &&
      amount >= 0 &&
      finite(limit) &&
      limit > 0
    )
      used = Math.min(100, (amount / limit) * 100);
  }
  if (!percent(used))
    throw new UsageError("invalid", "Grok usage response has no valid subscription percentage.");
  const type = typeof period.type === "string" ? period.type.toUpperCase() : "";
  const key = type.includes("WEEK")
    ? "weekly"
    : type.includes("MONTH") || (!type && config.billingPeriodEnd)
      ? "monthly"
      : "rolling";
  const window: UsageWindow = {
    percentUsed: used,
    status: "ok",
    resetsAt: resetAt(period.end ?? config.billingPeriodEnd, now),
  };
  if (key === "rolling") window.label = "period";
  return { capturedAt: now, providerLabel: "Grok", windows: { [key]: window } };
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  name: string,
  options: QueryOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const response = await fetchWithTransportRetry(
      fetchImpl,
      url,
      { Accept: "application/json", ...headers },
      options.signal,
    );
    if (!response.ok) {
      const auth = response.status === 401 || response.status === 403;
      throw new UsageError(
        auth ? "auth" : "http",
        auth
          ? `${name} authentication was rejected. Sign in again.`
          : `${name} usage request failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (Number(response.headers.get("content-length")) > 256 * 1024)
      throw new UsageError("oversize", `${name} usage response is too large.`);
    try {
      return await response.json();
    } catch {
      throw new UsageError("invalid", `${name} usage returned invalid JSON.`);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // Fetch errors may contain headers/tokens. Never propagate arbitrary messages to the UI.
    throw new UsageError(
      "transport",
      `${name} usage request failed or timed out. Check your connection.`,
    );
  }
}
export async function fetchOpenAIUsage(
  credential: UsageCredential,
  options: QueryOptions = {},
): Promise<UsageSnapshot> {
  if (!credential.accountId)
    throw new UsageError("auth", "OpenAI Codex account ID is missing. Use /login openai-codex.");
  const data = await requestJson(
    OPENAI_USAGE_URL,
    { Authorization: `Bearer ${credential.apiKey}`, "chatgpt-account-id": credential.accountId },
    "OpenAI",
    options,
  );
  return parseOpenAIUsage(data, options.now, options.modelId);
}
export async function fetchGrokUsage(
  credential: UsageCredential,
  options: QueryOptions = {},
): Promise<UsageSnapshot> {
  const headers = {
    Authorization: `Bearer ${credential.apiKey}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": "0.2.101",
    "x-grok-client-mode": "headless",
  };
  const userId = object(await requestJson(GROK_USER_URL, headers, "Grok", options)).userId;
  if (typeof userId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(userId))
    throw new UsageError(
      "invalid",
      "Grok account identity could not be verified; billing was not requested.",
    );
  const data = await requestJson(
    GROK_USAGE_URL,
    { ...headers, "x-userid": userId },
    "Grok",
    options,
  );
  return parseGrokUsage(data, options.now);
}
export const USAGE_PROVIDERS: readonly UsageProvider[] = [
  {
    id: "openai",
    name: "OpenAI Codex",
    providerIds: ["openai-codex"],
    loginHint: "/login openai-codex",
    resolve: (ctx, r, s) => resolveSubscriptionCredential("openai", ctx, r, s),
    fetch: fetchOpenAIUsage,
  },
  {
    id: "grok",
    name: "Grok",
    providerIds: GROK_PROVIDERS,
    loginHint: "/login xai or grok login",
    resolve: (ctx, r, s) => resolveSubscriptionCredential("grok", ctx, r, s),
    fetch: fetchGrokUsage,
  },
  {
    id: "opencode",
    name: "OpenCode Go",
    providerIds: ["opencode-go"],
    loginHint: "/login opencode-go or /multilogin opencode-go",
    resolve: resolveUsageCredential,
    fetch: fetchUsage,
  },
];
