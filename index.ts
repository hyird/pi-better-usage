import { statSync } from "node:fs";
import { join } from "node:path";
import { awaitWithAbort } from "./src/abort.ts";
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
import { OPENAI_PROVIDERS } from "./src/subscription-auth.ts";
import {
  isMultiproviderService,
  MULTIPROVIDER_SERVICE_EVENT,
  ACCOUNTS_SERVICE_EVENT,
  type MultiproviderService,
  type SavedUsageAccount,
} from "./src/multiprovider.ts";
import { reportSavedAccounts } from "./src/account-report.ts";
import { UsageQueryCache, failureDelay, freshWithin, quotaScope } from "./src/query-cache.ts";
import { piAgentDir } from "./src/paths.ts";
import {
  accountLabel,
  formatDetail,
  usageSegments,
  type UsageSegment,
  type UsageSnapshot,
} from "./src/usage.ts";
import { UsageError, type FetchLike } from "./src/http.ts";

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
  providerId?: string;
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
  const authPath = join(piAgentDir(env), "auth.json");
  const authRevision = (): string => {
    try {
      const file = statSync(authPath, { bigint: true });
      return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    } catch (error) {
      return `unavailable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
    }
  };

  let config: UsageConfig = readConfig(env);
  let cache: CacheState | undefined;
  let lastError: string | undefined;
  let retryAt = 0;
  let retryStartedAt = 0;
  const inBackoff = (): boolean => {
    const current = now();
    return current >= retryStartedAt && current < retryAt;
  };
  const clearBackoff = (): void => {
    retryAt = 0;
    retryStartedAt = 0;
  };
  const setBackoff = (delay: number): void => {
    retryStartedAt = now();
    retryAt = retryStartedAt + delay;
  };
  let failures = 0;
  let attemptedIdentity: string | undefined;
  let unresolvedAuthRevision: string | undefined;
  let lastStatusText: string | undefined;
  let lastStatusUi: ExtensionContext["ui"] | undefined;
  /** Whether a widget is currently installed, so we know when to clear one. */
  let widgetInstalled = false;
  let widgetKey: string | undefined;
  let widgetUi: ExtensionContext["ui"] | undefined;
  let widgetTheme: Theme | undefined;
  let service: MultiproviderService | undefined;
  let unsubscribeAccount: (() => void) | undefined;
  const releaseProviderSubscriptions = () => {
    try {
      unsubscribeAccount?.();
    } catch {
      /* A stale service must not block replacement. */
    }
    unsubscribeAccount = undefined;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let pendingRefresh: Promise<void> | undefined;
  let pendingMetadataRefresh = false;
  let pendingCredentialRefresh = false;
  let pendingAuthRevision: string | undefined;
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
    pendingMetadataRefresh = false;
    pendingCredentialRefresh = false;
    pendingAuthRevision = undefined;
  };
  /** Latest event ctx, so a late multilogin announcement can still refresh. */
  let lastCtx: ExtensionContext | undefined;

  const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
    if (text === lastStatusText && ctx.ui === lastStatusUi) return;
    try {
      ctx.ui.setStatus(statusKey, text);
      lastStatusText = text;
      lastStatusUi = ctx.ui;
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
    mode: { force?: boolean; ignoreEligibility?: boolean; recheckPending?: boolean } = {},
  ): Promise<void> => {
    if (!active) return;
    if (!config.enabled && !mode.ignoreEligibility) return;
    if (!mode.ignoreEligibility && !eligible(ctx)) return;
    if (inBackoff()) {
      // A native login changes auth.json; retry unresolved credentials immediately,
      // but do not repeat a failed auth lookup on every turn.
      if (unresolvedAuthRevision !== undefined) {
        if (!mode.force || authRevision() === unresolvedAuthRevision) return;
      } else if (!mode.force) return;
    }
    if (
      !mode.force &&
      cache?.scope === scopeFor(ctx.model?.provider, ctx.model?.id) &&
      freshWithin(cache.fetchedAt, now(), config.refreshIntervalMs)
    )
      return;
    if (pendingRefresh) {
      if (mode.recheckPending) {
        pendingCredentialRefresh = true;
        if (pendingAuthRevision !== undefined && authRevision() !== pendingAuthRevision) {
          cache = undefined;
          lastError = undefined;
          render(lastCtx ?? ctx);
        }
      }
      return pendingRefresh;
    }
    const requestGeneration = generation;
    const scope = scopeFor(ctx.model?.provider, ctx.model?.id);
    refreshAbort = new AbortController();
    const signal = refreshAbort.signal;
    const authRevisionAtStart = authRevision();
    pendingAuthRevision = authRevisionAtStart;
    const work = (async () => {
      let resolvedCredential = false;
      const deferStale = (): boolean => {
        if (!pendingCredentialRefresh && authRevision() === authRevisionAtStart) return false;
        pendingCredentialRefresh = true;
        cache = undefined;
        lastError = undefined;
        render(lastCtx ?? ctx);
        return true;
      };
      try {
        const credential = await provider.resolve(ctx, { service: () => service, env }, signal);
        if (requestGeneration !== generation) return;
        if (deferStale()) return;
        resolvedCredential = true;
        if (!credential) {
          attemptedIdentity = undefined;
          unresolvedAuthRevision = authRevisionAtStart;
          cache = undefined;
          lastError = `No ${provider.name} subscription credential. Use ${provider.loginHint}.`;
          setBackoff(60_000);
          render(lastCtx ?? ctx);
          return;
        }
        unresolvedAuthRevision = undefined;
        const identity = JSON.stringify([scope, credential.fingerprint, credential.accountId]);
        // A rejected account keeps its cooldown, while a newly selected login
        // can fetch immediately even if the previous account is in backoff.
        if (identity === attemptedIdentity && inBackoff()) return;
        if (identity !== attemptedIdentity) {
          attemptedIdentity = identity;
          clearBackoff();
          failures = 0;
          lastError = undefined;
        }
        // A pooled account switch changes the quota owner; never reuse its reading.
        if (
          cache &&
          (cache.credential.fingerprint !== credential.fingerprint ||
            cache.credential.accountId !== credential.accountId ||
            cache.scope !== scope)
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
        if (deferStale()) return;
        cache = {
          scope,
          providerId:
            credential.providerId ??
            (provider.providerIds.length === 1
              ? provider.providerIds[0]
              : provider.providerIds.includes(ctx.model?.provider ?? "")
                ? ctx.model?.provider
                : undefined),
          credential,
          ...reading,
        };
        lastError = undefined;
        clearBackoff();
        failures = 0;
        render(lastCtx ?? ctx);
      } catch (error) {
        if (requestGeneration !== generation) return;
        if (deferStale()) return;
        if (!resolvedCredential) {
          attemptedIdentity = undefined;
          unresolvedAuthRevision = authRevisionAtStart;
        }
        const usageError =
          error instanceof UsageError
            ? error
            : new UsageError("transport", `${provider.name} usage is unavailable.`);
        lastError = usageError.message;
        setBackoff(failureDelay(usageError, ++failures));
        render(lastCtx ?? ctx);
      } finally {
        if (requestGeneration === generation) {
          refreshAbort = undefined;
          pendingAuthRevision = undefined;
        }
      }
    })();
    const pending = work.finally(() => {
      if (pendingRefresh === pending) {
        pendingRefresh = undefined;
        if (pendingCredentialRefresh || pendingMetadataRefresh) {
          pendingCredentialRefresh = false;
          pendingMetadataRefresh = false;
          // Re-resolve after a login or label change while the old request ran.
          void refresh(lastCtx ?? ctx, { force: true }).catch(() => undefined);
        }
      }
    });
    pendingRefresh = pending;
    return pending;
  };

  const attachService = (candidate: MultiproviderService): void => {
    if (candidate === service && unsubscribeAccount) return;
    releaseProviderSubscriptions();
    service = candidate;
    const subscriptions: Array<() => void> = [];
    try {
      for (const providerId of provider.providerIds) {
        subscriptions.push(
          candidate.onActiveAccountChanged(providerId, (event) => {
            if (event?.kind === "metadata") {
              const ctx = lastCtx ?? event.ctx;
              if (ctx) {
                if (pendingRefresh) pendingMetadataRefresh = true;
                else void refresh(ctx, { force: true }).catch(() => undefined);
              }
              return;
            }
            // Drop the previous account's numbers, then re-read for the new one.
            invalidateRefresh();
            if (!sharedQueries) queries.clear(providerId);
            cache = undefined;
            lastError = undefined;
            clearBackoff();
            failures = 0;
            unresolvedAuthRevision = undefined;
            const ctx = lastCtx ?? event?.ctx;
            if (!ctx) return;
            render(ctx);
            void refresh(ctx, { force: true }).catch(() => undefined);
          }),
        );
      }
      unsubscribeAccount = () => {
        for (const unsubscribe of subscriptions) {
          try {
            unsubscribe();
          } catch {
            /* Continue releasing the other subscriptions. */
          }
        }
      };
    } catch {
      for (const unsubscribe of subscriptions) {
        try {
          unsubscribe();
        } catch {
          /* Continue releasing the other subscriptions. */
        }
      }
      unsubscribeAccount = undefined;
    }
    // The announcement can arrive after session_start, so the first reading may
    // have used Pi's own key. Re-read now that the active account is known.
    if (lastCtx) {
      invalidateRefresh();
      cache = undefined;
      lastError = undefined;
      render(lastCtx);
      clearBackoff();
      failures = 0;
      unresolvedAuthRevision = undefined;
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
    clearBackoff();
    failures = 0;
    attemptedIdentity = undefined;
    unresolvedAuthRevision = undefined;
    lastCtx = ctx;
    activeProvider = ctx.model?.provider;
    activeModelId = ctx.model?.id;
    lastStatusText = undefined;
    lastStatusUi = undefined;
    widgetKey = undefined;
    render(ctx);
    stopTimer();
    syncTimer(ctx);
    void refresh(ctx, { force: true }).catch(() => undefined);
  });

  pi.on("model_select", (event, ctx) => {
    const model = event.model ?? ctx.model;
    const providerChanged = activeProvider !== model?.provider;
    const changed =
      providerChanged ||
      scopeFor(activeProvider, activeModelId) !== scopeFor(model?.provider, model?.id);
    if (changed) {
      invalidateRefresh();
      clearBackoff();
      failures = 0;
    }
    const selectedCtx = Object.create(ctx, {
      model: { value: model, enumerable: true },
    }) as ExtensionContext;
    lastCtx = selectedCtx;
    activeProvider = model?.provider;
    activeModelId = model?.id;
    // Alias changes must re-resolve the credential before showing a cached quota.
    // Models within one provider can keep their reading when the bucket is unchanged.
    if (
      eligible(selectedCtx) &&
      cache &&
      (cache.providerId !== activeProvider ||
        cache.scope !== scopeFor(activeProvider, activeModelId))
    ) {
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
    // Without an account-change subscription, recheck Pi's current credential.
    // The shared query cache still avoids a request for an unchanged login.
    void refresh(ctx, {
      force: !unsubscribeAccount,
      recheckPending: !unsubscribeAccount,
    }).catch(() => undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    invalidateRefresh();
    if (!sharedQueries) queries.clear();
    setStatus(ctx, undefined);
    setStatusWidget(ctx, undefined);
    stopTimer();
    releaseProviderSubscriptions();
    service = undefined;
    lastCtx = undefined;
    cache = undefined;
    lastError = undefined;
    clearBackoff();
    failures = 0;
    attemptedIdentity = undefined;
    unresolvedAuthRevision = undefined;
    activeProvider = undefined;
    activeModelId = undefined;
    lastStatusText = undefined;
    lastStatusUi = undefined;
  });

  const report = async (ctx: ExtensionContext): Promise<string> => {
    const scope = scopeFor(ctx.model?.provider, ctx.model?.id);
    // Explicit reports must confirm the current login and wait for stale data.
    // The shared query cache avoids another HTTP request for an unchanged key.
    let revision = authRevision();
    for (let attempt = 0; attempt < 3; attempt++) {
      const hadPending = !!pendingRefresh;
      await refresh(ctx, { force: true, ignoreEligibility: true });
      const currentRevision = authRevision();
      if (!hadPending && currentRevision === revision) break;
      if (attempt === 2) return provider.name + " usage changed while loading; try again.";
      // A pending poll may have resolved an earlier login, or native /login
      // may have changed auth.json while this request was in flight. A stale
      // poll can also queue one follow-up refresh before this command resumes.
      revision = currentRevision;
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
  type SavedReport = { text: string; verified: boolean };
  let reportPending: Promise<SavedReport> | undefined;
  let trailingRefreshCtx: ExtensionContext | undefined;
  let reportAbort: AbortController | undefined;
  let live = true;
  let savedCache:
    | { roster: string; preEmailRoster?: string; text: string; fetchedAt: number }
    | undefined;
  let accountUnsubscribers: Array<() => void> = [];
  const releaseAccountSubscriptions = () => {
    const subscriptions = accountUnsubscribers;
    accountUnsubscribers = [];
    for (const unsubscribe of subscriptions) {
      try {
        unsubscribe();
      } catch {
        /* Continue releasing the other subscriptions. */
      }
    }
  };
  const now = options.now ?? (() => Date.now());
  const bucketFor = (ctx: ExtensionContext) =>
    OPENAI_PROVIDERS.includes(ctx.model?.provider ?? "") && ctx.model?.id === "gpt-5.3-codex-spark"
      ? "spark"
      : "default";
  let reportBucket = "default";
  const invalidateSaved = () => {
    reportGeneration++;
    trailingRefreshCtx = undefined;
    reportAbort?.abort();
    reportAbort = undefined;
    reportPending = undefined;
    savedCache = undefined;
  };
  const rosterKey = (accounts: SavedUsageAccount[], ctx: ExtensionContext) =>
    JSON.stringify([
      bucketFor(ctx),
      ...accounts.map(({ id, providerId, label, authKind, active, email, credentialRevision }) => [
        id,
        providerId,
        label,
        authKind,
        active,
        email,
        credentialRevision,
      ]),
    ]);
  const cacheMatches = (roster: string): boolean =>
    !!savedCache && (savedCache.roster === roster || savedCache.preEmailRoster === roster);
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
    callerSignal?: AbortSignal,
  ): Promise<SavedReport | undefined> => {
    callerSignal?.throwIfAborted();
    const service = accountService;
    if (!live || !service?.listAccounts || !service.resolveAccountAuth) return;
    const generation = reportGeneration;
    const config = configFor(ctx);
    let accounts = knownAccounts;
    while (reportPending) {
      await awaitWithAbort(
        reportPending.catch(() => undefined),
        callerSignal,
      );
      if (!live || generation !== reportGeneration || service !== accountService) return;
      // The caller's roster may have changed while another report was in
      // flight, even if this service has no working change subscription.
      accounts = await awaitWithAbort(service.listAccounts(), callerSignal);
      if (!live || generation !== reportGeneration || service !== accountService) return;
      if (
        savedCache &&
        freshWithin(savedCache.fetchedAt, now(), config.refreshIntervalMs) &&
        cacheMatches(rosterKey(accounts, ctx))
      )
        return { text: savedCache.text, verified: true };
    }
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    reportAbort = controller;
    const scopedCtx = Object.create(ctx, {
      model: { value: ctx.model, enumerable: true },
    }) as ExtensionContext;
    const work = (async () => {
      const currentAccounts = accounts ?? (await awaitWithAbort(service.listAccounts!(), signal));
      signal.throwIfAborted();
      if (
        savedCache &&
        freshWithin(savedCache.fetchedAt, now(), config.refreshIntervalMs) &&
        cacheMatches(rosterKey(currentAccounts, scopedCtx))
      )
        return { text: savedCache.text, verified: true };
      let verifiedRoster: SavedUsageAccount[] | undefined;
      let projectedRoster: SavedUsageAccount[] | undefined;
      const text = await reportSavedAccounts(scopedCtx, service, currentAccounts, config, {
        ...reportOptions(scopedCtx),
        signal,
        onVerifiedRoster: (roster, projected) => {
          verifiedRoster = roster;
          projectedRoster = projected;
        },
      });
      if (live && generation === reportGeneration && accountService === service) {
        if (verifiedRoster) {
          const roster = rosterKey(projectedRoster ?? verifiedRoster, scopedCtx);
          const beforeEmail = rosterKey(verifiedRoster, scopedCtx);
          savedCache = {
            roster,
            ...(beforeEmail !== roster ? { preEmailRoster: beforeEmail } : {}),
            text,
            fetchedAt: now(),
          };
        } else savedCache = undefined;
      }
      return { text, verified: !!verifiedRoster };
    })();
    reportPending = work.finally(() => {
      if (reportPending === pending) {
        reportPending = undefined;
        const trailing = trailingRefreshCtx;
        trailingRefreshCtx = undefined;
        if (trailing) scheduleSavedRefresh(trailing);
      }
      if (reportAbort === controller) reportAbort = undefined;
    });
    const pending = reportPending;
    return pending;
  };
  const scheduleSavedRefresh = (ctx: ExtensionContext) => {
    if (!live || !configFor(ctx).enabled) return;
    // Coalesce timer ticks into one roster recheck after a slow report. This
    // still discovers account changes that occurred while the report ran.
    if (reportPending) {
      trailingRefreshCtx = ctx;
      return;
    }
    void refreshSaved(ctx).catch(() => undefined);
  };
  pi.events.on(ACCOUNTS_SERVICE_EVENT, (value: unknown) => {
    if (isMultiproviderService(value) && value.listAccounts && value.resolveAccountAuth) {
      if (accountService === value && accountUnsubscribers.length) return;
      releaseAccountSubscriptions();
      accountService = value;
      invalidateSaved();
      try {
        for (const provider of USAGE_PROVIDERS) {
          for (const providerId of provider.providerIds) {
            accountUnsubscribers.push(
              value.onActiveAccountChanged(providerId, (event) => {
                if (event?.kind !== "metadata") queries.clear(providerId);
                invalidateSaved();
                if (reportCtx) scheduleSavedRefresh(reportCtx);
              }),
            );
          }
        }
      } catch {
        releaseAccountSubscriptions();
        // Polling and explicit /usage reports still work without change events.
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
    releaseAccountSubscriptions();
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
      await showUsagePanel(ctx, async (signal) => {
        if (!live || signal.aborted) return "Usage request cancelled.";
        const generation = reportGeneration;
        if (accountService?.listAccounts && accountService.resolveAccountAuth) {
          try {
            const accounts = await awaitWithAbort(accountService.listAccounts(), signal);
            if (!live || generation !== reportGeneration) return "Usage request cancelled.";
            if (accounts.length) {
              const roster = rosterKey(accounts, ctx);
              if (cacheMatches(roster)) {
                if (!freshWithin(savedCache!.fetchedAt, now(), configFor(ctx).refreshIntervalMs))
                  scheduleSavedRefresh(ctx);
                return savedCache!.text;
              }
              const fetched = await refreshSaved(ctx, accounts, signal);
              if (!live || generation !== reportGeneration) return "Usage request cancelled.";
              if (fetched && !fetched.verified) {
                // A storage read or one account lookup may have failed, or the
                // roster may have changed while requests were in flight. Retry
                // a changed roster once so the panel can show every account.
                let latest: SavedUsageAccount[] | undefined;
                try {
                  latest = await awaitWithAbort(accountService.listAccounts(), signal);
                } catch {
                  signal.throwIfAborted();
                }
                if (!live || generation !== reportGeneration) return "Usage request cancelled.";
                let report: SavedReport | undefined = fetched;
                if (latest && rosterKey(latest, ctx) !== roster) {
                  if (!latest.length)
                    return "Usage report changed while loading. Run /usage again.";
                  report = await refreshSaved(ctx, latest, signal);
                  if (!live || generation !== reportGeneration) return "Usage request cancelled.";
                  if (report?.verified) return report.text;
                }
                return report?.text
                  ? `${report.text}\n\nAccount list could not be verified. Run /usage again for a complete report.`
                  : "Usage report changed while loading. Run /usage again.";
              }
              if (cacheMatches(roster)) return savedCache!.text;
              // Authentication may have refreshed an OAuth credential during
              // this report. Accept the cache only if it matches the current pool.
              const current = await awaitWithAbort(accountService.listAccounts(), signal);
              if (cacheMatches(rosterKey(current, ctx))) return savedCache!.text;
              return "Usage report changed while loading. Run /usage again.";
            }
          } catch {
            if (signal.aborted) return "Usage request cancelled.";
            return "Could not read saved accounts. Check account storage and try again.";
          }
        }
        const details = await awaitWithAbort(
          Promise.all(reports.map((report) => report(ctx))),
          signal,
        );
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
