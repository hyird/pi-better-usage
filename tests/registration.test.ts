import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpencodeGoUsage } from "../index.ts";
import { globalConfigPath } from "../src/paths.ts";
import { MULTIPROVIDER_SERVICE_EVENT, type MultiproviderService } from "../src/multiprovider.ts";
import type { FetchLike } from "../src/usage.ts";

const NOW = Date.parse("2026-09-22T12:00:00Z");

const tempDirs: string[] = [];

afterEach(() => {
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

  registerOpencodeGoUsage(pi, { env, now: () => NOW, fetchImpl });

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
    command: () => commands.get("go-usage"),
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
        "{dim| · }{dim|mo }{success|99%}{dim| left}{dim| · ↺ 2h3m - 2:03 PM}{dim| · pi}",
    );
    expect(renderWidget(harness.lastWidget(), 20)).toMatch(/\{dim\|\.\.\./);
  });

  it("hides the reading for another provider", async () => {
    const harness = makeHarness({ provider: "xai" });
    await settle(harness);

    expect(harness.count()).toBe(0);
    for (const widget of harness.widgets) expect(widget.content).toBeUndefined();
  });

  it("still fetches when onlyOnOpencodeModel is off", async () => {
    const harness = makeHarness({ provider: "xai", config: { onlyOnOpencodeModel: false } });
    await settle(harness);

    expect(harness.count()).toBe(1);
    expect(harness.widgets.at(-1)?.content).toBeTypeOf("function");
  });

  it("falls back to the status line outside the TUI", async () => {
    const harness = makeHarness({ mode: "rpc" });
    await settle(harness);

    expect(harness.lastStatus()).toBe(
      "Usage: 5h 97% left · wk 99% left · mo 99% left · ↺ 2h3m - 2:03 PM · pi",
    );
  });
});

describe("footer modes", () => {
  it("status writes flat text to the footer", async () => {
    const harness = makeHarness({ config: { footerMode: "status" } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeUndefined();
    expect(harness.lastStatus()).toBe(
      "Usage: 5h 97% left · wk 99% left · mo 99% left · ↺ 2h3m - 2:03 PM · pi",
    );
  });

  it("off hides the reading but keeps /go-usage working", async () => {
    const harness = makeHarness({ config: { footerMode: "off" } });
    await settle(harness);

    expect(harness.widgets.at(-1)?.content).toBeUndefined();
    expect(harness.lastStatus()).toBeUndefined();

    await harness.command()?.("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("5h rolling: 3% used · 97% left");
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

    await harness.handlers.get("agent_end")?.({}, harness.ctx);
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
    expect(renderWidget(harness.lastWidget())).toBe("{dim|Go ?}");

    // Automatic refresh stays quiet until the cooldown expires.
    for (let i = 0; i < 3; i += 1) {
      await harness.handlers.get("agent_end")?.({}, harness.ctx);
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
    expect(renderWidget(harness.lastWidget())).toBe("{dim|Go ?}");

    await harness.command()?.("", harness.ctx);
    expect(harness.notifications.at(-1)).toContain("No OpenCode Go credential");
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
    expect(renderWidget(harness.lastWidget())).toContain("· pi");

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
  });
});

describe("/go-usage", () => {
  it("prints the per-window report", async () => {
    const harness = makeHarness();
    await settle(harness);
    await harness.command()?.("", harness.ctx);

    expect(harness.notifications.at(-1)).toContain("account: pi (pi)");
    expect(harness.notifications.at(-1)).toContain("5h rolling: 3% used · 97% left");
    expect(harness.notifications.at(-1)).toContain("go-usage refresh forces an immediate request");
  });

  it("omits the hint for an explicit refresh", async () => {
    const harness = makeHarness();
    await settle(harness);
    await harness.command()?.("refresh", harness.ctx);

    expect(harness.notifications.at(-1)).not.toContain("forces an immediate request");
  });

  it("explains that the reading is hidden for other models", async () => {
    const harness = makeHarness({ provider: "xai" });
    await settle(harness);
    await harness.command()?.("", harness.ctx);

    expect(harness.notifications.at(-1)).toContain("The reading is hidden for this model");
  });
});
