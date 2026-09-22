import { readFileSync } from "node:fs";
import { WINDOW_KEYS, type WindowKey } from "./identity.ts";
import { globalConfigPath, projectConfigPath } from "./paths.ts";

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
export const MIN_REFRESH_INTERVAL_MS = 15_000;
export const MAX_REFRESH_INTERVAL_MS = 3_600_000;

/**
 * Where the reading renders. Mirrors pi-better-grok's `footer.mode`, minus its
 * `replace` because this extension does not own the session footer.
 */
export type FooterMode = "widget" | "status" | "off";

const FOOTER_MODES: readonly FooterMode[] = ["widget", "status", "off"];

function isFooterMode(value: unknown): value is FooterMode {
  return typeof value === "string" && (FOOTER_MODES as readonly string[]).includes(value);
}

export type UsageConfig = {
  enabled: boolean;
  /** Windows shown in the widget and in the detail report. */
  windows: WindowKey[];
  refreshIntervalMs: number;
  /** Only show usage while the selected model belongs to OpenCode Go. */
  onlyOnOpencodeModel: boolean;
  /** Append the active pooled account label to the reading. */
  showAccountLabel: boolean;
  /** `widget`: coloured line below the editor, matching Grok. `status`: plain text in Pi's footer. */
  footerMode: FooterMode;
};

export const DEFAULT_CONFIG: UsageConfig = {
  enabled: true,
  windows: [...WINDOW_KEYS],
  refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
  onlyOnOpencodeModel: true,
  showAccountLabel: true,
  footerMode: "widget",
};

/** The flat `footerMode` key. */
function parseFooterMode(value: unknown): FooterMode | undefined {
  return isFooterMode(value) ? value : undefined;
}

/**
 * pi-better-grok's `footer` object.
 *
 * Grok's `status` renders the same below-editor widget this extension calls
 * `widget`, so it maps there to keep a copied grok config visually identical.
 * Grok's `replace` installs a whole custom footer this extension does not own,
 * so it degrades to `status` — the reading in Pi's own footer.
 */
function parseGrokFooter(value: unknown): FooterMode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const mode = (value as { mode?: unknown }).mode;
  if (mode === "status") return "widget";
  if (mode === "replace") return "status";
  return isFooterMode(mode) ? mode : undefined;
}

function clampInterval(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(value)));
}

function parseWindowList(value: unknown): WindowKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const requested = value.filter(
    (entry): entry is WindowKey =>
      typeof entry === "string" && (WINDOW_KEYS as readonly string[]).includes(entry),
  );
  // Preserve endpoint order and drop duplicates; an empty list disables display.
  return WINDOW_KEYS.filter((key) => requested.includes(key));
}

/** Applies a partial config over `base`, ignoring unknown or invalid fields. */
export function normalizeConfig(raw: unknown, base: UsageConfig = DEFAULT_CONFIG): UsageConfig {
  const config: UsageConfig = { ...base, windows: [...base.windows] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled === "boolean") config.enabled = input.enabled;
  const windows = parseWindowList(input.windows);
  if (windows) config.windows = windows;
  const interval = clampInterval(input.refreshIntervalMs);
  if (interval !== undefined) config.refreshIntervalMs = interval;
  if (typeof input.onlyOnOpencodeModel === "boolean") {
    config.onlyOnOpencodeModel = input.onlyOnOpencodeModel;
  }
  if (typeof input.showAccountLabel === "boolean") config.showAccountLabel = input.showAccountLabel;
  const footerMode = parseFooterMode(input.footerMode) ?? parseGrokFooter(input.footer);
  if (footerMode) config.footerMode = footerMode;
  return config;
}

/** Returns the parsed JSON, or undefined for a missing/corrupt/unreadable file. */
function readConfigFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Global config first, then the project config layered over it. Every field has a
 * default and invalid values are ignored, so a broken config never breaks the
 * reading.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): UsageConfig {
  let config = normalizeConfig(readConfigFile(globalConfigPath(env)));
  if (cwd) config = normalizeConfig(readConfigFile(projectConfigPath(cwd)), config);
  return config;
}
