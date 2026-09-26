import type { UsageCredential } from "./credential.ts";
import type { UsageProvider } from "./providers.ts";
import { UsageError, type FetchLike, type UsageSnapshot } from "./usage.ts";

export function quotaScope(provider: UsageProvider, providerId?: string, modelId?: string): string {
  const matches = provider.providerIds.includes(providerId ?? "");
  const id = matches ? providerId! : provider.providerIds[0]!;
  const bucket =
    provider.id === "openai" && matches && modelId === "gpt-5.3-codex-spark" ? "spark" : "default";
  return `${id}:${bucket}`;
}

export function failureDelay(error: UsageError, failures: number): number {
  if (error.kind === "auth") return 10 * 60_000;
  const base = error.status === 429 ? 60_000 : 15_000;
  return Math.max(
    error.retryAfterMs ?? 0,
    Math.min(5 * 60_000, base * 2 ** Math.min(failures - 1, 5)),
  );
}

type Reading = { snapshot: UsageSnapshot; fetchedAt: number };
type Pending = {
  controller: AbortController;
  promise: Promise<Reading>;
  users: number;
  settled: boolean;
};
type Entry = {
  scope: string;
  reading?: Reading;
  error?: UsageError;
  retryAt: number;
  failures: number;
  pending?: Pending;
};

/** Per-extension cache: share quota data, never account labels or raw credentials. */
export class UsageQueryCache {
  private entries = new Map<string, Entry>();
  constructor(private options: { now?: () => number; fetchImpl?: FetchLike } = {}) {}

  clear(providerId?: string): void {
    for (const [key, entry] of this.entries) {
      if (providerId && !entry.scope.startsWith(`${providerId}:`)) continue;
      this.entries.delete(key);
      entry.pending?.controller.abort();
    }
  }

  async read(
    provider: UsageProvider,
    credential: UsageCredential,
    options: {
      providerId?: string;
      modelId?: string;
      ttl: number;
      signal?: AbortSignal;
    },
  ): Promise<Reading> {
    options.signal?.throwIfAborted();
    const now = this.options.now ?? Date.now;
    const scope = quotaScope(provider, options.providerId, options.modelId);
    const key = JSON.stringify([scope, credential.fingerprint, credential.accountId]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { scope, failures: 0, retryAt: 0 };
      this.entries.set(key, entry);
      // Account rosters can change for the lifetime of a session. Retain at most
      // 128 idle entries, while allowing all in-flight requests to finish.
      for (const [oldKey, old] of this.entries) {
        if (this.entries.size <= 128) break;
        if (old !== entry && !old.pending) this.entries.delete(oldKey);
      }
    }
    if (entry.error && now() < entry.retryAt) throw entry.error;
    if (!entry.error && entry.reading && now() - entry.reading.fetchedAt < options.ttl)
      return entry.reading;
    if (!entry.pending) {
      const current = entry;
      const controller = new AbortController();
      const pending: Pending = { controller, users: 0, settled: false, promise: undefined! };
      current.pending = pending;
      pending.promise = Promise.resolve()
        .then(async () => {
          controller.signal.throwIfAborted();
          const snapshot = await provider.fetch(credential, {
            modelId: provider.providerIds.includes(options.providerId ?? "")
              ? options.modelId
              : undefined,
            signal: controller.signal,
            fetchImpl: this.options.fetchImpl,
            now: now(),
          });
          controller.signal.throwIfAborted();
          const reading = { snapshot, fetchedAt: now() };
          if (this.entries.get(key) === current) {
            current.reading = reading;
            current.error = undefined;
            current.failures = 0;
            current.retryAt = 0;
          }
          return reading;
        })
        .catch((error) => {
          controller.signal.throwIfAborted();
          const failure =
            error instanceof UsageError
              ? error
              : new UsageError("transport", `${provider.name} usage is unavailable.`);
          if (this.entries.get(key) === current) {
            current.error = failure;
            current.retryAt = now() + failureDelay(failure, ++current.failures);
          }
          throw failure;
        })
        .finally(() => {
          pending.settled = true;
          if (current.pending === pending) current.pending = undefined;
        });
    }
    const current = entry;
    const pending = entry.pending!;
    const signal = options.signal
      ? AbortSignal.any([options.signal, pending.controller.signal])
      : pending.controller.signal;
    pending.users++;
    return new Promise<Reading>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener("abort", abort);
        if (--pending.users === 0 && !pending.settled) {
          if (current.pending === pending) current.pending = undefined;
          pending.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (release()) reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (error) => {
          if (release()) reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }
}
