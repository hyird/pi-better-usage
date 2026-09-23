import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { showUsagePanel, UsagePanel } from "../src/usage-panel.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;

it("scrolls through long reports and stays inside the terminal on resize", () => {
  let rows = 15;
  const panel = new UsagePanel(theme, () => rows, vi.fn(), vi.fn());
  panel.setContent(
    Array.from({ length: 50 }, (_, i) => `Account ${i}: ${"long report ".repeat(5)}`).join("\n"),
  );
  let rendered = panel.render(60);
  expect(rendered.length).toBeLessThanOrEqual(12);
  expect(rendered.every((line) => visibleWidth(line) <= 60)).toBe(true);
  expect(rendered.join("\n")).toContain("Account 0");
  panel.handleInput("\u001b[F");
  expect(panel.render(60).join("\n")).toContain("Account 49");
  rows = 10;
  rendered = panel.render(25);
  expect(rendered.length).toBeLessThanOrEqual(8);
  expect(rendered.every((line) => visibleWidth(line) <= 25)).toBe(true);
  panel.handleInput("\u001b[H");
  expect(panel.render(25).join("\n")).toContain("Account 0");
});

it("closes during loading and ignores late updates", () => {
  const done = vi.fn();
  const repaint = vi.fn();
  const panel = new UsagePanel(theme, () => 30, repaint, done);
  expect(panel.render(80).join("\n")).toContain("Loading usage");
  panel.handleInput("\u001b");
  panel.handleInput("\u001b");
  panel.setContent("late account result");
  expect(done).toHaveBeenCalledTimes(1);
  expect(repaint).not.toHaveBeenCalled();
});

it("opens a focused overlay immediately, without printing to chat", async () => {
  let component!: UsagePanel;
  let release!: (text: string) => void;
  const notify = vi.fn();
  const repaint = vi.fn();
  const custom = vi.fn(
    (factory) =>
      new Promise<void>((resolve) => {
        component = factory({ terminal: { rows: 30 }, requestRender: repaint }, theme, {}, resolve);
      }),
  );
  const ctx = { mode: "tui", ui: { custom, notify } } as unknown as ExtensionContext;
  const loading = new Promise<string>((resolve) => {
    release = resolve;
  });
  const task = showUsagePanel(ctx, () => loading);
  expect(custom).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ overlay: true }),
  );
  expect(component.render(80).join("\n")).toContain("Loading usage");
  component.handleInput("\u001b");
  await task;
  release("finished after close");
  await loading;
  await Promise.resolve();
  await Promise.resolve();
  expect(repaint).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("keeps text output for RPC clients that cannot display a terminal panel", async () => {
  const notify = vi.fn();
  const custom = vi.fn();
  await showUsagePanel(
    { mode: "rpc", ui: { custom, notify } } as unknown as ExtensionContext,
    async () => "usage report",
  );
  expect(custom).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith("usage report", "info");
});
