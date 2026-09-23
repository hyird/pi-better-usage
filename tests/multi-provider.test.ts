import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { registerUsage } from "../index.ts";
import { GROK_USER_URL, OPENAI_USAGE_URL } from "../src/providers.ts";
import type { FetchLike } from "../src/usage.ts";
import type { UsagePanel } from "../src/usage-panel.ts";
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
function harness(disabled = false, fetchOverride?: FetchLike) {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-multi-"));
  const jwt = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.s`;
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", access: jwt },
      xai: { type: "oauth", access: "grok-token" },
    }),
  );
  if (disabled) {
    mkdirSync(join(dir, "extensions"));
    writeFileSync(
      join(dir, "extensions", "pi-better-usage.json"),
      JSON.stringify({ enabled: false }),
    );
  }
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<
    string,
    { handler(args: string, ctx: ExtensionContext): Promise<void> }
  >();
  const widgets = new Map<string, unknown>();
  const notify = vi.fn();
  const panelReports: string[] = [];
  const ctx = {
    cwd: dir,
    mode: "tui",
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.4" },
    modelRegistry: {},
    ui: {
      setStatus() {},
      setWidget: (key: string, content: unknown) => widgets.set(key, content),
      notify,
      custom: (
        factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => UsagePanel,
      ) =>
        new Promise<void>((resolve) => {
          const panel = factory(
            {
              terminal: { rows: 200 },
              requestRender: () => {
                panelReports.push(panel.render(140).join("\n"));
                panel.handleInput("\u001b");
              },
            },
            { fg: (_color: string, text: string) => text },
            {},
            resolve,
          );
        }),
    },
  } as unknown as ExtensionContext;
  const pi = {
    events: { on() {}, emit() {} },
    on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand: (name: string, command: never) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  const fetchImpl = vi.fn<FetchLike>(
    fetchOverride ??
      (async (url) => {
        const body =
          url === OPENAI_USAGE_URL
            ? { rate_limit: { primary_window: { used_percent: 25 } } }
            : url === GROK_USER_URL
              ? { userId: "user" }
              : url.includes("grok.com")
                ? { config: { creditUsagePercent: 40, currentPeriod: { type: "WEEKLY" } } }
                : { usage: { weekly: { percent: 60 } } };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
      }),
  );
  registerUsage(pi, {
    env: {
      PI_CODING_AGENT_DIR: dir,
      PI_GROK_AUTH_PATH: join(dir, "missing"),
      OPENCODE_API_KEY: "go-token",
    },
    fetchImpl,
  });
  const emit = (name: string) => handlers.get(name)?.forEach((fn) => fn({ model: ctx.model }, ctx));
  cleanups.push(() => {
    emit("session_shutdown");
    rmSync(dir, { recursive: true, force: true });
  });
  return { ctx, emit, fetchImpl, commands, widgets, notify, panelReports };
}
it("registers only /usage and polls only the active provider", async () => {
  const h = harness();
  h.emit("session_start");
  await flush();
  expect([...h.commands.keys()]).toEqual(["usage"]);
  expect(h.fetchImpl.mock.calls.map(([url]) => url)).toEqual([OPENAI_USAGE_URL]);
  expect(h.widgets.get("pi-better-usage-openai")).toBeTypeOf("function");
  h.ctx.model = { ...h.ctx.model!, provider: "xai" };
  h.emit("model_select");
  expect(h.widgets.get("pi-better-usage-openai")).toBeUndefined();
  await flush();
  expect(h.widgets.get("pi-better-usage-grok")).toBeTypeOf("function");
});
it("queries all providers on demand, even when automatic display is disabled", async () => {
  const h = harness(true);
  h.emit("session_start");
  await flush();
  expect(h.fetchImpl).not.toHaveBeenCalled();
  await h.commands.get("usage")!.handler("", h.ctx);
  expect(h.notify).not.toHaveBeenCalled();
  const report = h.panelReports.at(-1);
  expect(report).toContain("OpenAI Codex usage");
  expect(report).toContain("75% left");
  expect(report).toContain("Grok usage");
  expect(report).toContain("60% left");
  expect(report).toContain("OpenCode Go usage");
  expect(report).toContain("40% left");
  expect([...h.widgets.values()].filter(Boolean)).toHaveLength(0);
});

it("shows each provider's own cached quota immediately when switching providers", async () => {
  const h = harness();
  h.emit("session_start");
  await flush();
  await h.commands.get("usage")!.handler("", h.ctx);
  const pending: (() => void)[] = [];
  h.fetchImpl.mockImplementation(async (url) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        url === GROK_USER_URL
          ? { userId: "test" }
          : url.includes("grok.com")
            ? { config: { creditUsagePercent: 40 } }
            : url === OPENAI_USAGE_URL
              ? { rate_limit: { primary_window: { used_percent: 25 } } }
              : { usage: { weekly: { percent: 60 } } },
    };
  });
  for (const [provider, key, left] of [
    ["xai", "grok", "60%"],
    ["opencode-go", "opencode", "40%"],
    ["openai-codex", "openai", "75%"],
  ]) {
    h.ctx.model = { ...h.ctx.model!, provider: provider! };
    h.emit("model_select");
    const widget = h.widgets.get(`pi-better-usage-${key}`) as (
      _tui: unknown,
      theme: unknown,
    ) => { render(width: number): string[] };
    expect(widget).toBeTypeOf("function");
    expect(
      widget(undefined, { fg: (_color: string, text: string) => text }).render(200)[0],
    ).toContain(left);
    for (const other of ["openai", "grok", "opencode"].filter((id) => id !== key)) {
      expect(h.widgets.get(`pi-better-usage-${other}`)).toBeUndefined();
    }
    await flush();
  }
  h.emit("session_shutdown");
  pending.forEach((resolve) => resolve());
  await flush();
  pending.forEach((resolve) => resolve());
  await flush();
});

it("does not reuse default Codex quota for Spark, even with the same account", async () => {
  const h = harness();
  h.emit("session_start");
  await flush();
  h.ctx.model = { ...h.ctx.model!, id: "gpt-5.3-codex-spark" };
  h.emit("model_select");
  expect(h.widgets.get("pi-better-usage-openai")).toBeUndefined();
  await flush();
  // Fixture has no Spark bucket: default quota must not reappear.
  expect(h.widgets.get("pi-better-usage-openai")).toBeUndefined();
});
it("keeps other provider results when one provider rejects authentication", async () => {
  const h = harness(false, async (url) => ({
    ok: url !== OPENAI_USAGE_URL,
    status: url === OPENAI_USAGE_URL ? 401 : 200,
    headers: { get: () => null },
    json: async () =>
      url === GROK_USER_URL
        ? { userId: "test" }
        : url.includes("grok.com")
          ? { config: { creditUsagePercent: 10 } }
          : { usage: { rolling: { percent: 20 } } },
  }));
  await h.commands.get("usage")!.handler("", h.ctx);
  expect(h.notify).not.toHaveBeenCalled();
  const report = h.panelReports.at(-1);
  expect(report).toContain("authentication was rejected");
  expect(report).toContain("90% left");
  expect(report).toContain("80% left");
});
it("does not resurrect a late OpenAI response after switching to Grok", async () => {
  let release!: () => void;
  const h = harness(false, async (url) => {
    if (url === OPENAI_USAGE_URL)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        url === OPENAI_USAGE_URL
          ? { rate_limit: { primary_window: { used_percent: 99 } } }
          : url === GROK_USER_URL
            ? { userId: "test" }
            : { config: { creditUsagePercent: 20 } },
    };
  });
  h.emit("session_start");
  await flush();
  h.ctx.model = { ...h.ctx.model!, provider: "xai" };
  h.emit("model_select");
  await flush();
  release();
  await flush();
  expect(h.widgets.get("pi-better-usage-openai")).toBeUndefined();
  expect(h.widgets.get("pi-better-usage-grok")).toBeTypeOf("function");
});
