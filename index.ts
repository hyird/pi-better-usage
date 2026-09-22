import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { readConfig, type UsageConfig } from "./src/config.ts";
import { type CredentialResolver, type UsageCredential } from "./src/credential.ts";
import { truncateToWidth } from "./src/format.ts";
import { PROVIDER_ID, STATUS_KEY } from "./src/identity.ts";
import { USAGE_PROVIDERS, type UsageProvider } from "./src/providers.ts";
import {
  isMultiproviderService,
  MULTIPROVIDER_SERVICE_EVENT,
  type MultiproviderService,
} from "./src/multiprovider.ts";
import {
  formatDetail,
  UsageError,
  usageSegments,
  type FetchLike,
  type UsageSegment,
  type UsageSnapshot,
} from "./src/usage.ts";

export * from "./src/config.ts";
export * from "./src/credential.ts";
export * from "./src/format.ts";
export * from "./src/identity.ts";
export * from "./src/multiprovider.ts";
export * from "./src/usage.ts";

/** After a rejected key, stop polling until the credential or account changes. */
const AUTH_FAILURE_COOLDOWN_MS = 10 * 60_000;

/** Severity to theme colour, matching pi-better-grok's palette. */
const SEVERITY_COLORS: Record<UsageSegment["severity"], ThemeColor> = {
  ok: "success",
  warning: "warning",
  critical: "error",
  muted: "dim",
};

function colorizeSegments(segments: readonly UsageSegment[], theme: Theme): string {
  return segments
    .map((segment) => theme.fg(SEVERITY_COLORS[segment.severity], segment.text))
    .join("");
}

/** Widgets and coloured components need a real terminal, not RPC or print mode. */
function hasTerminalUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

export function isOpencodeGoModel(ctx: Pick<ExtensionContext, "model">): boolean {
  return ctx?.model?.provider === PROVIDER_ID;
}

type CacheState = {
  credential: UsageCredential;
  snapshot: UsageSnapshot;
  fetchedAt: number;
};

export type RegisterOptions = {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

/** Each provider owns its cache, polling and account listeners. */
export function registerProviderUsage(
  pi: ExtensionAPI,
  provider: UsageProvider,
  options: RegisterOptions = {},
): (ctx: ExtensionContext) => Promise<string> {
  const statusKey = `${STATUS_KEY}-${provider.id}`;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());

  let config: UsageConfig = readConfig(env);
  let cache: CacheState | undefined;
  let lastError: string | undefined;
  let authBlockedUntil = 0;
  let lastStatusText: string | undefined;
  /** Whether a widget is currently installed, so we know when to clear one. */
  let widgetInstalled = false;
  let service: MultiproviderService | undefined;
  let unsubscribeAccount: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  // Invalidate pending work on model/account/session changes.
  let generation = 0;
  let activeProvider: string | undefined;
  let refreshAbort: AbortController | undefined;
  const invalidateRefresh = (): void => {
    generation += 1;
    refreshAbort?.abort();
    refreshAbort = undefined;
    refreshing = false;
  };
  /** Latest event ctx, so a late multilogin announcement can still refresh. */
  let lastCtx: ExtensionContext | undefined;

  const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
    if (text === lastStatusText) return;
    lastStatusText = text;
    try {
      ctx.ui.setStatus(statusKey, text);
    } catch {
      // A stale ctx after session replacement must not break the turn.
    }
  };

  const setStatusWidget = (ctx: ExtensionContext, parts: UsageSegment[] | undefined): void => {
    if (!parts && !widgetInstalled) return;
    widgetInstalled = parts !== undefined;
    try {
      ctx.ui.setWidget(
        statusKey,
        parts
          ? (_tui, theme) => ({
              invalidate() {},
              render(width: number): string[] {
                return [
                  truncateToWidth(colorizeSegments(parts, theme), width, theme.fg("dim", "...")),
                ];
              },
            })
          : undefined,
        { placement: "belowEditor" },
      );
    } catch {
      // A stale ctx after session replacement must not break the turn.
    }
  };

  const eligible = (ctx: ExtensionContext): boolean =>
    config.enabled && provider.providerIds.includes(activeProvider ?? ctx.model?.provider ?? "");

  const render = (ctx: ExtensionContext): void => {
    if (!eligible(ctx) || config.footerMode === "off") {
      setStatus(ctx, undefined);
      setStatusWidget(ctx, undefined);
      return;
    }

    // Match the better-* series: no placeholder or stale quota after a failure.
    const segments =
      cache && !lastError
        ? usageSegments(cache.snapshot, config, cache.credential.label, now())
        : [];
    const parts: UsageSegment[] | undefined = segments.length > 0 ? segments : undefined;

    // Non-terminal modes have no widget area; they fall back to the status line.
    if (config.footerMode === "widget" && hasTerminalUI(ctx)) {
      setStatus(ctx, undefined);
      setStatusWidget(ctx, parts);
      return;
    }

    setStatusWidget(ctx, undefined);
    setStatus(ctx, parts ? parts.map((segment) => segment.text).join("") : undefined);
  };

  /**
   * `force` bypasses the TTL and the auth cooldown; `ignoreEligibility` also
   * bypasses the active-model gate for an explicit usage command.
   */
  const refresh = async (
    ctx: ExtensionContext,
    mode: { force?: boolean; ignoreEligibility?: boolean } = {},
  ): Promise<void> => {
    if (!config.enabled && !mode.ignoreEligibility) return;
    if (!mode.ignoreEligibility && !eligible(ctx)) return;
    if (!mode.force && authBlockedUntil > now()) return;
    if (!mode.force && cache && now() - cache.fetchedAt < config.refreshIntervalMs) return;
    if (refreshing) {
      if (!mode.force) return;
      invalidateRefresh();
    }
    refreshing = true;
    const requestGeneration = generation;
    refreshAbort = new AbortController();
    const signal = refreshAbort.signal;
    try {
      const credential = await provider.resolve(ctx, { service: () => service, env }, signal);
      if (requestGeneration !== generation) return;
      if (!credential) {
        cache = undefined;
        lastError = `No ${provider.name} subscription credential. Use ${provider.loginHint}.`;
        render(ctx);
        return;
      }
      // A pooled account switch changes the quota owner; never reuse its reading.
      if (cache && cache.credential.fingerprint !== credential.fingerprint) cache = undefined;
      const snapshot = await provider.fetch(credential, {
        modelId:
          ctx.model?.provider && provider.providerIds.includes(ctx.model.provider)
            ? ctx.model.id
            : undefined,
        signal,
        fetchImpl: options.fetchImpl,
        now: now(),
      });
      if (requestGeneration !== generation) return;
      cache = { credential, snapshot, fetchedAt: now() };
      lastError = undefined;
      authBlockedUntil = 0;
      render(ctx);
    } catch (error) {
      if (requestGeneration !== generation) return;
      const usageError =
        error instanceof UsageError
          ? error
          : new UsageError("transport", `${provider.name} usage is unavailable.`);
      lastError = usageError.message;
      if (usageError.kind === "auth") authBlockedUntil = now() + AUTH_FAILURE_COOLDOWN_MS;
      render(ctx);
    } finally {
      if (requestGeneration === generation) {
        refreshing = false;
        refreshAbort = undefined;
      }
    }
  };

  const attachService = (candidate: MultiproviderService): void => {
    if (candidate === service) return;
    unsubscribeAccount?.();
    unsubscribeAccount = undefined;
    service = candidate;
    try {
      const subscriptions = provider.providerIds.map((providerId) =>
        candidate.onActiveAccountChanged(providerId, (event) => {
          // Drop the previous account's numbers, then re-read for the new one.
          invalidateRefresh();
          cache = undefined;
          lastError = undefined;
          authBlockedUntil = 0;
          const ctx = lastCtx ?? event?.ctx;
          if (!ctx) return;
          render(ctx);
          void refresh(ctx, { force: true }).catch(() => undefined);
        }),
      );
      unsubscribeAccount = () => {
        for (const unsubscribe of subscriptions) unsubscribe();
      };
    } catch {
      unsubscribeAccount = undefined;
    }
    // The announcement can arrive after session_start, so the first reading may
    // have used Pi's own key. Re-read now that the active account is known.
    if (lastCtx) {
      invalidateRefresh();
      cache = undefined;
      lastError = undefined;
      render(lastCtx);
      authBlockedUntil = 0;
      void refresh(lastCtx, { force: true }).catch(() => undefined);
    }
  };

  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: unknown) => {
    if (isMultiproviderService(value)) attachService(value);
  });

  pi.on("session_start", (_event, ctx) => {
    invalidateRefresh();
    config = readConfig(env, ctx.cwd);
    cache = undefined;
    lastError = undefined;
    authBlockedUntil = 0;
    lastCtx = ctx;
    activeProvider = ctx.model?.provider;
    lastStatusText = undefined;
    render(ctx);
    stopTimer();
    timer = setInterval(() => {
      if (lastCtx) void refresh(lastCtx).catch(() => undefined);
    }, config.refreshIntervalMs);
    timer.unref?.();
    void refresh(ctx, { force: true }).catch(() => undefined);
  });

  pi.on("model_select", (event, ctx) => {
    invalidateRefresh();
    lastCtx = ctx;
    activeProvider = event.model?.provider ?? ctx.model?.provider;
    cache = undefined;
    lastError = undefined;
    authBlockedUntil = 0;
    // Clear immediately, before any asynchronous credential or usage request.
    render(ctx);
    if (eligible(ctx)) void refresh(ctx, { force: true }).catch(() => undefined);
  });

  const updateDisplay = (_event: unknown, ctx: ExtensionContext): void => {
    lastCtx = ctx;
    render(ctx);
  };
  pi.on("agent_start", updateDisplay);
  pi.on("agent_end", updateDisplay);
  pi.on("session_compact", updateDisplay);
  pi.on("session_tree", updateDisplay);
  pi.on("turn_end", (_event, ctx) => {
    updateDisplay(_event, ctx);
    // Match better-openai: refresh after each turn, subject to the cache TTL.
    void refresh(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    invalidateRefresh();
    setStatus(ctx, undefined);
    setStatusWidget(ctx, undefined);
    stopTimer();
    unsubscribeAccount?.();
    unsubscribeAccount = undefined;
    service = undefined;
    lastCtx = undefined;
    cache = undefined;
    lastError = undefined;
    authBlockedUntil = 0;
    activeProvider = undefined;
    lastStatusText = undefined;
  });

  const report = async (ctx: ExtensionContext): Promise<string> => {
    await refresh(ctx, { force: true, ignoreEligibility: true });
    return cache && !lastError
      ? formatDetail(cache.snapshot, config, cache.credential, now())
      : provider.name + " usage unavailable: " + (lastError ?? "request superseded; try again");
  };
  return report;
}

export function registerUsage(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  const reports = USAGE_PROVIDERS.map((provider) => registerProviderUsage(pi, provider, options));
  pi.registerCommand("usage", {
    description: "Show all OpenAI, Grok and OpenCode subscription usage",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const details = await Promise.all(reports.map((report) => report(ctx)));
      ctx.ui.notify(details.join("\n\n"), "info");
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerUsage(pi);
}

/** Re-exported for hosts that want to share the resolver. */
export type { CredentialResolver };
