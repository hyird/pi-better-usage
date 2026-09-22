export const EXTENSION_NAME = "pi-better-opencode-go";

/** Global config lives at `~/.pi/agent/extensions/<CONFIG_BASENAME>`. */
export const CONFIG_BASENAME = "opencode-go-usage.json";

/** Key for both the status line and the below-editor widget. */
export const STATUS_KEY = "opencode-go-usage";

export const COMMAND_NAME = "go-usage";

export const PROVIDER_ID = "opencode-go";

export const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export const API_KEY_ENV_VAR = "OPENCODE_API_KEY";

/** Usage windows reported by the endpoint, in display order. */
export const WINDOW_KEYS = ["rolling", "weekly", "monthly"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];

/** Compact token used inside the widget line. */
export const WINDOW_LABELS: Record<WindowKey, string> = {
  rolling: "5h",
  weekly: "wk",
  monthly: "mo",
};

/** Spelled-out name used by the `/go-usage` report. */
export const WINDOW_NAMES: Record<WindowKey, string> = {
  rolling: "5h rolling",
  weekly: "week",
  monthly: "month",
};

export function logPrefix(): string {
  return `[${EXTENSION_NAME}]`;
}
