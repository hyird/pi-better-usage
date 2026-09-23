import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** A scrollable, transient report. Closing it never appends content to chat. */
export class UsagePanel {
  private text = "Loading usage…";
  private offset = 0;
  private pageSize = 1;
  private lineCount = 1;
  private closed = false;

  constructor(
    private theme: Theme,
    private rows: () => number,
    private repaint: () => void,
    private done: () => void,
  ) {}

  setContent(text: string): void {
    if (this.closed) return;
    this.text = text;
    this.repaint();
  }

  dispose(): void {
    this.closed = true;
  }
  invalidate(): void {}

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape")) {
      this.closed = true;
      this.done();
      return;
    }
    if (matchesKey(data, "up")) this.offset -= 1;
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageUp")) this.offset -= this.pageSize;
    else if (matchesKey(data, "pageDown")) this.offset += this.pageSize;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = this.lineCount;
    else return;
    this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize));
    this.repaint();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const lines = this.text
      .split("\n")
      .flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""]));
    this.lineCount = lines.length;
    this.pageSize = Math.max(1, Math.floor(this.rows() * 0.8) - 4);
    this.offset = Math.max(0, Math.min(this.offset, this.lineCount - this.pageSize));
    const frame = (text: string): string => {
      const clipped = truncateToWidth(text, inner);
      return truncateToWidth(
        this.theme.fg("border", "│ ") +
          clipped +
          " ".repeat(Math.max(0, inner - visibleWidth(clipped))) +
          this.theme.fg("border", " │"),
        width,
      );
    };
    const border = (left: string, right: string): string =>
      this.theme.fg(
        "border",
        truncateToWidth(left + "─".repeat(Math.max(0, width - 2)) + right, width),
      );
    const end = Math.min(lines.length, this.offset + this.pageSize);
    const hint =
      lines.length > this.pageSize
        ? `Esc close · ↑↓ / PgUp PgDn scroll · ${this.offset + 1}–${end}/${lines.length}`
        : "Esc close";
    return [
      frame(this.theme.fg("accent", "Subscription usage")),
      border("├", "┤"),
      ...lines.slice(this.offset, end).map(frame),
      frame(this.theme.fg("dim", hint)),
      border("╰", "╯"),
    ];
  }
}

export async function showUsagePanel(
  ctx: ExtensionContext,
  load: () => Promise<string>,
): Promise<void> {
  const terminal = ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
  if (!terminal) {
    ctx.ui.notify(await load(), "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) => {
      const panel = new UsagePanel(
        theme,
        () => tui.terminal.rows,
        () => tui.requestRender(),
        () => done(),
      );
      // Display immediately, so Esc also works while network requests are pending.
      void Promise.resolve()
        .then(load)
        .then(
          (text) => panel.setContent(text),
          () => panel.setContent("Could not load usage. Close this panel and try /usage again."),
        );
      return panel;
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
  );
}
