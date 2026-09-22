import { truncateToWidth as truncateTerminalText } from "@earendil-works/pi-tui";

/** Longest pooled account label kept verbatim before it is elided. */
const MAX_LABEL_LENGTH = 24;

/** Keeps the widget on one line when the terminal is narrower than the reading. */
export function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  return truncateTerminalText(value, width, ellipsis);
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

/**
 * Pooled account labels come from pi-multiprovider rather than from us, so keep
 * them to a single short line before they reach the terminal.
 */
export function sanitizeLabel(label: string): string | undefined {
  const flattened = Array.from(label, (char) =>
    char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char,
  ).join("");
  const trimmed = flattened.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…` : trimmed;
}
