import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import * as tui from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { showUsagePanel, UsagePanel } from "../src/usage-panel.ts";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return { ...actual, wrapTextWithAnsi: vi.fn(actual.wrapTextWithAnsi) };
});

const theme = { fg: (_color: string, value: string) => value } as Theme;

const wheel = (wheelDelta?: number): TuiMouseEvent => ({
  type: "wheel",
  button: "none",
  x: 5,
  y: 4,
  screenX: 10,
  screenY: 7,
  width: 60,
  height: 12,
  shift: false,
  alt: false,
  ctrl: false,
  wheelDelta,
});

it("scrolls with the wheel in both directions and consumes events at report edges", () => {
  const panel = new UsagePanel(theme, () => 15, vi.fn(), vi.fn());
  panel.setContent(Array.from({ length: 50 }, (_, i) => `Account ${i}`).join("\n"));
  expect(panel.render(60).join("\n")).toContain("1–8/50");
  expect(panel.handleMouse(wheel(3))).toEqual({ handled: true, render: true });
  expect(panel.render(60)[2]).toContain("Account 3");
  expect(panel.handleMouse(wheel(-2))).toEqual({ handled: true, render: true });
  expect(panel.render(60)[2]).toContain("Account 1");
  expect(panel.handleMouse(wheel(500))).toEqual({ handled: true, render: true });
  const bottom = panel.render(60);
  expect(bottom.join("\n")).toContain("Account 49");
  expect(bottom.join("\n")).toContain("43–50/50");
  expect(panel.handleMouse(wheel(1))).toEqual({ handled: true, render: false });
  expect(panel.render(60)).toEqual(bottom);
  expect(panel.handleMouse(wheel(-500))).toEqual({ handled: true, render: true });
  expect(panel.render(60)[2]).toContain("Account 0");
  expect(panel.handleMouse(wheel(-1))).toEqual({ handled: true, render: false });
  expect(panel.handleMouse(wheel())).toEqual({ handled: true, render: false });
});

it("consumes wheel events on short reports and ignores other mouse events or a closed panel", () => {
  const repaint = vi.fn();
  const panel = new UsagePanel(theme, () => 15, repaint, vi.fn());
  const loading = panel.render(60);
  expect(panel.handleMouse(wheel(3))).toEqual({ handled: true, render: false });
  expect(panel.handleMouse({ ...wheel(), type: "click" })).toBeUndefined();
  expect(panel.render(60)).toEqual(loading);
  panel.setContent("Short report");
  const report = panel.render(60);
  expect(panel.handleMouse(wheel(-3))).toEqual({ handled: true, render: false });
  expect(panel.render(60)).toEqual(report);
  repaint.mockClear();
  panel.handleInput("\u001b");
  expect(panel.handleMouse(wheel(3))).toBeUndefined();
  expect(repaint).not.toHaveBeenCalled();
});

it("shares the scroll position between the wheel and keyboard without repainting at an edge", () => {
  const repaint = vi.fn();
  const panel = new UsagePanel(theme, () => 15, repaint, vi.fn());
  panel.setContent(Array.from({ length: 50 }, (_, i) => `Account ${i}`).join("\n"));
  panel.render(60);
  panel.handleMouse(wheel(3));
  panel.handleInput("\u001b[6~");
  expect(panel.render(60)[2]).toContain("Account 11");
  panel.handleInput("\u001b[5~");
  expect(panel.render(60)[2]).toContain("Account 3");
  panel.handleInput("\u001b[H");
  expect(panel.render(60)[2]).toContain("Account 0");
  repaint.mockClear();
  panel.handleInput("\u001b[A");
  expect(repaint).not.toHaveBeenCalled();
});

it("wraps only when content or width changes, not on scrolling or height changes", () => {
  const wrap = vi.mocked(tui.wrapTextWithAnsi);
  wrap.mockClear();
  const repaint = vi.fn();
  let rows = 20;
  const panel = new UsagePanel(theme, () => rows, repaint, vi.fn());
  try {
    const content = Array.from(
      { length: 50 },
      (_, i) => `Account ${i} ${"long report ".repeat(5)}`,
    ).join("\n");
    panel.setContent(content);
    panel.render(60);
    const first = wrap.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      panel.handleInput("\u001b[B");
      panel.render(60);
    }
    rows = 10;
    panel.render(60);
    expect(wrap).toHaveBeenCalledTimes(first);
    const paints = repaint.mock.calls.length;
    panel.setContent(content);
    expect(repaint).toHaveBeenCalledTimes(paints);
    panel.render(30);
    expect(wrap.mock.calls.length).toBeGreaterThan(first);
    panel.setContent("Changed report");
    expect(panel.render(30).join("\n")).toContain("Changed report");
  } finally {
    wrap.mockClear();
  }
});

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

it.each(["escape", "host failure"])("cancels its pending load after %s", async (closing) => {
  let component!: UsagePanel;
  let loadingSignal: AbortSignal | undefined;
  let fail!: () => void;
  const custom = vi.fn(
    (factory) =>
      new Promise<void>((resolve, reject) => {
        fail = () => reject(new Error("Overlay initialization failed"));
        component = factory({ terminal: { rows: 30 }, requestRender: vi.fn() }, theme, {}, resolve);
      }),
  );
  const ctx = { mode: "tui", ui: { custom, notify: vi.fn() } } as unknown as ExtensionContext;
  const task = showUsagePanel(ctx, async (signal) => {
    loadingSignal = signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "late result";
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(loadingSignal?.aborted).toBe(false);
  if (closing === "escape") {
    component.handleInput("\u001b");
    await task;
  } else {
    fail();
    await expect(task).rejects.toThrow("Overlay initialization failed");
  }
  expect(loadingSignal?.aborted).toBe(true);
});

it.each(["rpc", "json", "print"])(
  "keeps text output in %s mode even when a UI capability is present",
  async (mode) => {
    const notify = vi.fn();
    const custom = vi.fn();
    await showUsagePanel(
      { mode, hasUI: true, ui: { custom, notify } } as unknown as ExtensionContext,
      async () => "usage report",
    );
    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("usage report", "info");
  },
);

it("reports load failures to RPC clients without rejecting the command", async () => {
  const notify = vi.fn();
  await expect(
    showUsagePanel({ mode: "rpc", ui: { notify } } as unknown as ExtensionContext, async () => {
      throw new Error("secret upstream error");
    }),
  ).resolves.toBeUndefined();
  expect(notify).toHaveBeenCalledWith("Could not load usage. Try /usage again.", "warning");
});
