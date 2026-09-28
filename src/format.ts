import { truncateToWidth as truncateTerminalText } from "@earendil-works/pi-tui";

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
 * them on one line without terminal controls, preserving the complete label.
 */
export function sanitizeLabel(label: string): string | undefined {
  const flattened = Array.from(label, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }).join("");
  const trimmed = flattened.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed;
}
