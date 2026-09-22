import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProviderUsage } from "../index.ts";
import { globalConfigPath } from "../src/paths.ts";
import { MULTIPROVIDER_SERVICE_EVENT, type MultiproviderService } from "../src/multiprovider.ts";
import { USAGE_PROVIDERS } from "../src/providers.ts";
import type { FetchLike } from "../src/usage.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");

const tempDirs: string[] = [];
const cleanups: (() => void)[] = [];

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
    model: { provider: options.provider ?? "opencode-go", id: "deepseek-v4.1-flash" },
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

  const report = registerProviderUsage(pi, USAGE_PROVIDERS.find((p) => p.id === "opencode")!, {
    env,
    now: options.now ?? (() => NOW),
    fetchImpl,
  });
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

  it("colours each percentage and truncates to the width", async () => {
    const harness = makeHarness();
    await settle(harness);

    expect(renderWidget(harness.lastWidget())).toBe(
      "{dim|Usage: }{dim|5h }{success|97%}{dim| left}{dim| · }{dim|wk }{success|99%}{dim| left}" +
        "{dim| · }{dim|mo }{success|99%}{dim| left}{dim| · ↺ 2h3m - 9/22 14:03}",
    );
    expect(renderWidget(harness.lastWidget(), 20)).toMatch(/\{dim\|\.\.\./);
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

  it("clears immediately on a provider switch and restores below the editor on return", async () => {
    const harness = makeHarness();
    await settle(harness);
    switchTo(harness, "openai-codex");
    expect(harness.lastWidget()).toBeUndefined();
    await flush();
    expect(harness.count()).toBe(1);
    switchTo(harness, "opencode-go");
    await flush();
    expect(renderWidget(harness.lastWidget())).toContain("97%");
    expect(harness.widgets.at(-1)?.options).toEqual({ placement: "belowEditor" });
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
    const harness = makeHarness({
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
    switchTo(harness, "opencode-go");
    await flush();
    expect(harness.lastWidget()).toBeUndefined();
  });
});

describe("footer modes", () => {
  it("status writes flat text to the footer", async () => {
    const harness = makeHarness({ config: { footerMode: "status" } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeUndefined();
    expect(harness.lastStatus()).toBe(
      "Usage: 5h 97% left · wk 99% left · mo 99% left · ↺ 2h3m - 9/22 14:03",
    );
  });

  it("off hides the reading but keeps /usage working", async () => {
    const harness = makeHarness({ config: { footerMode: "off" } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeUndefined();
    expect(harness.lastStatus()).toBeUndefined();

    await harness.command()?.("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain(
      "5h rolling: [███████████████████░] 97% left · 3% used",
    );
  });

  it("accepts pi-better-grok's footer object", async () => {
    const harness = makeHarness({ config: { footer: { mode: "status" } } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeTypeOf("function");
  });
});

describe("refresh policy", () => {
  it("does not refetch while the cache is fresh", async () => {
    const harness = makeHarness();
    await settle(harness);
    expect(harness.count()).toBe(1);

    await harness.handlers.get("turn_end")?.({}, harness.ctx);
    await flush();
    expect(harness.count()).toBe(1);

    await harness.handlers.get("model_select")?.({}, harness.ctx);
    await flush();
    expect(harness.count()).toBe(2);
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

    // Picking a model is a user action, so it retries once even inside the cooldown.
    await harness.handlers.get("model_select")?.({}, harness.ctx);
    await flush();
    expect(calls).toBe(2);
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

  it("drops the previous account's reading when the account switches", async () => {
    const harness = makeHarness();
    await settle(harness);

    let listener: ((event: { ctx?: ExtensionContext }) => void) | undefined;
    let label = "first";
    harness.eventListeners.get(MULTIPROVIDER_SERVICE_EVENT)?.(
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
  });

  it("clears everything on shutdown", async () => {
    const harness = makeHarness();
    await settle(harness);

    harness.handlers.get("session_shutdown")?.({}, harness.ctx);
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(harness.lastWidget()).toBeUndefined();
  });
});

describe("/usage", () => {
  it("prints the per-window report", async () => {
    const harness = makeHarness();
    await settle(harness);
    await harness.command()?.("", harness.ctx);

    expect(harness.notifications.at(-1)?.split("\n")[0]).toBe("OpenCode Go usage");
    expect(harness.notifications.at(-1)).toContain(
      "5h rolling: [███████████████████░] 97% left · 3% used",
    );
    expect(harness.count()).toBe(2);
  });

  it("queries again on each invocation", async () => {
    const harness = makeHarness();
    await settle(harness);
    await harness.command()?.("refresh", harness.ctx);

    expect(harness.count()).toBe(2);
  });

  it("queries on demand while keeping the footer hidden for other models", async () => {
    const harness = makeHarness({ provider: "xai" });
    await settle(harness);
    await harness.command()?.("", harness.ctx);

    expect(harness.notifications.at(-1)).toContain("OpenCode Go usage");
    expect(harness.lastWidget()).toBeUndefined();
  });
});
