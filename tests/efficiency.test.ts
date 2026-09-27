import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerUsage } from "../index.ts";
import { ACCOUNTS_SERVICE_EVENT, type SavedUsageAccount } from "../src/multiprovider.ts";
import type { FetchLike, UsageResponse } from "../src/usage.ts";

const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const response = (status = 200, retryAfter: string | null = null): UsageResponse => ({
  ok: status === 200,
  status,
  headers: { get: (key) => (key === "retry-after" ? retryAfter : null) },
  json: async () => ({ usage: { weekly: { percent: 20 } } }),
});
function account(id: string, active = false): SavedUsageAccount {
  return { id, label: id, providerId: "opencode-go", authKind: "api_key", active };
}
function harness(
  options: {
    count?: number;
    inactive?: boolean;
    deferred?: boolean;
    status?: number;
    retryAfter?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "usage-efficiency-"));
  let accounts = Array.from({ length: options.count ?? 1 }, (_, i) =>
    account(`account-${i}`, i === 0),
  );
  let activeLabel: string | undefined;
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const events = new Map<string, Array<(value: any) => void>>();
  const changes = new Map<string, Array<(event?: { kind?: "metadata" }) => void>>();
  const commands = new Map<string, any>();
  const requests: Array<{ signal: AbortSignal; release: () => void }> = [];
  const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
    const signal = init!.signal!;
    let release = () => {};
    const pending = options.deferred
      ? new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
      : Promise.resolve();
    requests.push({ signal, release });
    await pending;
    return response(options.status, options.retryAfter);
  });
  const auth = vi.fn(async (id: string, _ctx: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { accessToken: `fixture-${id}`, label: activeLabel ?? id };
  });
  const service = {
    listAccounts: async () => accounts,
    getActiveAccount: async () => accounts[0],
    resolveAccountAuth: auth,
    resolveActiveAccountAuth: async (id: string, ctx: unknown, signal?: AbortSignal) =>
      id === "opencode-go" ? auth(accounts[0]!.id, ctx, signal) : undefined,
    onActiveAccountChanged: (id: string, fn: (event?: { kind?: "metadata" }) => void) => {
      changes.set(id, [...(changes.get(id) ?? []), fn]);
      return () => {};
    },
  };
  const ctx: any = {
    cwd: dir,
    mode: "rpc",
    hasUI: false,
    model: { provider: options.inactive ? "unsupported" : "opencode-go", id: "model-a" },
    modelRegistry: {},
    ui: { setWidget: vi.fn(), setStatus: vi.fn(), notify: vi.fn() },
  };
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    events: {
      on: (name: string, fn: any) => events.set(name, [...(events.get(name) ?? []), fn]),
      emit: (name: string, value: any) => events.get(name)?.forEach((fn) => fn(value)),
    },
  };
  registerUsage(pi, {
    env: { PI_CODING_AGENT_DIR: dir, PI_GROK_AUTH_PATH: join(dir, "missing") },
    fetchImpl,
  });
  pi.events.emit(ACCOUNTS_SERVICE_EVENT, service);
  const emit = (name: string) => handlers.get(name)?.forEach((fn) => fn({ model: ctx.model }, ctx));
  cleanups.push(() => {
    emit("session_shutdown");
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    emit,
    requests,
    ctx,
    auth,
    command: () => commands.get("usage").handler("", ctx),
    switchAccount(id: string) {
      accounts = [account(id, true)];
      changes.get("opencode-go")?.forEach((fn) => fn());
    },
    changeEmail(email: string) {
      accounts = accounts.map((value) => ({ ...value, email }));
      changes.get("opencode-go")?.forEach((fn) => fn({ kind: "metadata" }));
    },
    changeLabel(label: string) {
      activeLabel = label;
      accounts = accounts.map((value) => (value.active ? { ...value, label } : value));
      changes.get("opencode-go")?.forEach((fn) => fn({ kind: "metadata" }));
    },
  };
}

it("shares one startup request between footer, saved report and an overlapping command", async () => {
  const h = harness({ deferred: true });
  h.emit("session_start");
  await settle();
  const command = h.command();
  await settle();
  expect(h.requests).toHaveLength(1);
  h.requests[0]!.release();
  await command;
  expect(h.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("account-0 [Current]");
  for (let i = 0; i < 3; i++) {
    h.ctx.model = { ...h.ctx.model, id: `model-${i}` };
    h.emit("model_select");
    await settle();
  }
  expect(h.requests).toHaveLength(1);
});

it("the footer and periodic saved-account refresh also share an expired reading", async () => {
  const h = harness();
  h.emit("session_start");
  await settle();
  expect(h.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.requests).toHaveLength(2);
  await h.command();
  expect(h.requests).toHaveLength(2);
});

it("updates saved email without repeating a fresh quota request", async () => {
  const h = harness();
  h.emit("session_start");
  await settle();
  expect(h.requests).toHaveLength(1);
  h.changeEmail("work@example.com");
  await settle();
  await h.command();
  expect(h.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("work@example.com");
  expect(h.requests).toHaveLength(1);
});

it("updates the footer label after an in-flight quota request without fetching it again", async () => {
  const h = harness({ deferred: true });
  h.emit("session_start");
  await settle();
  expect(h.requests).toHaveLength(1);
  h.changeLabel("preferred-alias");
  await settle();
  h.requests[0]!.release();
  await settle();
  const status = h.ctx.ui.setStatus.mock.calls.at(-1)?.[1] ?? "";
  expect(status).toContain("preferred-alias");
  expect(h.requests).toHaveLength(1);
});

it("shutdown cancels all running saved queries and never starts queued accounts", async () => {
  const h = harness({ count: 6, inactive: true, deferred: true });
  h.emit("session_start");
  await settle();
  expect(h.requests).toHaveLength(3);
  expect(h.auth.mock.calls.every((call) => call[2] instanceof AbortSignal)).toBe(true);
  h.emit("session_shutdown");
  expect(h.requests.every((request) => request.signal.aborted)).toBe(true);
  await settle();
  expect(h.requests).toHaveLength(3);
  expect(h.auth).toHaveBeenCalledTimes(3);
});

it("changing accounts cancels old queries and immediately starts the new roster", async () => {
  const h = harness({ deferred: true });
  h.emit("session_start");
  await settle();
  h.switchAccount("new-account");
  expect(h.requests[0]!.signal.aborted).toBe(true);
  await settle();
  expect(h.requests).toHaveLength(2);
  h.requests[1]!.release();
  await settle();
  await h.command();
  const report = h.ctx.ui.notify.mock.calls.at(-1)[0];
  expect(report).toContain("new-account [Current]");
  expect(report).not.toContain("account-0");
});

it("an inactive footer cannot cancel the saved report's shared transport", async () => {
  const h = harness({ deferred: true });
  h.emit("session_start");
  await settle();
  h.ctx.model = { provider: "unsupported", id: "other" };
  h.emit("model_select");
  expect(h.requests[0]!.signal.aborted).toBe(false);
  h.requests[0]!.release();
  await settle();
  await h.command();
  expect(h.ctx.ui.notify.mock.calls.at(-1)[0]).toContain("80% left");
  expect(h.requests).toHaveLength(1);
});

it("429 backoff is shared by footer, commands and periodic account reports", async () => {
  const h = harness({ status: 429, retryAfter: "90" });
  h.emit("session_start");
  await settle();
  expect(h.requests).toHaveLength(1);
  for (let i = 0; i < 3; i++) {
    h.emit("turn_end");
    await settle();
    await h.command();
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  h.emit("turn_end");
  await settle();
  expect(h.requests).toHaveLength(2);
  h.switchAccount("different-credential");
  await settle();
  expect(h.requests).toHaveLength(3);
});
