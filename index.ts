/**
 * Better OpenCode Go for pi.
 *
 * Shows the OpenCode Go subscription windows (rolling 5h, weekly, monthly) in a
 * coloured widget below the editor and reports them with `/go-usage`, styled
 * after pi-better-grok: a `Usage: …` line with the remaining percentage coloured
 * green/amber/red, a `↺ <countdown> - <clock>` reset taken from the window
 * closest to its limit, and the pooled account label as a dim trailing suffix.
 *
 * Reads the official usage endpoint documented in `src/usage.ts`, authenticated
 * with the provider's API key. Credits resolve through pi-multiprovider when it
 * pools `opencode-go`, so `/switch-account` changes the reading with the account;
 * see `src/credential.ts`.
 *
 * Runtime imports are limited to `pi-tui` (width truncation), which the host
 * provides; nothing here pulls the coding-agent barrel at runtime.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { readConfig, type UsageConfig } from "./src/config.ts";
import {
  resolveUsageCredential,
  type CredentialResolver,
  type UsageCredential,
} from "./src/credential.ts";
import { truncateToWidth } from "./src/format.ts";
import { COMMAND_NAME, PROVIDER_ID, STATUS_KEY } from "./src/identity.ts";
import {
  isMultiproviderService,
  MULTIPROVIDER_SERVICE_EVENT,
  type MultiproviderService,
} from "./src/multiprovider.ts";
import {
  fetchUsage,
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

/** Wires the status widget, `/go-usage`, and the multilogin account listener. */
export function registerOpencodeGoUsage(pi: ExtensionAPI, options: RegisterOptions = {}): void {
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
  /** Latest event ctx, so a late multilogin announcement can still refresh. */
  let lastCtx: ExtensionContext | undefined;

  const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
    if (text === lastStatusText) return;
    lastStatusText = text;
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // A stale ctx after session replacement must not break the turn.
    }
  };

  const setStatusWidget = (ctx: ExtensionContext, parts: UsageSegment[] | undefined): void => {
    if (!parts && !widgetInstalled) return;
    widgetInstalled = parts !== undefined;
    try {
      ctx.ui.setWidget(
        STATUS_KEY,
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
    config.enabled && (!config.onlyOnOpencodeModel || isOpencodeGoModel(ctx));

  const render = (ctx: ExtensionContext): void => {
    if (!eligible(ctx) || config.footerMode === "off") {
      setStatus(ctx, undefined);
      setStatusWidget(ctx, undefined);
      return;
    }

    const segments = cache
      ? usageSegments(cache.snapshot, config, cache.credential.label, now())
      : [];
    let parts: UsageSegment[] | undefined = segments.length > 0 ? segments : undefined;
    // Keep a failed fetch visible as a terse marker instead of a silent gap.
    if (!parts && lastError) parts = [{ text: "Go ?", severity: "muted" }];

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
   * bypasses the OpenCode-Go-only gate, which only an explicit /go-usage should do.
   */
  const refresh = async (
    ctx: ExtensionContext,
    mode: { force?: boolean; ignoreEligibility?: boolean } = {},
  ): Promise<void> => {
    if (!config.enabled) return;
    if (!mode.ignoreEligibility && !eligible(ctx)) return;
    if (!mode.force && authBlockedUntil > now()) return;
    if (!mode.force && cache && now() - cache.fetchedAt < config.refreshIntervalMs) return;
    if (refreshing) return;
    refreshing = true;
    try {
      const credential = await resolveUsageCredential(ctx, { service: () => service, env });
      if (!credential) {
        cache = undefined;
        lastError = `No OpenCode Go credential. Use /login ${PROVIDER_ID} or /multilogin ${PROVIDER_ID}.`;
        render(ctx);
        return;
      }
      // A pooled account switch changes the quota owner; never reuse its reading.
      if (cache && cache.credential.fingerprint !== credential.fingerprint) cache = undefined;
      const snapshot = await fetchUsage(credential, { fetchImpl: options.fetchImpl, now: now() });
      cache = { credential, snapshot, fetchedAt: now() };
      lastError = undefined;
      authBlockedUntil = 0;
      render(ctx);
    } catch (error) {
      const usageError =
        error instanceof UsageError
          ? error
          : new UsageError("transport", error instanceof Error ? error.message : String(error));
      lastError = usageError.message;
      if (usageError.kind === "auth") authBlockedUntil = now() + AUTH_FAILURE_COOLDOWN_MS;
      render(ctx);
    } finally {
      refreshing = false;
    }
  };

  const attachService = (candidate: MultiproviderService): void => {
    if (candidate === service) return;
    unsubscribeAccount?.();
    unsubscribeAccount = undefined;
    service = candidate;
    try {
      unsubscribeAccount = candidate.onActiveAccountChanged(PROVIDER_ID, (event) => {
        // Drop the previous account's numbers, then re-read for the new one.
        cache = undefined;
        authBlockedUntil = 0;
        const ctx = event?.ctx ?? lastCtx;
        if (!ctx) return;
        render(ctx);
        void refresh(ctx, { force: true }).catch(() => undefined);
      });
    } catch {
      unsubscribeAccount = undefined;
    }
    // The announcement can arrive after session_start, so the first reading may
    // have used Pi's own key. Re-read now that the active account is known.
    if (lastCtx) {
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
    config = readConfig(env, ctx.cwd);
    lastCtx = ctx;
    lastStatusText = undefined;
    stopTimer();
    timer = setInterval(() => {
      void refresh(ctx).catch(() => undefined);
    }, config.refreshIntervalMs);
    timer.unref?.();
    void refresh(ctx, { force: true }).catch(() => undefined);
  });

  pi.on("model_select", (_event, ctx) => {
    lastCtx = ctx;
    // Only fetch when the new model can show a reading; otherwise just re-render.
    if (eligible(ctx)) void refresh(ctx, { force: true }).catch(() => undefined);
    else render(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    // Cheap: refresh() returns immediately while the cache is still fresh.
    void refresh(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", () => {
    stopTimer();
    unsubscribeAccount?.();
    unsubscribeAccount = undefined;
    service = undefined;
    lastCtx = undefined;
    cache = undefined;
    lastStatusText = undefined;
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Show OpenCode Go subscription usage (rolling 5h, weekly, monthly)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const explicit = args.trim() === "refresh";
      // The command always re-reads, even off an OpenCode Go model.
      await refresh(ctx, { force: true, ignoreEligibility: true });
      const lines: string[] = [];
      if (cache) {
        lines.push(formatDetail(cache.snapshot, config, cache.credential));
      } else {
        lines.push(`Usage unavailable: ${lastError ?? "not fetched yet"}`);
      }
      if (!config.enabled) {
        lines.push("Display is disabled by the opencode-go-usage.json config.");
      } else if (!eligible(ctx)) {
        lines.push(
          `The reading is hidden for this model; /${COMMAND_NAME} still queries on demand.`,
        );
      }
      if (!explicit) lines.push(`(/${COMMAND_NAME} refresh forces an immediate request)`);
      ctx.ui.notify(lines.join("\n"), cache ? "info" : "warning");
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerOpencodeGoUsage(pi);
}

/** Re-exported for hosts that want to share the resolver. */
export type { CredentialResolver };
