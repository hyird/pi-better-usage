import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension, { registerProviderUsage, registerUsage } from "../index.ts";
import { globalConfigPath } from "../src/paths.ts";
import {
  ACCOUNTS_SERVICE_EVENT,
  MULTIPROVIDER_SERVICE_EVENT,
  type MultiproviderService,
} from "../src/multiprovider.ts";
import { USAGE_PROVIDERS, type UsageProvider } from "../src/providers.ts";
import type { FetchLike } from "../src/usage.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");

const tempDirs: string[] = [];
const cleanups: (() => void)[] = [];

describe("OMP children", () => {
  it("skips hooks, account service requests, commands and refresh timers", () => {
    const touch = vi.fn(() => {
      throw new Error("child must not initialize quota tracking");
    });
    const pi = {
      on: touch,
      events: { on: touch, emit: touch },
      registerCommand: touch,
    } as unknown as ExtensionAPI;
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      registerUsage(pi, { env: { PI_OMP_CHILD: "1" }, fetchImpl: touch });
      expect(touch).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      vi.stubEnv("PI_OMP_CHILD", "1");
      registerExtension(pi);
      expect(touch).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  tempDirs.length = 0;
});

type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };

const theme = { fg: (color: string, text: string) => `{${color}|${text}}` } as unknown as Theme;

/** Minimal stand-in for the theme API used by the widget. */
function renderWidget(factory: unknown, width = 200): string {
  expect(typeof factory).toBe("function");
  return (factory as WidgetFactory)(undefined, theme).render(width)[0] ?? "";
}

function okPayload() {
  return {
    usage: {
      rolling: { status: "ok", percent: 3, resetsAt: "2026-09-22T14:03:00.000Z" },
      weekly: { status: "ok", percent: 1, resetsAt: "2026-09-27T12:00:00.000Z" },
      monthly: { status: "ok", percent: 1, resetsAt: "2026-10-12T12:00:00.000Z" },
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(
  options: {
    config?: Record<string, unknown>;
    fetchImpl?: FetchLike;
    provider?: string;
    mode?: string;
    hasUI?: boolean;
    registryKey?: string | null;
    now?: () => number;
    usageProvider?: UsageProvider;
  } = {},
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-better-opencode-go-reg-"));
  tempDirs.push(agentDir);
  const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: agentDir };
  if (options.config) {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(globalConfigPath(env), JSON.stringify(options.config));
  }

  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const eventListeners = new Map<string, (value: unknown) => void>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const statuses: (string | undefined)[] = [];
  const widgets: { content: unknown; options: unknown }[] = [];
  const notifications: string[] = [];
  let fetches = 0;

  const pi = {
    events: {
      on: (name: string, listener: (value: unknown) => void) => eventListeners.set(name, listener),
    },
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand: (
      name: string,
      spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => commands.set(name, spec.handler),
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: agentDir,
    model: {
      provider: options.provider ?? options.usageProvider?.providerIds[0] ?? "opencode-go",
      id: "deepseek-v4.1-flash",
    },
    modelRegistry: {
      getProviderAuth: async () =>
        options.registryKey === null
          ? {}
          : { auth: { apiKey: options.registryKey ?? "registry-key" } },
    },
    ui: {
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: (_key: string, content: unknown, widgetOptions: unknown) =>
        widgets.push({ content, options: widgetOptions }),
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;

  const fetchImpl: FetchLike =
    options.fetchImpl ??
    (async () => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => okPayload(),
      };
    });

  const report = registerProviderUsage(
    pi,
    options.usageProvider ?? USAGE_PROVIDERS.find((p) => p.id === "opencode")!,
    {
      env,
      now: options.now ?? (() => NOW),
      fetchImpl,
    },
  );
  commands.set("usage", async (_args, ctx) => {
    ctx.ui.notify(await report(ctx), "info");
  });
  cleanups.push(() => {
    handlers.get("session_shutdown")?.({}, ctx);
  });

  return {
    agentDir,
    env,
    handlers,
    eventListeners,
    commands,
    statuses,
    widgets,
    notifications,
    ctx,
    pi,
    count: () => fetches,
    start: () => handlers.get("session_start")?.({}, ctx),
    command: () => commands.get("usage"),
    lastWidget: () => widgets.at(-1)?.content,
    lastStatus: () => statuses.at(-1),
  };
}

/** Lets the fire-and-forget refresh() calls inside event handlers finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(harness: Harness): Promise<void> {
  harness.start();
  // refresh() is fired without await by session_start; let it finish.
  await flush();
}

describe("widget placement", () => {
  it("installs the reading below the editor and clears the status line", async () => {
    const harness = makeHarness();
    await settle(harness);

    expect(harness.widgets.at(-1)?.options).toEqual({ placement: "belowEditor" });
    expect(harness.lastStatus()).toBeUndefined();
  });

  it("colours each percentage and wraps without dropping text", async () => {
    const harness = makeHarness();
    await settle(harness);

    expect(renderWidget(harness.lastWidget())).toBe(
      "{dim|Usage: }{dim|5h }{success|97%}{dim| left}{dim| · }{dim|wk }{success|99%}{dim| left}" +
        "{dim| · }{dim|mo }{success|99%}{dim| left}{dim| · ↺ 2h3m - 9/22 14:03}",
    );
    const lines = (harness.lastWidget() as WidgetFactory)(undefined, theme).render(20);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).not.toContain("...");
    expect(lines.join("").replace(/\s/g, "")).toBe(
      renderWidget(harness.lastWidget()).replace(/\s/g, ""),
    );
  });

  it("hides the reading for another provider", async () => {
    const harness = makeHarness({ provider: "xai" });
    await settle(harness);

    expect(harness.count()).toBe(0);
    for (const widget of harness.widgets) expect(widget.content).toBeUndefined();
  });

  it("never shows another provider's quota, even with the legacy gate disabled", async () => {
    const harness = makeHarness({ provider: "xai", config: { onlyOnOpencodeModel: false } });
    await settle(harness);

    expect(harness.count()).toBe(0);
    expect(harness.lastWidget()).toBeUndefined();
  });

  it("falls back to the status line outside the TUI", async () => {
    const harness = makeHarness({ mode: "rpc" });
    await settle(harness);

    expect(harness.lastStatus()).toBe(
      "Usage: 5h 97% left · wk 99% left · mo 99% left · ↺ 2h3m - 9/22 14:03",
    );
  });
});

describe("model and session transitions", () => {
  const switchTo = (harness: Harness, provider: string) => {
    // Separate contexts reproduce callbacks holding a snapshot of the old model.
    const ctx = { ...harness.ctx, model: { ...harness.ctx.model, provider } } as ExtensionContext;
    harness.handlers.get("model_select")?.({ model: ctx.model }, ctx);
    return ctx;
  };

  it("clears a Grok alias's footer before resolving the next alias's credential", async () => {
    let release!: () => void;
    const grok = {
      id: "grok",
      name: "Grok",
      providerIds: ["xai", "xai-oauth", "xai-auth"],
      loginHint: "fixture",
      resolve: async (ctx: ExtensionContext) => {
        const alias = ctx.model?.provider;
        return { apiKey: alias, fingerprint: alias, source: "pi", label: alias };
      },
      fetch: async (credential: { apiKey?: string }) => {
        if (credential.apiKey === "xai-oauth")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return {
          capturedAt: NOW,
          windows: {
            rolling: {
              status: "ok",
              percentUsed: credential.apiKey === "xai" ? 10 : 70,
              resetsAt: null,
            },
          },
        };
      },
    } as UsageProvider;
    const harness = makeHarness({ usageProvider: grok });
    await settle(harness);
    expect(renderWidget(harness.lastWidget())).toContain("90%");
    switchTo(harness, "xai-oauth");
    expect(harness.lastWidget()).toBeUndefined();
    await flush();
    expect(harness.lastWidget()).toBeUndefined();
    release();
    await flush();
    expect(renderWidget(harness.lastWidget())).toContain("30%");
  });

  it("clears immediately on a provider switch and restores below the editor on return", async () => {
    const harness = makeHarness();
    await settle(harness);
    switchTo(harness, "openai-codex");
    expect(harness.lastWidget()).toBeUndefined();
    await flush();
    expect(harness.count()).toBe(1);
    switchTo(harness, "opencode-go");
    expect(renderWidget(harness.lastWidget())).toContain("97%");
    await flush();
    expect(renderWidget(harness.lastWidget())).toContain("97%");
    expect(harness.widgets.at(-1)?.options).toEqual({ placement: "belowEditor" });
  });

  it("reuses fresh quota on same-bucket model switches and refreshes after expiry", async () => {
    let calls = 0;
    let clock = NOW;
    let finish!: () => void;
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async () => {
        const payload = okPayload();
        if (++calls > 1) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          payload.usage.rolling.percent = 80;
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    const writes = harness.widgets.length;
    const model = { ...harness.ctx.model!, id: "another-model" };
    harness.handlers.get("model_select")?.({ model }, harness.ctx);
    expect(renderWidget(harness.lastWidget())).toContain("97%");
    await flush();
    expect(calls).toBe(1);
    expect(harness.widgets.length).toBe(writes);
    clock += 60_000;
    harness.handlers.get("model_select")?.({ model }, harness.ctx);
    await flush();
    expect(calls).toBe(2);
    expect(harness.widgets.slice(writes).every((entry) => entry.content !== undefined)).toBe(true);
    finish();
    await flush();
    expect(renderWidget(harness.lastWidget())).toContain("20%");
  });

  it("refreshes the footer when the system clock moves behind the cached reading", async () => {
    let clock = NOW;
    let calls = 0;
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => okPayload(),
        };
      },
    });
    await settle(harness);
    expect(calls).toBe(1);
    clock -= 3_600_000;
    switchTo(harness, "opencode-go");
    await flush();
    expect(calls).toBe(2);
  });

  it("does not extend footer failure cooldown after a backward clock change", async () => {
    let clock = NOW;
    let calls = 0;
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }
          : { ok: true, status: 200, headers: { get: () => null }, json: async () => okPayload() };
      },
    });
    await settle(harness);
    expect(calls).toBe(1);
    clock -= 3_600_000;
    switchTo(harness, "opencode-go");
    await flush();
    expect(calls).toBe(2);
    expect(harness.lastWidget()).toBeTypeOf("function");
  });

  it("clears the cached quota as soon as background resolution detects another account", async () => {
    let calls = 0;
    let clock = NOW;
    let finish!: () => void;
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async () => {
        if (++calls > 1)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => okPayload(),
        };
      },
    });
    await settle(harness);
    harness.ctx.modelRegistry.getProviderAuth = async () =>
      ({ auth: { apiKey: "other-account" } }) as never;
    clock += 60_000;
    switchTo(harness, "opencode-go");
    await flush();
    expect(harness.lastWidget()).toBeUndefined();
    finish();
    await flush();
    expect(harness.lastWidget()).toBeTypeOf("function");
  });

  it("hides the old quota while the same token resolves a different account ID", async () => {
    let accountId = "org-a";
    let release!: () => void;
    const fetch = vi.fn(async (credential: { accountId?: string }) => {
      if (credential.accountId === "org-b")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        capturedAt: NOW,
        windows: {
          rolling: {
            status: "ok",
            percentUsed: credential.accountId === "org-a" ? 10 : 70,
            resetsAt: null,
          },
        },
      };
    });
    const provider = {
      id: "openai",
      name: "OpenAI Codex",
      providerIds: ["openai-codex"],
      loginHint: "/login openai-codex",
      resolve: async () => ({
        apiKey: "shared-token",
        fingerprint: "shared-fingerprint",
        accountId,
        label: "work",
        source: "pi" as const,
      }),
      fetch,
    } as UsageProvider;
    const harness = makeHarness({ usageProvider: provider });
    await settle(harness);
    expect(renderWidget(harness.lastWidget())).toContain("90%");
    accountId = "org-b";
    const report = harness.command()!("", harness.ctx);
    try {
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(harness.lastWidget()).toBeUndefined();
    } finally {
      release?.();
      await report;
    }
    expect(renderWidget(harness.lastWidget())).toContain("30%");
  });

  it("polls using the latest model context and stays quiet on other providers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = makeHarness({ now: () => Date.now() });
    harness.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.count()).toBe(1);
    switchTo(harness, "xai");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.count()).toBe(1);
    expect(harness.lastWidget()).toBeUndefined();
    switchTo(harness, "opencode-go");
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.count()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.count()).toBe(3);
    expect(harness.lastWidget()).toBeTypeOf("function");
  });

  it("uses the selected event model even if ctx still has the old model", async () => {
    const harness = makeHarness();
    await settle(harness);
    harness.handlers.get("model_select")?.({ model: { provider: "xai" } }, harness.ctx);
    expect(harness.lastWidget()).toBeUndefined();
    await flush();
    expect(harness.count()).toBe(1);
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`ignores late ${outcome} after switching providers`, async () => {
      let finish!: () => void;
      let signal: AbortSignal | undefined;
      const harness = makeHarness({
        fetchImpl: (_url, init) => {
          signal = init?.signal;
          return new Promise((resolve, reject) => {
            finish = () =>
              outcome === "failure"
                ? reject(new Error("late failure"))
                : resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => null },
                    json: async () => okPayload(),
                  });
          });
        },
      });
      await settle(harness);
      switchTo(harness, "xai");
      expect(signal?.aborted).toBe(true);
      const updates = harness.widgets.length;
      finish();
      await flush();
      expect(harness.lastWidget()).toBeUndefined();
      expect(harness.widgets.length).toBe(updates);
    });
  }

  it("does not let an older request overwrite the reading after switching back", async () => {
    const pending: (() => void)[] = [];
    let calls = 0;
    const harness = makeHarness({
      fetchImpl: async () => {
        const percent = ++calls === 1 ? 3 : 80;
        await new Promise<void>((resolve) => pending.push(resolve));
        const payload = okPayload();
        payload.usage.rolling.percent = percent;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    switchTo(harness, "xai");
    switchTo(harness, "opencode-go");
    await flush();
    expect(calls).toBe(2);
    pending[1]!();
    await flush();
    expect(renderWidget(harness.lastWidget())).toContain("20%");
    pending[0]!();
    await flush();
    expect(renderWidget(harness.lastWidget())).toContain("20%");
  });

  it("prevents pending work from restoring a widget after shutdown", async () => {
    let finish!: () => void;
    const harness = makeHarness({
      fetchImpl: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => okPayload(),
        };
      },
    });
    await settle(harness);
    harness.handlers.get("session_shutdown")?.({}, harness.ctx);
    const updates = harness.widgets.length;
    finish();
    await flush();
    expect(harness.lastWidget()).toBeUndefined();
    expect(harness.widgets.length).toBe(updates);
  });

  it("hides cached quota on an error rather than leaving stale usage on screen", async () => {
    let calls = 0;
    let clock = NOW;
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async () => {
        if (++calls > 1) throw new Error("network unavailable");
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => okPayload(),
        };
      },
    });
    await settle(harness);
    expect(harness.lastWidget()).toBeTypeOf("function");
    clock += 60_000;
    switchTo(harness, "opencode-go");
    await flush();
    expect(harness.lastWidget()).toBeUndefined();
  });
});

describe("footer modes", () => {
  it("does not rebuild unchanged widgets and still responds to theme changes", async () => {
    const harness = makeHarness();
    await settle(harness);
    const before = harness.widgets.length;
    for (const event of [
      "agent_start",
      "turn_end",
      "agent_end",
      "session_tree",
      "session_compact",
    ]) {
      harness.handlers.get(event)?.({}, harness.ctx);
    }
    await flush();
    expect(harness.widgets.length).toBe(before);
    Object.defineProperty(harness.ctx.ui, "theme", { value: theme, configurable: true });
    harness.handlers.get("agent_start")?.({}, harness.ctx);
    expect(harness.widgets.length).toBe(before + 1);
  });
  it("status writes flat text to the footer", async () => {
    const harness = makeHarness({ config: { footerMode: "status" } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeUndefined();
    expect(harness.lastStatus()).toBe(
      "Usage: 5h 97% left · wk 99% left · mo 99% left · ↺ 2h3m - 9/22 14:03",
    );
  });

  it("retries a failed status write and renders the same text in a new UI", async () => {
    const harness = makeHarness({ config: { footerMode: "status" } });
    const original = harness.ctx.ui.setStatus.bind(harness.ctx.ui);
    let failed = false;
    harness.ctx.ui.setStatus = (key, text) => {
      if (text && !failed) {
        failed = true;
        throw new Error("stale UI");
      }
      original(key, text);
    };
    await settle(harness);
    expect(failed).toBe(true);
    expect(harness.lastStatus()).toBeUndefined();
    harness.handlers.get("agent_start")?.({}, harness.ctx);
    expect(harness.lastStatus()).toContain("Usage: 5h 97% left");

    const otherWrites: Array<string | undefined> = [];
    const newCtx = Object.create(harness.ctx, {
      ui: {
        value: {
          ...harness.ctx.ui,
          setStatus: (_key: string, text: string | undefined) => otherWrites.push(text),
        },
      },
    }) as ExtensionContext;
    harness.handlers.get("agent_start")?.({}, newCtx);
    expect(otherWrites.at(-1)).toBe(harness.lastStatus());
  });

  it("off hides the reading but keeps /usage working", async () => {
    const harness = makeHarness({ config: { footerMode: "off" } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeUndefined();
    expect(harness.lastStatus()).toBeUndefined();

    await harness.command()?.("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain(
      "5h rolling: [███████████████████░]  97% left ·   3% used",
    );
  });

  it("accepts pi-better-grok's footer object", async () => {
    const harness = makeHarness({ config: { footer: { mode: "status" } } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeTypeOf("function");
  });
});

describe("refresh policy", () => {
  it("rechecks a native login after a turn without refetching the unchanged account", async () => {
    const keys: string[] = [];
    const harness = makeHarness({
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization;
        keys.push(key ?? "");
        const payload = okPayload();
        if (key === "Bearer account-b") payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    expect(keys).toEqual(["Bearer registry-key"]);
    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(keys).toHaveLength(1);
    harness.ctx.modelRegistry.getProviderAuth = async () =>
      ({ auth: { apiKey: "account-b" } }) as never;
    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(keys).toEqual(["Bearer registry-key", "Bearer account-b"]);
    expect(renderWidget(harness.lastWidget())).toContain("20%");
  });

  it("rechecks a native login requested while an older reading is in flight", async () => {
    const keys: string[] = [];
    let releaseOld!: () => void;
    const oldRequest = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const harness = makeHarness({
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization ?? "";
        keys.push(key);
        if (key === "Bearer registry-key") await oldRequest;
        const payload = okPayload();
        if (key === "Bearer new-account") payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    harness.start();
    await flush();
    expect(keys).toEqual(["Bearer registry-key"]);
    writeFileSync(
      join(harness.agentDir, "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api_key", key: "new-account" } }),
    );
    harness.ctx.modelRegistry.getProviderAuth = async () =>
      ({ auth: { apiKey: "new-account" } }) as never;
    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    releaseOld();
    await flush();
    expect(keys).toEqual(["Bearer registry-key", "Bearer new-account"]);
    expect(renderWidget(harness.lastWidget())).toContain("20%");
    expect(
      harness.widgets
        .filter(({ content }) => typeof content === "function")
        .some(({ content }) => renderWidget(content).includes("97%")),
    ).toBe(false);
  });

  it("clears an old account's footer while its refresh is still in flight", async () => {
    let clock = NOW;
    const keys: string[] = [];
    let releaseOld!: () => void;
    const oldRequest = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization ?? "";
        keys.push(key);
        if (keys.length === 2) await oldRequest;
        const payload = okPayload();
        if (key === "Bearer new-account") payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    expect(renderWidget(harness.lastWidget())).toContain("97%");
    clock += 60_000;
    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(keys).toEqual(["Bearer registry-key", "Bearer registry-key"]);
    try {
      writeFileSync(
        join(harness.agentDir, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api_key", key: "new-account" } }),
      );
      harness.ctx.modelRegistry.getProviderAuth = async () =>
        ({ auth: { apiKey: "new-account" } }) as never;
      await harness.handlers.get("turn_end")?.({}, harness.ctx);
      expect(harness.lastWidget()).toBeUndefined();
    } finally {
      releaseOld();
    }
    await flush();
    expect(keys).toEqual(["Bearer registry-key", "Bearer registry-key", "Bearer new-account"]);
    expect(renderWidget(harness.lastWidget())).toContain("20%");
  });

  it("lets a new native login recover immediately from the previous account's auth backoff", async () => {
    const keys: string[] = [];
    const harness = makeHarness({
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization;
        keys.push(key ?? "");
        if (key !== "Bearer account-b")
          return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => okPayload(),
        };
      },
    });
    await settle(harness);
    expect(keys).toEqual(["Bearer registry-key"]);
    harness.ctx.modelRegistry.getProviderAuth = async () =>
      ({ auth: { apiKey: "account-b" } }) as never;
    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(keys).toEqual(["Bearer registry-key", "Bearer account-b"]);
    expect(renderWidget(harness.lastWidget())).toContain("97%");
  });

  it("backs off unresolved authentication until native login changes auth storage", async () => {
    const harness = makeHarness();
    const resolve = vi.fn(async () => {
      throw new Error("authentication unavailable");
    });
    harness.ctx.modelRegistry.getProviderAuth = resolve as never;
    await settle(harness);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(harness.count()).toBe(0);
    for (let i = 0; i < 3; i++) {
      await harness.handlers.get("turn_end")?.({}, harness.ctx);
      await flush();
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    writeFileSync(
      join(harness.agentDir, "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api_key", key: "new-login" } }),
    );
    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(harness.count()).toBe(1);
    expect(renderWidget(harness.lastWidget())).toContain("97%");
  });

  it("a late command cannot restart requests after shutdown", async () => {
    const harness = makeHarness();
    await settle(harness);
    const before = harness.count();
    harness.handlers.get("session_shutdown")?.({}, harness.ctx);
    await harness.command()?.("", harness.ctx);
    await flush();
    expect(harness.count()).toBe(before);
  });
  it("waits for an expired reading and does not report stale quota after a failed refresh", async () => {
    let clock = NOW;
    let calls = 0;
    let release!: () => void;
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async () => {
        const attempt = ++calls;
        if (attempt === 2)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (attempt === 3)
          return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
        const payload = okPayload();
        if (attempt === 2) payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    clock += 60_000;
    const command = harness.command()!("", harness.ctx);
    try {
      await flush();
      expect(calls).toBe(2);
      expect(harness.notifications).toHaveLength(0);
    } finally {
      release();
    }
    await command;
    expect(harness.notifications.at(-1)).toContain("80% used");
    clock += 60_000;
    await harness.command()!("", harness.ctx);
    expect(calls).toBe(3);
    expect(harness.notifications.at(-1)).toContain("usage unavailable");
    expect(harness.notifications.at(-1)).not.toContain("80% used");
  });
  it("rechecks a fresh cached reading after a native login before reporting it", async () => {
    const keys: string[] = [];
    const harness = makeHarness({
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization ?? "";
        keys.push(key);
        const payload = okPayload();
        if (key === "Bearer new-account") payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    expect(keys).toEqual(["Bearer registry-key"]);
    harness.ctx.modelRegistry.getProviderAuth = async () =>
      ({ auth: { apiKey: "new-account" } }) as never;
    await harness.command()!("", harness.ctx);
    expect(keys).toEqual(["Bearer registry-key", "Bearer new-account"]);
    expect(harness.notifications.at(-1)).toContain("80% used");
    await harness.command()!("", harness.ctx);
    expect(keys).toHaveLength(2);
  });
  it("rechecks the login after waiting for an older in-flight reading", async () => {
    const keys: string[] = [];
    let releaseOld!: () => void;
    const oldRequest = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const harness = makeHarness({
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization ?? "";
        keys.push(key);
        if (key === "Bearer registry-key") await oldRequest;
        const payload = okPayload();
        if (key === "Bearer new-account") payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    harness.start();
    await flush();
    expect(keys).toEqual(["Bearer registry-key"]);
    harness.ctx.modelRegistry.getProviderAuth = async () =>
      ({ auth: { apiKey: "new-account" } }) as never;
    const command = harness.command()!("", harness.ctx);
    try {
      await flush();
      expect(harness.notifications).toHaveLength(0);
    } finally {
      releaseOld();
    }
    await command;
    expect(keys).toEqual(["Bearer registry-key", "Bearer new-account"]);
    expect(harness.notifications.at(-1)).toContain("80% used");
  });
  it("rechecks the login when auth storage changes during its own request", async () => {
    let clock = NOW;
    const keys: string[] = [];
    let releaseOld!: () => void;
    const oldRequest = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const harness = makeHarness({
      now: () => clock,
      fetchImpl: async (_url, init) => {
        const key = init?.headers?.Authorization ?? "";
        keys.push(key);
        if (keys.length === 2) await oldRequest;
        const payload = okPayload();
        if (key === "Bearer new-account") payload.usage.rolling.percent = 80;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
      },
    });
    await settle(harness);
    clock += 60_000;
    const command = harness.command()!("", harness.ctx);
    try {
      await flush();
      expect(keys).toEqual(["Bearer registry-key", "Bearer registry-key"]);
      writeFileSync(
        join(harness.agentDir, "auth.json"),
        JSON.stringify({
          "opencode-go": { type: "api_key", key: "new-account" },
        }),
      );
      harness.ctx.modelRegistry.getProviderAuth = async () =>
        ({ auth: { apiKey: "new-account" } }) as never;
    } finally {
      releaseOld();
    }
    await command;
    expect(keys).toEqual(["Bearer registry-key", "Bearer registry-key", "Bearer new-account"]);
    expect(harness.notifications.at(-1)).toContain("80% used");
  });
  it("does not refetch while the cache is fresh", async () => {
    const harness = makeHarness();
    await settle(harness);
    expect(harness.count()).toBe(1);

    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(harness.count()).toBe(1);

    await harness.handlers.get("model_select")?.({}, harness.ctx);
    await flush();
    expect(harness.count()).toBe(1);
  });

  it("backs off after a rejected key instead of polling", async () => {
    let calls = 0;
    const harness = makeHarness({
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
      },
    });
    await settle(harness);
    expect(calls).toBe(1);
    expect(harness.lastWidget()).toBeUndefined();

    // Automatic refresh stays quiet until the cooldown expires.
    for (let i = 0; i < 3; i += 1) {
      await harness.handlers.get("turn_end")?.({}, harness.ctx);
      await flush();
    }
    expect(calls).toBe(1);

    // Same-bucket model switches and repeated commands also respect backoff.
    await harness.handlers.get("model_select")?.({}, harness.ctx);
    await harness.command()?.("", harness.ctx);
    await flush();
    expect(calls).toBe(1);
  });

  it("reports a missing credential without calling the endpoint", async () => {
    let calls = 0;
    const harness = makeHarness({
      registryKey: null,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
      },
    });
    await settle(harness);

    expect(calls).toBe(0);
    expect(harness.lastWidget()).toBeUndefined();

    await harness.command()?.("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No OpenCode Go subscription credential");
  });
});

describe("multilogin accounts", () => {
  it("releases subscriptions created before a provider listener fails", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
      },
      on: () => undefined,
    } as unknown as ExtensionAPI;
    registerProviderUsage(pi, USAGE_PROVIDERS.find((provider) => provider.id === "grok")!);
    const removed = vi.fn();
    let registered = 0;
    const service = {
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => {
        if (++registered === 2) throw new Error("subscription unavailable");
        return removed;
      },
    } as MultiproviderService;
    expect(() => listeners.get(ACCOUNTS_SERVICE_EVENT)?.(service)).not.toThrow();
    expect(removed).toHaveBeenCalledOnce();
    // A later announcement from the same service can recover a transient
    // subscription failure instead of remaining on polling forever.
    expect(() => listeners.get(ACCOUNTS_SERVICE_EVENT)?.(service)).not.toThrow();
    expect(registered).toBe(
      2 + USAGE_PROVIDERS.find((provider) => provider.id === "grok")!.providerIds.length,
    );
  });

  it("keeps saved reports available after a partial service subscription fails", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      },
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    registerUsage(pi, { env: { PI_CODING_AGENT_DIR: join(tmpdir(), "pi-empty-registration") } });
    const removed = vi.fn();
    let registered = 0;
    const listAccounts = vi.fn(async () => []);
    const service = {
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      listAccounts,
      resolveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => {
        if (++registered === 2) throw new Error("subscription unavailable");
        return removed;
      },
    } as MultiproviderService;
    expect(() => listeners.get(ACCOUNTS_SERVICE_EVENT)?.(service)).not.toThrow();
    expect(removed).toHaveBeenCalledOnce();
    const ctx = {
      cwd: tmpdir(),
      mode: "rpc",
      hasUI: false,
      model: { provider: "unsupported", id: "test" },
      ui: { setStatus: () => undefined, setWidget: () => undefined },
    } as unknown as ExtensionContext;
    try {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      await flush();
      expect(listAccounts).toHaveBeenCalled();
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }
  });

  function pooledService(
    resolve: MultiproviderService["resolveActiveAccountAuth"],
    onChange?: (event: unknown) => void,
  ): MultiproviderService {
    return {
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: resolve,
      onActiveAccountChanged: (_providerId, callback) => {
        onChange?.(callback);
        return () => undefined;
      },
    };
  }

  it("announces the pool and shows the pooled account label", async () => {
    const harness = makeHarness();
    await settle(harness);
    expect(renderWidget(harness.lastWidget())).not.toContain("· pi");

    let listener: ((event: unknown) => void) | undefined;
    harness.eventListeners.get(MULTIPROVIDER_SERVICE_EVENT)?.(
      pooledService(
        async () => ({ accessToken: "pooled-key", label: "zhong" }),
        (event) => {
          listener = event as (event: unknown) => void;
        },
      ),
    );
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(renderWidget(harness.lastWidget())).toContain("· zhong");
    expect(listener).toBeTypeOf("function");
  });

  it.each([MULTIPROVIDER_SERVICE_EVENT, ACCOUNTS_SERVICE_EVENT])(
    "drops old quota and refreshes the label on %s",
    async (serviceEvent) => {
      const harness = makeHarness();
      await settle(harness);

      let listener: ((event: { ctx?: ExtensionContext }) => void) | undefined;
      let label = "first";
      harness.eventListeners.get(serviceEvent)?.(
        pooledService(
          async () => ({ accessToken: `key-${label}`, label }),
          (event) => {
            listener = event as (event: { ctx?: ExtensionContext }) => void;
          },
        ),
      );
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(renderWidget(harness.lastWidget())).toContain("· first");

      label = "second";
      listener?.({ ctx: harness.ctx });
      // The previous account's numbers must not survive the switch.
      expect(harness.lastWidget()).toBeUndefined();

      await flush();
      expect(renderWidget(harness.lastWidget())).toContain("· second");
    },
  );

  it("clears everything on shutdown", async () => {
    const harness = makeHarness();
    await settle(harness);

    harness.handlers.get("session_shutdown")?.({}, harness.ctx);
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(harness.lastWidget()).toBeUndefined();
  });
});

describe("/usage", () => {
  it("coalesces timer ticks and catches an account added during a slow report", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-pending-poll-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      },
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetch = vi.fn(async () => {
      await fetchGate;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ usage: { weekly: { percent: 20 } } }),
      };
    });
    registerUsage(pi, { env: { PI_CODING_AGENT_DIR: agentDir }, fetchImpl: fetch });
    let firstListed!: () => void;
    const listed = new Promise<void>((resolve) => {
      firstListed = resolve;
    });
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let reads = 0;
    let accounts: Array<{
      id: string;
      providerId: string;
      label: string;
      authKind: "api_key";
      active: boolean;
      credentialRevision: string;
    }> = [];
    const listAccounts = vi.fn(async () => {
      const snapshot = accounts;
      if (++reads === 1) {
        firstListed();
        await listGate;
      }
      return snapshot;
    });
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts,
      resolveAccountAuth: async () => ({
        accessToken: "fixture-key",
        label: "work",
        credentialRevision: "rev1",
      }),
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: false,
      model: { provider: "unsupported", id: "test" },
      ui: { setStatus: () => undefined, setWidget: () => undefined },
    } as unknown as ExtensionContext;
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      await listed;
      const tick = intervals.mock.calls.at(-1)?.[0];
      expect(tick).toBeTypeOf("function");
      for (let i = 0; i < 5; i++) (tick as () => void)();
      accounts = [
        {
          id: "opencode-go/work",
          providerId: "opencode-go",
          label: "work",
          authKind: "api_key",
          active: true,
          credentialRevision: "rev1",
        },
      ];
      releaseList();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      for (let i = 0; i < 5; i++) (tick as () => void)();
      releaseFetch();
      await vi.waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(5));
      await flush();
      // One recheck per slow report; an unchanged roster skips another quota fetch.
      expect(listAccounts).toHaveBeenCalledTimes(5);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      releaseList();
      releaseFetch();
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      intervals.mockRestore();
    }
  });

  it("aborts an in-flight saved-account request when its panel closes", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-panel-close-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, spec.handler),
    } as unknown as ExtensionAPI;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    registerUsage(pi, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal;
        requestStarted();
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      },
    });
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts: async () => [
        {
          id: "opencode-go/work",
          providerId: "opencode-go",
          label: "work",
          authKind: "api_key",
          active: true,
        },
      ],
      resolveAccountAuth: async () => ({ accessToken: "fixture-key", label: "work" }),
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    let panel!: { handleInput(data: string): void };
    const ctx = {
      cwd: agentDir,
      mode: "tui",
      hasUI: true,
      model: { provider: "opencode-go", id: "test" },
      modelRegistry: {},
      ui: {
        custom: (factory: Function) =>
          new Promise<void>((resolve) => {
            panel = factory(
              { terminal: { rows: 30 }, requestRender: () => undefined },
              {},
              {},
              resolve,
            );
          }),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const command = commands.get("usage")!("", ctx);
    await started;
    panel.handleInput("\u001b");
    await command;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rechecks the account roster after waiting for another report", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notifications: string[] = [];
    const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-report-race-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, spec.handler),
    } as unknown as ExtensionAPI;
    let firstFetchStarted!: () => void;
    const fetching = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const keys: string[] = [];
    registerUsage(pi, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      fetchImpl: async (_url, init) => {
        const key = new Headers(init?.headers).get("authorization") ?? "";
        keys.push(key);
        if (key === "Bearer old-key") {
          firstFetchStarted();
          await fetchGate;
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ usage: { weekly: { percent: 20 } } }),
        };
      },
    });
    const account = (name: string) => ({
      id: `opencode-go/${name}`,
      providerId: "opencode-go",
      label: name,
      authKind: "api_key" as const,
      active: true,
      credentialRevision: name,
    });
    let current = account("old");
    let rosterReads = 0;
    let secondListed!: () => void;
    const listedTwice = new Promise<void>((resolve) => {
      secondListed = resolve;
    });
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts: async () => {
        if (++rosterReads === 2) secondListed();
        return [current];
      },
      resolveAccountAuth: async (id: string) => ({
        accessToken: id.endsWith("/old") ? "old-key" : "new-key",
        label: id.endsWith("/old") ? "old" : "new",
      }),
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: false,
      model: { provider: "opencode-go", id: "test" },
      modelRegistry: {},
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    const first = commands.get("usage")!("", ctx);
    await fetching;
    const second = commands.get("usage")!("", ctx);
    try {
      await listedTwice;
      await flush();
      current = account("new");
    } finally {
      releaseFetch();
    }
    await Promise.all([first, second]);
    expect(notifications.at(-1)).toContain("new [Current]");
    expect(notifications.at(-1)).not.toContain("old [Current]");
    expect(keys).toContain("Bearer new-key");
  });

  it("rebuilds a partial report when the account roster changes during loading", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notifications: string[] = [];
    const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-roster-change-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, spec.handler),
    } as unknown as ExtensionAPI;
    let oldFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      oldFetchStarted = resolve;
    });
    let releaseOld!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const keys: string[] = [];
    registerUsage(pi, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      fetchImpl: async (_url, init) => {
        const key = new Headers(init?.headers).get("authorization") ?? "";
        keys.push(key);
        if (key === "Bearer old-key") {
          oldFetchStarted();
          await gate;
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ usage: { weekly: { percent: 20 } } }),
        };
      },
    });
    const account = (name: string, active: boolean) => ({
      id: `opencode-go/${name}`,
      providerId: "opencode-go",
      label: name,
      authKind: "api_key" as const,
      active,
      credentialRevision: name,
    });
    let current = [account("old", true), account("keep", false)];
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts: async () => current,
      resolveAccountAuth: async (id: string) => ({
        accessToken: `${id.slice("opencode-go/".length)}-key`,
        label: id.slice("opencode-go/".length),
      }),
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: false,
      model: { provider: "opencode-go", id: "test" },
      modelRegistry: {},
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    const command = commands.get("usage")!("", ctx);
    await started;
    current = [account("new", true), account("keep", false)];
    releaseOld();
    await command;
    expect(notifications.at(-1)).toContain("new [Current]");
    expect(notifications.at(-1)).toContain("keep");
    expect(notifications.at(-1)).not.toContain("old [Current]");
    expect(keys).toContain("Bearer new-key");
    expect(keys.filter((key) => key === "Bearer keep-key")).toHaveLength(1);
  });

  it("returns an unverified report once and rechecks before caching it", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notifications: string[] = [];
    const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-roster-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, spec.handler),
    } as unknown as ExtensionAPI;
    registerUsage(pi, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ usage: { weekly: { percent: 10 } } }),
      }),
    });
    const account = {
      id: "opencode-go/work",
      providerId: "opencode-go",
      label: "work",
      authKind: "api_key",
      active: true,
    };
    let rosterReads = 0;
    const resolveAccountAuth = vi.fn(async () => ({ accessToken: "fixture-key", label: "work" }));
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts: async () => {
        if (++rosterReads === 2) throw new Error("Transient storage lock");
        return [account];
      },
      resolveAccountAuth,
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: false,
      model: { provider: "opencode-go", id: "test" },
      modelRegistry: {},
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    await commands.get("usage")?.("", ctx);
    expect(notifications.at(-1)).toContain("work [Current]");
    expect(notifications.at(-1)).toContain("Account list could not be verified");
    expect(resolveAccountAuth).toHaveBeenCalledOnce();
    await commands.get("usage")?.("", ctx);
    expect(resolveAccountAuth).toHaveBeenCalledTimes(2);
    await commands.get("usage")?.("", ctx);
    expect(resolveAccountAuth).toHaveBeenCalledTimes(2);
  });

  it("refreshes a saved-account report after the clock moves backward", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const agentDir = mkdtempSync(join(tmpdir(), "pi-usage-clock-"));
    cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, spec.handler),
    } as unknown as ExtensionAPI;
    let clock = NOW;
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ usage: { weekly: { percent: 10 } } }),
    }));
    registerUsage(pi, {
      env: { PI_CODING_AGENT_DIR: agentDir },
      now: () => clock,
      fetchImpl: fetch,
    });
    const account = {
      id: "opencode-go/work",
      providerId: "opencode-go",
      label: "work",
      authKind: "api_key",
      active: true,
    };
    const resolveAccountAuth = vi.fn(async () => ({ accessToken: "fixture-key", label: "work" }));
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts: async () => [account],
      resolveAccountAuth,
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    const ctx = {
      cwd: agentDir,
      mode: "rpc",
      hasUI: false,
      model: { provider: "opencode-go", id: "test" },
      modelRegistry: {},
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    await commands.get("usage")?.("", ctx);
    await commands.get("usage")?.("", ctx);
    expect(resolveAccountAuth).toHaveBeenCalledTimes(1);
    clock -= 3_600_000;
    await commands.get("usage")?.("", ctx);
    await vi.waitFor(() => expect(resolveAccountAuth).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("reuses a report before and after refreshed OAuth email metadata is saved", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notifications: string[] = [];
    const env = { PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "pi-usage-oauth-")) };
    const pi = {
      events: {
        on: (name: string, listener: (value: unknown) => void) => listeners.set(name, listener),
        emit: () => undefined,
      },
      on: () => undefined,
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
      ) => commands.set(name, spec.handler),
    } as unknown as ExtensionAPI;
    registerUsage(pi, {
      env,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          email: "work@example.com",
          rate_limit: { primary_window: { used_percent: 25 } },
        }),
      }),
    });
    const account = {
      id: "openai-codex/work",
      label: "work",
      providerId: "openai-codex",
      authKind: "oauth",
      active: false,
    };
    let revision = "expired-token";
    let email: string | undefined;
    let releaseEmail!: () => void;
    const emailWrite = new Promise<void>((resolve) => {
      releaseEmail = resolve;
    });
    const resolveAccountAuth = vi.fn(async () => {
      revision = "refreshed-token";
      return {
        accessToken: `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.s`,
        label: "work",
        credentialRevision: revision,
      };
    });
    listeners.get(ACCOUNTS_SERVICE_EVENT)?.({
      listAccounts: async () => [{ ...account, credentialRevision: revision, email }],
      resolveAccountAuth,
      updateAccountEmail: async (_id: string, updatedEmail: string) => {
        await emailWrite;
        email = updatedEmail;
      },
      getActiveAccount: async () => undefined,
      resolveActiveAccountAuth: async () => undefined,
      onActiveAccountChanged: () => () => undefined,
    } as MultiproviderService);
    const ctx = {
      cwd: env.PI_CODING_AGENT_DIR,
      mode: "rpc",
      hasUI: false,
      model: { provider: "openai-codex", id: "test" },
      modelRegistry: {},
      ui: { notify: (message: string) => notifications.push(message) },
    } as unknown as ExtensionContext;
    await commands.get("usage")?.("", ctx);
    expect(notifications.at(-1)).toContain("75% left");
    expect(notifications.at(-1)).toContain("work@example.com");
    await commands.get("usage")?.("", ctx);
    releaseEmail();
    await vi.waitFor(() => expect(email).toBe("work@example.com"));
    await commands.get("usage")?.("", ctx);
    expect(resolveAccountAuth).toHaveBeenCalledOnce();
  });

  it("prints the per-window report", async () => {
    const harness = makeHarness();
    await settle(harness);
    await harness.command()?.("", harness.ctx);

    expect(harness.notifications.at(-1)?.split("\n")[0]).toBe("OpenCode Go usage");
    expect(harness.notifications.at(-1)).toContain(
      "5h rolling: [███████████████████░]  97% left ·   3% used",
    );
    expect(harness.count()).toBe(1);
  });

  it("uses the fresh background cache on repeated invocations", async () => {
    const harness = makeHarness();
    await settle(harness);
    await harness.command()?.("", harness.ctx);
    await harness.command()?.("", harness.ctx);

    expect(harness.count()).toBe(1);
  });

  it("queries on demand while keeping the footer hidden for other models", async () => {
    const harness = makeHarness({ provider: "xai" });
    await settle(harness);
    await harness.command()?.("", harness.ctx);

    expect(harness.notifications.at(-1)).toContain("OpenCode Go usage");
    expect(harness.lastWidget()).toBeUndefined();
  });
});
