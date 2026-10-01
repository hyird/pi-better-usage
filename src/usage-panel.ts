import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
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
  private wrapped: { width: number; lines: string[] } | undefined;

  constructor(
    private theme: Theme,
    private rows: () => number,
    private repaint: () => void,
    private done: () => void,
    private onClose: () => void = () => {},
  ) {}

  setContent(text: string): void {
    if (this.closed || text === this.text) return;
    this.text = text;
    this.wrapped = undefined;
    this.repaint();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  dispose(): void {
    this.close();
  }
  invalidate(): void {}

  private scrollTo(offset: number): boolean {
    const previous = this.offset;
    this.offset = Math.max(0, Math.min(offset, this.lineCount - this.pageSize));
    return this.offset !== previous;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape")) {
      this.close();
      this.done();
      return;
    }
    let offset = this.offset;
    if (matchesKey(data, "up")) offset -= 1;
    else if (matchesKey(data, "down")) offset += 1;
    else if (matchesKey(data, "pageUp")) offset -= this.pageSize;
    else if (matchesKey(data, "pageDown")) offset += this.pageSize;
    else if (matchesKey(data, "home")) offset = 0;
    else if (matchesKey(data, "end")) offset = this.lineCount;
    else return;
    if (this.scrollTo(offset)) this.repaint();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== "wheel") return;
    // Consume the wheel even at an edge so it cannot scroll the chat behind us.
    return { handled: true, render: this.scrollTo(this.offset + (event.wheelDelta ?? 0)) };
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    if (this.wrapped?.width !== inner) {
      this.wrapped = {
        width: inner,
        lines: this.text
          .split("\n")
          .flatMap((line) => (line ? wrapTextWithAnsi(line, inner) : [""])),
      };
    }
    const lines = this.wrapped.lines;
    this.lineCount = lines.length;
    this.pageSize = Math.max(1, Math.floor(this.rows() * 0.8) - 4);
    this.scrollTo(this.offset);
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
        ? `${this.offset + 1}–${end}/${lines.length} · Wheel / ↑↓ / PgUp PgDn · Esc close`
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
  load: (signal: AbortSignal) => Promise<string>,
): Promise<void> {
  const controller = new AbortController();
  const terminal = ctx.mode === "tui";
  if (!terminal) {
    let report: string;
    try {
      report = await load(controller.signal);
    } catch {
      ctx.ui.notify("Could not load usage. Try /usage again.", "warning");
      return;
    }
    ctx.ui.notify(report, "info");
    return;
  }
  let activePanel: UsagePanel | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keys, done) => {
        const panel = new UsagePanel(
          theme,
          () => tui.terminal.rows,
          () => tui.requestRender(),
          () => done(),
          () => controller.abort(),
        );
        activePanel = panel;
        // Display immediately, so Esc also works while network requests are pending.
        void Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return load(controller.signal);
          })
          .then(
            (text) => panel.setContent(text),
            () => panel.setContent("Could not load usage. Close this panel and try /usage again."),
          );
        return panel;
      },
      { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } },
    );
  } finally {
    // Pi may reject overlay initialization before it can dispose the component.
    controller.abort();
    activePanel?.dispose();
  }
}
