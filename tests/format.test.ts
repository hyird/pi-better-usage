import { describe, expect, it } from "vitest";
import { clampPercent, formatPercent, sanitizeLabel, truncateToWidth } from "../src/format.ts";

describe("clampPercent", () => {
  it("keeps values inside 0..100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(42.5)).toBe(42.5);
    expect(clampPercent(100)).toBe(100);
    expect(clampPercent(140)).toBe(100);
  });
});

describe("formatPercent", () => {
  it("rounds to whole percentages", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(96.4)).toBe("96%");
    expect(formatPercent(96.5)).toBe("97%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("clamps before formatting", () => {
    expect(formatPercent(-1)).toBe("0%");
    expect(formatPercent(101)).toBe("100%");
  });
});

describe("sanitizeLabel", () => {
  it("keeps an ordinary label", () => {
    expect(sanitizeLabel("zhong")).toBe("zhong");
  });

  it("flattens control characters and newlines", () => {
    expect(sanitizeLabel("zh\nong\u0007")).toBe("zh ong");
    expect(sanitizeLabel("a\tb")).toBe("a b");
    expect(sanitizeLabel("del\u007fchar")).toBe("del char");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(sanitizeLabel("  a   b  ")).toBe("a b");
  });

  it("drops a blank label", () => {
    expect(sanitizeLabel("   ")).toBeUndefined();
    expect(sanitizeLabel("\n\t")).toBeUndefined();
  });

  it("elides a label that would dominate the line", () => {
    const elided = sanitizeLabel("x".repeat(40));
    expect(elided).toBe(`${"x".repeat(23)}…`);
    expect(elided?.length).toBe(24);
  });
});

describe("truncateToWidth", () => {
  /** pi-tui appends SGR resets, so compare visible characters, not bytes. */
  // oxlint-disable-next-line no-control-regex -- an ANSI SGR sequence starts with ESC.
  const stripAnsi = (value: string) => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");

  it("leaves short text alone", () => {
    expect(truncateToWidth("Usage: ok", 40)).toBe("Usage: ok");
  });

  it("cuts long text to the width", () => {
    const visible = stripAnsi(truncateToWidth("Usage: 5h 97% left · wk 99% left", 20));
    expect(visible.endsWith("...")).toBe(true);
    expect(visible.length).toBeLessThanOrEqual(20);
    expect(visible).toContain("Usage: ");
  });
});
