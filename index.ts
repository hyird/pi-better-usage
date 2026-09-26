import { showUsagePanel } from "./src/usage-panel.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { readConfig, type UsageConfig } from "./src/config.ts";
import { type CredentialResolver, type UsageCredential } from "./src/credential.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PROVIDER_ID, STATUS_KEY } from "./src/identity.ts";
import { USAGE_PROVIDERS, type UsageProvider } from "./src/providers.ts";
import {
  isMultiproviderService,
  MULTIPROVIDER_SERVICE_EVENT,
  ACCOUNTS_SERVICE_EVENT,
  type MultiproviderService,
  type SavedUsageAccount,
} from "./src/multiprovider.ts";
import { reportSavedAccounts } from "./src/account-report.ts";
import { UsageQueryCache, failureDelay, quotaScope } from "./src/query-cache.ts";
import {
  accountLabel,
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
  scope: string;
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
  sharedQueries?: UsageQueryCache,
): (ctx: ExtensionContext) => Promise<string> {
  const statusKey = `${STATUS_KEY}-${provider.id}`;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const queries = sharedQueries ?? new UsageQueryCache(options);

  let config: UsageConfig = readConfig(env);
  let cache: CacheState | undefined;
  let lastError: string | undefined;
  let retryAt = 0;
  let failures = 0;
  let lastStatusText: string | undefined;
  /** Whether a widget is currently installed, so we know when to clear one. */
  let widgetInstalled = false;
  let widgetKey: string | undefined;
  let widgetUi: ExtensionContext["ui"] | undefined;
  let widgetTheme: Theme | undefined;
  let service: MultiproviderService | undefined;
  let unsubscribeAccount: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingRefresh: Promise<void> | undefined;
  let active = true;
  // Invalidate pending work on model/account/session changes.
  let generation = 0;
  let activeProvider: string | undefined;
  let activeModelId: string | undefined;
  const scopeFor = (providerId?: string, modelId?: string): string => {
    return quotaScope(provider, providerId, modelId);
  };
  let refreshAbort: AbortController | undefined;
  const invalidateRefresh = (): void => {
    generation += 1;
    refreshAbort?.abort();
    refreshAbort = undefined;
    pendingRefresh = undefined;
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
    const key = parts ? JSON.stringify(parts) : undefined;
    if (
      parts &&
      widgetInstalled &&
      key === widgetKey &&
      ctx.ui === widgetUi &&
      ctx.ui.theme === widgetTheme
    )
      return;
    try {
      ctx.ui.setWidget(
        statusKey,
        parts
          ? (_tui, theme) => ({
              invalidate() {},
              render(width: number): string[] {
                return wrapTextWithAnsi(colorizeSegments(parts, theme), Math.max(1, width));
              },
            })
          : undefined,
        { placement: "belowEditor" },
      );
      widgetInstalled = parts !== undefined;
      widgetKey = key;
      widgetUi = ctx.ui;
      widgetTheme = ctx.ui.theme;
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
      cache &&
      !lastError &&
      cache.scope ===
        scopeFor(activeProvider ?? ctx.model?.provider, activeModelId ?? ctx.model?.id)
        ? usageSegments(
            cache.snapshot,
            config,
            accountLabel(cache.credential, cache.snapshot),
            now(),
          )
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
   * `force` rechecks credentials even with a fresh local reading. Shared quota
   * TTLs and failure backoff still apply, including for explicit commands.
   */
  const refresh = async (
    ctx: ExtensionContext,
    mode: { force?: boolean; ignoreEligibility?: boolean } = {},
  ): Promise<void> => {
    if (!active) return;
    if (!config.enabled && !mode.ignoreEligibility) return;
    if (!mode.ignoreEligibility && !eligible(ctx)) return;
    if (retryAt > now()) return;
    if (
      !mode.force &&
      cache?.scope === scopeFor(ctx.model?.provider, ctx.model?.id) &&
      now() - cache.fetchedAt < config.refreshIntervalMs
    )
      return;
    if (pendingRefresh) return pendingRefresh;
    const requestGeneration = generation;
    const scope = scopeFor(ctx.model?.provider, ctx.model?.id);
    refreshAbort = new AbortController();
    const signal = refreshAbort.signal;
    const work = (async () => {
      try {
        const credential = await provider.resolve(ctx, { service: () => service, env }, signal);
        if (requestGeneration !== generation) return;
        if (!credential) {
          cache = undefined;
          lastError = `No ${provider.name} subscription credential. Use ${provider.loginHint}.`;
          retryAt = now() + 60_000;
          render(lastCtx ?? ctx);
          return;
        }
        // A pooled account switch changes the quota owner; never reuse its reading.
        if (
          cache &&
          (cache.credential.fingerprint !== credential.fingerprint || cache.scope !== scope)
        ) {
          cache = undefined;
          render(ctx);
        }
        const reading = await queries.read(provider, credential, {
          providerId: ctx.model?.provider,
          modelId: ctx.model?.id,
          signal,
          ttl: config.refreshIntervalMs,
        });
        if (requestGeneration !== generation) return;
        cache = { scope, credential, ...reading };
        lastError = undefined;
        retryAt = 0;
        failures = 0;
        render(lastCtx ?? ctx);
      } catch (error) {
        if (requestGeneration !== generation) return;
        const usageError =
          error instanceof UsageError
            ? error
            : new UsageError("transport", `${provider.name} usage is unavailable.`);
        lastError = usageError.message;
        retryAt = now() + failureDelay(usageError, ++failures);
        render(lastCtx ?? ctx);
      } finally {
        if (requestGeneration === generation) {
          refreshAbort = undefined;
        }
      }
    })();
    const pending = work.finally(() => {
      if (pendingRefresh === pending) pendingRefresh = undefined;
    });
    pendingRefresh = pending;
    return pending;
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
          if (!sharedQueries) queries.clear(providerId);
          cache = undefined;
          lastError = undefined;
          retryAt = 0;
          failures = 0;
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
      retryAt = 0;
      failures = 0;
      void refresh(lastCtx, { force: true }).catch(() => undefined);
    }
  };

  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const syncTimer = (ctx: ExtensionContext): void => {
    if (!eligible(ctx)) {
      stopTimer();
      return;
    }
    if (timer !== undefined) return;
    timer = setInterval(() => {
      if (lastCtx) void refresh(lastCtx).catch(() => undefined);
    }, config.refreshIntervalMs);
    timer.unref?.();
  };

  pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: unknown) => {
    if (isMultiproviderService(value)) attachService(value);
  });
  pi.events.on(ACCOUNTS_SERVICE_EVENT, (value: unknown) => {
    if (isMultiproviderService(value)) attachService(value);
  });

  pi.on("session_start", (_event, ctx) => {
    active = true;
    invalidateRefresh();
    if (!sharedQueries) queries.clear();
    config = readConfig(env, ctx.cwd);
    cache = undefined;
    lastError = undefined;
    retryAt = 0;
    failures = 0;
    lastCtx = ctx;
    activeProvider = ctx.model?.provider;
    activeModelId = ctx.model?.id;
    lastStatusText = undefined;
    widgetKey = undefined;
    render(ctx);
    stopTimer();
    syncTimer(ctx);
    void refresh(ctx, { force: true }).catch(() => undefined);
  });

  pi.on("model_select", (event, ctx) => {
    const model = event.model ?? ctx.model;
    const changed =
      activeProvider !== model?.provider ||
      scopeFor(activeProvider, activeModelId) !== scopeFor(model?.provider, model?.id);
    if (changed) {
      invalidateRefresh();
      retryAt = 0;
      failures = 0;
    }
    const selectedCtx = Object.create(ctx, {
      model: { value: model, enumerable: true },
    }) as ExtensionContext;
    lastCtx = selectedCtx;
    activeProvider = model?.provider;
    activeModelId = model?.id;
    // A provider's cached quota survives model switches; aliases and independent
    // quota buckets cannot share it. Account events still invalidate immediately.
    if (eligible(selectedCtx) && cache && cache.scope !== scopeFor(activeProvider, activeModelId)) {
      cache = undefined;
    }
    render(selectedCtx);
    syncTimer(selectedCtx);
    if (eligible(selectedCtx)) void refresh(selectedCtx, { force: changed }).catch(() => undefined);
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
    active = false;
    invalidateRefresh();
    if (!sharedQueries) queries.clear();
    setStatus(ctx, undefined);
    setStatusWidget(ctx, undefined);
    stopTimer();
    unsubscribeAccount?.();
    unsubscribeAccount = undefined;
    service = undefined;
    lastCtx = undefined;
    cache = undefined;
    lastError = undefined;
    retryAt = 0;
    failures = 0;
    activeProvider = undefined;
    activeModelId = undefined;
    lastStatusText = undefined;
  });

  const report = async (ctx: ExtensionContext): Promise<string> => {
    const scope = scopeFor(ctx.model?.provider, ctx.model?.id);
    if (cache?.scope === scope && !lastError) {
      if (now() - cache.fetchedAt >= config.refreshIntervalMs)
        void refresh(ctx, { ignoreEligibility: true }).catch(() => undefined);
    } else {
      await refresh(ctx, { force: true, ignoreEligibility: true });
    }
    return cache?.scope === scope && !lastError
      ? formatDetail(
          cache.snapshot,
          config,
          cache.credential,
          now(),
          hasTerminalUI(ctx) && ctx.ui.theme
            ? (severity, text) => ctx.ui.theme.fg(SEVERITY_COLORS[severity], text)
            : undefined,
        )
      : provider.name + " usage unavailable: " + (lastError ?? "request superseded; try again");
  };
  return report;
}

export function registerUsage(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  // OMP JSON children have no quota panel; the parent owns account refreshes.
  if ((options.env ?? process.env).PI_OMP_CHILD === "1") return;
  const queries = new UsageQueryCache(options);
  pi.on("session_start", () => queries.clear());
  pi.on("session_shutdown", () => queries.clear());
  const reports = USAGE_PROVIDERS.map((provider) =>
    registerProviderUsage(pi, provider, options, queries),
  );
  let accountService: MultiproviderService | undefined;
  let reportCtx: ExtensionContext | undefined;
  let reportTimer: ReturnType<typeof setInterval> | undefined;
  let reportGeneration = 0;
  let reportPending: Promise<void> | undefined;
  let reportAbort: AbortController | undefined;
  let live = true;
  let savedCache: { roster: string; text: string; fetchedAt: number } | undefined;
  let accountUnsubscribers: Array<() => void> = [];
  const now = options.now ?? (() => Date.now());
  const bucketFor = (ctx: ExtensionContext) =>
    ctx.model?.provider === "openai-codex" && ctx.model.id === "gpt-5.3-codex-spark"
      ? "spark"
      : "default";
  let reportBucket = "default";
  const invalidateSaved = () => {
    reportGeneration++;
    reportAbort?.abort();
    reportAbort = undefined;
    reportPending = undefined;
    savedCache = undefined;
  };
  const rosterKey = (accounts: SavedUsageAccount[], ctx: ExtensionContext) =>
    JSON.stringify([
      bucketFor(ctx),
      ...accounts.map(({ id, providerId, label, authKind, active }) => [
        id,
        providerId,
        label,
        authKind,
        active,
      ]),
    ]);
  const configFor = (ctx: ExtensionContext) => readConfig(options.env ?? process.env, ctx.cwd);
  const reportOptions = (ctx: ExtensionContext) => ({
    ...options,
    queries,
    now: now(),
    colorize:
      hasTerminalUI(ctx) && ctx.ui.theme
        ? (severity: UsageSegment["severity"], text: string) =>
            ctx.ui.theme.fg(SEVERITY_COLORS[severity], text)
        : undefined,
    colorHeading:
      hasTerminalUI(ctx) && ctx.ui.theme
        ? (text: string) => ctx.ui.theme.fg("text", text)
        : undefined,
  });
  const refreshSaved = async (
    ctx: ExtensionContext,
    knownAccounts?: SavedUsageAccount[],
  ): Promise<void> => {
    const service = accountService;
    if (!live || !service?.listAccounts || !service.resolveAccountAuth) return;
    const generation = reportGeneration;
    const config = configFor(ctx);
    let accounts = knownAccounts;
    while (reportPending) {
      await reportPending.catch(() => undefined);
      if (!live || generation !== reportGeneration || service !== accountService) return;
      accounts ??= await service.listAccounts();
      if (!live || generation !== reportGeneration || service !== accountService) return;
      if (
        savedCache &&
        now() - savedCache.fetchedAt < config.refreshIntervalMs &&
        savedCache.roster === rosterKey(accounts, ctx)
      )
        return;
    }
    const controller = new AbortController();
    reportAbort = controller;
    const scopedCtx = Object.create(ctx, {
      model: { value: ctx.model, enumerable: true },
    }) as ExtensionContext;
    const work = (async () => {
      const currentAccounts = accounts ?? (await service.listAccounts!());
      controller.signal.throwIfAborted();
      const text = await reportSavedAccounts(scopedCtx, service, currentAccounts, config, {
        ...reportOptions(scopedCtx),
        signal: controller.signal,
      });
      if (live && generation === reportGeneration && accountService === service)
        savedCache = { roster: rosterKey(currentAccounts, scopedCtx), text, fetchedAt: now() };
    })();
    reportPending = work.finally(() => {
      if (reportPending === pending) reportPending = undefined;
      if (reportAbort === controller) reportAbort = undefined;
    });
    const pending = reportPending;
    await pending;
  };
  const scheduleSavedRefresh = (ctx: ExtensionContext) => {
    if (!live || !configFor(ctx).enabled) return;
    void refreshSaved(ctx).catch(() => undefined);
  };
  pi.events.on(ACCOUNTS_SERVICE_EVENT, (value: unknown) => {
    if (isMultiproviderService(value) && value.listAccounts && value.resolveAccountAuth) {
      if (accountService === value && accountUnsubscribers.length) return;
      accountUnsubscribers.forEach((unsubscribe) => unsubscribe());
      accountUnsubscribers = [];
      accountService = value;
      invalidateSaved();
      for (const provider of USAGE_PROVIDERS) {
        for (const providerId of provider.providerIds) {
          accountUnsubscribers.push(
            value.onActiveAccountChanged(providerId, () => {
              queries.clear(providerId);
              invalidateSaved();
              if (reportCtx) scheduleSavedRefresh(reportCtx);
            }),
          );
        }
      }
      if (reportCtx) scheduleSavedRefresh(reportCtx);
    }
  });
  pi.events.emit("pi-accounts:request-service", undefined);
  pi.on("session_start", (_event, ctx) => {
    live = true;
    invalidateSaved();
    reportCtx = ctx;
    reportBucket = bucketFor(ctx);
    if (reportTimer) clearInterval(reportTimer);
    const config = configFor(ctx);
    if (config.enabled) {
      reportTimer = setInterval(() => {
        if (reportCtx) scheduleSavedRefresh(reportCtx);
      }, config.refreshIntervalMs);
      reportTimer.unref?.();
      scheduleSavedRefresh(ctx);
    }
  });
  pi.on("session_shutdown", () => {
    live = false;
    invalidateSaved();
    reportCtx = undefined;
    if (reportTimer) clearInterval(reportTimer);
    reportTimer = undefined;
    accountUnsubscribers.forEach((unsubscribe) => unsubscribe());
    accountUnsubscribers = [];
  });
  pi.on("model_select", (event, ctx) => {
    reportCtx = Object.create(ctx, {
      model: { value: event.model ?? ctx.model, enumerable: true },
    }) as ExtensionContext;
    const bucket = bucketFor(reportCtx);
    if (bucket !== reportBucket) {
      reportBucket = bucket;
      invalidateSaved();
      scheduleSavedRefresh(reportCtx);
    }
  });
  pi.registerCommand("usage", {
    description: "Show usage for every saved account, with labels and current-account markers",
    handler: async (_args: string, ctx: ExtensionContext) => {
      await showUsagePanel(ctx, async () => {
        if (!live) return "Usage request cancelled.";
        const generation = reportGeneration;
        if (accountService?.listAccounts && accountService.resolveAccountAuth) {
          try {
            const accounts = await accountService.listAccounts();
            if (!live || generation !== reportGeneration) return "Usage request cancelled.";
            if (accounts.length) {
              const roster = rosterKey(accounts, ctx);
              if (savedCache?.roster === roster) {
                if (now() - savedCache.fetchedAt >= configFor(ctx).refreshIntervalMs)
                  scheduleSavedRefresh(ctx);
                return savedCache.text;
              }
              await refreshSaved(ctx, accounts);
              if (!live || generation !== reportGeneration) return "Usage request cancelled.";
              if (savedCache?.roster === roster) return savedCache.text;
              return "Usage report changed while loading. Run /usage again.";
            }
          } catch {
            return "Could not read saved accounts. Check account storage and try again.";
          }
        }
        const details = await Promise.all(reports.map((report) => report(ctx)));
        if (!live || generation !== reportGeneration) return "Usage request cancelled.";
        return details.join("\n\n");
      });
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerUsage(pi);
}

/** Re-exported for hosts that want to share the resolver. */
export type { CredentialResolver };
