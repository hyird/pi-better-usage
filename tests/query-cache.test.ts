import { expect, it, vi } from "vitest";
import { UsageQueryCache } from "../src/query-cache.ts";
import type { UsageProvider } from "../src/providers.ts";
import { type UsageSnapshot } from "../src/usage.ts";
import { UsageError, retryAfterMs } from "../src/http.ts";

const credential = { apiKey: "fixture", fingerprint: "one", label: "test", source: "pi" as const };
const snapshot: UsageSnapshot = { capturedAt: 0, windows: {} };
const options = { providerId: "openai-codex", ttl: 60_000 };
const provider = (fetch: UsageProvider["fetch"]) =>
  ({
    id: "openai",
    name: "OpenAI",
    providerIds: ["openai-codex", "alias"],
    loginHint: "fixture",
    resolve: async () => credential,
    fetch,
  }) as UsageProvider;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

it("shares in-flight requests and fresh readings without extending their TTL", async () => {
  let now = 0;
  let release!: () => void;
  const fetch = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return snapshot;
  });
  const p = provider(fetch);
  const cache = new UsageQueryCache({ now: () => now });
  const first = cache.read(p, credential, options);
  const second = cache.read(p, credential, options);
  await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  release();
  expect(await first).toEqual(await second);
  now = 59_999;
  expect((await cache.read(p, credential, options)).fetchedAt).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  now = 60_000;
  const expired = cache.read(p, credential, options);
  await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  release();
  await expired;
});

it("expires readings and failure cooldowns when the clock moves backward", async () => {
  let now = 1_000_000;
  let fail = false;
  const fetch = vi.fn(async () => {
    if (fail) throw new UsageError("transport", "offline");
    return snapshot;
  });
  const cache = new UsageQueryCache({ now: () => now });
  const p = provider(fetch);
  await cache.read(p, credential, options);
  now = 500_000;
  await cache.read(p, credential, options);
  expect(fetch).toHaveBeenCalledTimes(2);
  now += options.ttl;
  fail = true;
  await expect(cache.read(p, credential, options)).rejects.toThrow("offline");
  now -= 1_000;
  fail = false;
  await cache.read(p, credential, options);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("isolates credentials, account IDs, aliases and Spark quota buckets", async () => {
  const fetch = vi.fn(async () => snapshot);
  const p = provider(fetch);
  const cache = new UsageQueryCache();
  await cache.read(p, credential, options);
  await cache.read(p, { ...credential, fingerprint: "two" }, options);
  await cache.read(p, { ...credential, accountId: "another" }, options);
  await cache.read(p, credential, { ...options, providerId: "alias" });
  await cache.read(p, credential, { ...options, modelId: "gpt-5.3-codex-spark" });
  await cache.read(p, credential, { ...options, modelId: "another-default-model" });
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("shares Grok quota across aliases but keeps credentials separate and clears every alias", async () => {
  let release!: () => void;
  const fetch = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return snapshot;
  });
  const grok = {
    ...provider(fetch),
    id: "grok",
    name: "Grok",
    providerIds: ["xai", "xai-oauth", "xai-auth"],
  } as UsageProvider;
  const cache = new UsageQueryCache();
  const first = cache.read(grok, credential, { providerId: "xai", ttl: 60_000 });
  const second = cache.read(grok, credential, { providerId: "xai-oauth", ttl: 60_000 });
  await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  await cache.read(grok, credential, { providerId: "xai-auth", ttl: 60_000 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const other = cache.read(
    grok,
    { ...credential, fingerprint: "other" },
    { providerId: "xai", ttl: 60_000 },
  );
  await settle();
  release();
  await other;
  expect(fetch).toHaveBeenCalledTimes(2);
  cache.clear("xai-oauth");
  const cleared = cache.read(grok, credential, { providerId: "xai", ttl: 60_000 });
  await settle();
  release();
  await cleared;
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("cancelling one subscriber keeps the other subscriber's request alive", async () => {
  let release!: () => void;
  let signal!: AbortSignal;
  const p = provider(async (_key, opts) => {
    signal = opts.signal!;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return snapshot;
  });
  const cache = new UsageQueryCache();
  const controller = new AbortController();
  const first = cache
    .read(p, credential, { ...options, signal: controller.signal })
    .catch((error) => error);
  const second = cache.read(p, credential, options);
  await settle();
  controller.abort();
  expect((await first).name).toBe("AbortError");
  expect(signal.aborted).toBe(false);
  release();
  expect((await second).snapshot).toBe(snapshot);
});

it("all subscribers cancelling aborts the transport; late results cannot replace new data", async () => {
  const requests: { signal: AbortSignal; release: (value: UsageSnapshot) => void }[] = [];
  const p = provider(
    async (_key, opts) =>
      new Promise((resolve) => requests.push({ signal: opts.signal!, release: resolve })),
  );
  const cache = new UsageQueryCache();
  const controller = new AbortController();
  const old = cache
    .read(p, credential, { ...options, signal: controller.signal })
    .catch((error) => error);
  await settle();
  controller.abort();
  expect((await old).name).toBe("AbortError");
  expect(requests[0]!.signal.aborted).toBe(true);
  const current = cache.read(p, credential, options);
  await settle();
  const newer = { ...snapshot, capturedAt: 2 };
  requests[1]!.release(newer);
  await current;
  requests[0]!.release(snapshot);
  await settle();
  expect((await cache.read(p, credential, options)).snapshot).toEqual(newer);
});

it("prunes excess entries after a burst of concurrent account requests settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async () => {
    await gate;
    return snapshot;
  });
  const p = provider(fetch);
  const cache = new UsageQueryCache();
  const reads = Array.from({ length: 130 }, (_, index) =>
    cache.read(p, { ...credential, fingerprint: `account-${index}` }, options),
  );
  await settle();
  expect(fetch).toHaveBeenCalledTimes(130);
  release();
  await Promise.all(reads);
  await cache.read(p, { ...credential, fingerprint: "account-129" }, options);
  expect(fetch).toHaveBeenCalledTimes(130);
  await cache.read(p, { ...credential, fingerprint: "account-0" }, options);
  expect(fetch).toHaveBeenCalledTimes(131);
});

it("keeps a recently used account when a new account fills the cache", async () => {
  const fetch = vi.fn(async () => snapshot);
  const p = provider(fetch);
  const cache = new UsageQueryCache();
  const account = (index: number) => ({ ...credential, fingerprint: `account-${index}` });
  for (let index = 0; index < 128; index++) await cache.read(p, account(index), options);
  await cache.read(p, account(0), options);
  await cache.read(p, account(128), options);
  await cache.read(p, account(0), options);
  expect(fetch).toHaveBeenCalledTimes(129);
  await cache.read(p, account(1), options);
  expect(fetch).toHaveBeenCalledTimes(130);
});

it("clearing the session promptly rejects waiters even if a provider ignores abort", async () => {
  let release!: (value: UsageSnapshot) => void;
  const p = provider(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const cache = new UsageQueryCache();
  const pending = cache.read(p, credential, options).catch((error) => error);
  await settle();
  cache.clear();
  expect((await pending).name).toBe("AbortError");
  release(snapshot);
  await settle();
});

it("backs off across consumers, honors Retry-After and resets after success", async () => {
  let now = 0;
  let fail = true;
  const fetch = vi.fn(async () => {
    if (fail) throw new UsageError("http", "limited", 429, 90_000);
    return snapshot;
  });
  const cache = new UsageQueryCache({ now: () => now });
  const p = provider(fetch);
  await expect(cache.read(p, credential, options)).rejects.toThrow("limited");
  now = 60_000;
  await expect(cache.read(p, credential, options)).rejects.toThrow("limited");
  expect(fetch).toHaveBeenCalledTimes(1);
  now = 90_000;
  await expect(cache.read(p, credential, options)).rejects.toThrow("limited");
  now = 209_999;
  await expect(cache.read(p, credential, options)).rejects.toThrow("limited");
  expect(fetch).toHaveBeenCalledTimes(2);
  now = 210_000;
  fail = false;
  await cache.read(p, credential, options);
  expect(fetch).toHaveBeenCalledTimes(3);
  now += 60_000;
  fail = true;
  await expect(cache.read(p, credential, options)).rejects.toThrow("limited");
  now += 90_000;
  fail = false;
  await cache.read(p, credential, options);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("parses numeric and date Retry-After values and ignores invalid ones", () => {
  expect(retryAfterMs("120", 0)).toBe(120_000);
  expect(retryAfterMs("Thu, 01 Jan 1970 00:02:00 GMT", 60_000)).toBe(60_000);
  expect(retryAfterMs("bad")).toBeUndefined();
  expect(retryAfterMs("-1")).toBeUndefined();
});
