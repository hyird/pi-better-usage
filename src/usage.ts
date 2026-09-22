import type { UsageConfig } from "./config.ts";
import type { UsageCredential } from "./credential.ts";
import { clampPercent, formatPercent, sanitizeLabel } from "./format.ts";
import { USAGE_URL, WINDOW_LABELS, WINDOW_NAMES, type WindowKey } from "./identity.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_STATUS_LENGTH = 32;
const MAX_RESET_LENGTH = 64;
const MAX_RESET_MS = 400 * 24 * 60 * 60_000;

export type UsageWindow = {
  label?: string;
  /** Raw endpoint status; anything other than "ok" is surfaced to the user. */
  status: string;
  percentUsed: number;
  /** Reset instant in epoch milliseconds, or null when absent or unparseable. */
  resetsAt: number | null;
};

export type UsageSnapshot = {
  capturedAt: number;
  providerLabel?: string;
  windows: Partial<Record<WindowKey, UsageWindow>>;
};

export type UsageErrorKind = "auth" | "http" | "invalid" | "oversize" | "transport";

export class UsageError extends Error {
  readonly kind: UsageErrorKind;
  readonly status?: number;

  constructor(kind: UsageErrorKind, message: string, status?: number) {
    super(message);
    this.name = "UsageError";
    this.kind = kind;
    this.status = status;
  }
}

/* ----------------------------------------------------------------- parser -- */

function boundedStatus(value: unknown): string {
  if (typeof value !== "string") return "ok";
  const status = value.trim();
  if (!status || status.length > MAX_STATUS_LENGTH) return "ok";
  for (const char of status) {
    const code = char.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return "ok";
  }
  return status;
}

function boundedReset(value: unknown, now: number): number | null {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_RESET_LENGTH) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Reject absurd horizons instead of rendering a meaningless countdown.
  if (parsed < now - MAX_RESET_MS || parsed > now + MAX_RESET_MS) return null;
  return parsed;
}

/**
 * Parses the usage payload. Unknown windows are ignored; a payload without a
 * single usable window is an error so the widget never shows invented data.
 */
export function parseUsagePayload(data: unknown, now = Date.now()): UsageSnapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new UsageError("invalid", "OpenCode Go usage returned an invalid response.");
  }
  const usage = (data as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new UsageError("invalid", "OpenCode Go usage response has no usage object.");
  }
  const windows: Partial<Record<WindowKey, UsageWindow>> = {};
  for (const key of Object.keys(WINDOW_LABELS) as WindowKey[]) {
    const raw = (usage as Record<string, unknown>)[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown };
    if (typeof record.percent !== "number" || !Number.isFinite(record.percent)) continue;
    windows[key] = {
      status: boundedStatus(record.status),
      percentUsed: clampPercent(record.percent),
      resetsAt: boundedReset(record.resetsAt, now),
    };
  }
  if (Object.keys(windows).length === 0) {
    throw new UsageError("invalid", "OpenCode Go usage response contained no usable window.");
  }
  return { capturedAt: now, windows };
}

/* ------------------------------------------------------------------ fetch -- */

function httpError(status: number): UsageError {
  if (status === 401 || status === 403) {
    return new UsageError(
      "auth",
      "OpenCode Go rejected the API key. Use /login opencode-go, or /multilogin opencode-go to add an account.",
      status,
    );
  }
  if (status === 429) {
    return new UsageError("http", "OpenCode Go usage is rate limited. Try again later.", status);
  }
  return new UsageError("http", `OpenCode Go usage request failed with status ${status}.`, status);
}

export type UsageResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
};

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "error" },
) => Promise<UsageResponse>;

export async function fetchUsage(
  credential: UsageCredential,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike; now?: number } = {},
): Promise<UsageSnapshot> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: UsageResponse;
  try {
    response = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: "application/json" },
      signal,
      redirect: "error",
    });
  } catch {
    throw new UsageError("transport", "OpenCode Go usage request failed or timed out.");
  }
  if (!response.ok) throw httpError(response.status);

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new UsageError("oversize", "OpenCode Go usage returned an oversized response.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UsageError("invalid", "OpenCode Go usage returned an invalid body.");
  }
  return parseUsagePayload(payload, options.now ?? Date.now());
}

/* ------------------------------------------------------------ formatting :: -- */

export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.round(msRemaining / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total % 60}s`;
}

/** One local-time, 24-hour format for every provider, reset and capture time. */
export function formatClock(instant: number, _now = Date.now()): string {
  const date = new Date(instant);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Credential source names are internal metadata, not account labels. */
export function accountLabel(credential: UsageCredential): string | undefined {
  return credential.source === "multilogin" ? sanitizeLabel(credential.label) : undefined;
}

/** The window closest to its limit drives the countdown shown in the widget. */
export function constrainingWindow(
  snapshot: UsageSnapshot,
  windows: readonly WindowKey[],
): { key: WindowKey; window: UsageWindow } | undefined {
  let best: { key: WindowKey; window: UsageWindow } | undefined;
  for (const key of windows) {
    const window = snapshot.windows[key];
    if (!window) continue;
    if (!best || window.percentUsed > best.window.percentUsed) best = { key, window };
  }
  return best;
}

/**
 * Severity drives the colour of a percentage. Ported from pi-better-grok so the
 * two plugins read the same at a glance.
 */
export type UsageSeverity = "ok" | "warning" | "critical" | "muted";

export type UsageSegment = {
  text: string;
  severity: UsageSeverity;
};

/** Remaining budget at or below these thresholds turns the percentage amber/red. */
const WARNING_LEFT_PERCENT = 30;
const CRITICAL_LEFT_PERCENT = 10;

/** The endpoint reports "used"; the widget leads with what is left. */
export function leftPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

export function severityForLeftPercent(percent: number): UsageSeverity {
  if (percent <= CRITICAL_LEFT_PERCENT) return "critical";
  if (percent <= WARNING_LEFT_PERCENT) return "warning";
  return "ok";
}

/**
 * Coloured segments behind the widget, e.g.
 * `Usage: 5h 97% left · wk 99% left · mo 99% left · ↺ 2h3m - 09-22 17:34 · zhong`.
 * Percentages are what is left of each window; the reset clock comes from the
 * window closest to its limit.
 */
export function usageSegments(
  snapshot: UsageSnapshot,
  config: UsageConfig,
  label?: string,
  now = Date.now(),
): UsageSegment[] {
  const segments: UsageSegment[] = [{ text: "Usage: ", severity: "muted" }];
  let shown = 0;
  for (const key of config.windows) {
    const window = snapshot.windows[key];
    if (!window) continue;
    if (shown > 0) segments.push({ text: " · ", severity: "muted" });
    const left = leftPercent(window.percentUsed);
    segments.push({ text: `${window.label ?? WINDOW_LABELS[key]} `, severity: "muted" });
    segments.push({ text: formatPercent(left), severity: severityForLeftPercent(left) });
    segments.push({ text: " left", severity: "muted" });
    // A non-ok window would otherwise be invisible behind a healthy percentage.
    if (window.status !== "ok") segments.push({ text: ` !${window.status}`, severity: "warning" });
    shown += 1;
  }
  if (shown === 0) return [];

  const resetsAt = constrainingWindow(snapshot, config.windows)?.window.resetsAt;
  if (resetsAt != null) {
    segments.push({
      text: ` · ↺ ${formatCountdown(resetsAt - now)} - ${formatClock(resetsAt, now)}`,
      severity: "muted",
    });
  }

  const account = config.showAccountLabel && label ? sanitizeLabel(label) : undefined;
  if (account) segments.push({ text: ` · ${account}`, severity: "muted" });
  return segments;
}

/** Flat text form of {@link usageSegments}, used by the status-line footer mode. */
export function formatStatusLine(
  snapshot: UsageSnapshot,
  config: UsageConfig,
  label?: string,
  now = Date.now(),
): string | undefined {
  const segments = usageSegments(snapshot, config, label, now);
  return segments.length > 0 ? segments.map((segment) => segment.text).join("") : undefined;
}

/** Multi-line report behind `/usage`. */
export function formatDetail(
  snapshot: UsageSnapshot,
  config: UsageConfig,
  credential: UsageCredential,
  now = Date.now(),
  colorize?: (severity: UsageSeverity, text: string) => string,
): string {
  const account = config.showAccountLabel ? accountLabel(credential) : undefined;
  const lines = [
    `${snapshot.providerLabel ?? "OpenCode Go"} usage${account ? ` — account: ${account}` : ""}`,
  ];
  for (const key of config.windows) {
    const window = snapshot.windows[key];
    if (!window) continue;
    const status = window.status === "ok" ? "" : ` · ${window.status}`;
    const remaining = leftPercent(window.percentUsed);
    const filled = Math.round(remaining / 5);
    const meter = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${formatPercent(remaining)} left`;
    const coloredMeter = colorize ? colorize(severityForLeftPercent(remaining), meter) : meter;
    lines.push(
      `${window.label ?? WINDOW_NAMES[key]}: ${coloredMeter} · ${Math.round(window.percentUsed)}% used${status}`,
    );
    if (window.resetsAt != null) {
      lines.push(
        `  Resets: ${formatClock(window.resetsAt, now)} · in ${formatCountdown(window.resetsAt - now)}`,
      );
    }
  }
  lines.push(`Captured: ${formatClock(snapshot.capturedAt)}`);
  return lines.join("\n");
}
