import type { ReadableStreamReadResult } from "node:stream/web";
import { awaitWithAbort } from "./abort.ts";

const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;

export type UsageErrorKind = "auth" | "http" | "invalid" | "oversize" | "transport";

export class UsageError extends Error {
  readonly kind: UsageErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: UsageErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "UsageError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

export type UsageResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
};

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "error" },
) => Promise<UsageResponse>;

/** Release an unread response without waiting on a stalled transport cleanup. */
export function discardResponseBody(response: UsageResponse): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* Cleanup must not replace the original HTTP or size error. */
  }
}

/** Bound body reads even when Content-Length is absent or a custom transport ignores abort. */
export async function readJsonResponse(
  response: UsageResponse,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    if (!response.body || typeof response.body.getReader !== "function")
      return await awaitWithAbort(response.json(), signal);
    const reader = response.body.getReader();
    let done = false;
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await awaitWithAbort(reader.read(), signal);
        } catch {
          // A body can disconnect after successful response headers. Keep
          // transport failures separate from parsing errors, without exposing
          // arbitrary transport messages that may contain credentials.
          throw new UsageError(
            "transport",
            "Usage response was interrupted. Check your connection.",
          );
        }
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new UsageError("oversize", "Usage response is too large.");
        chunks.push(part.value);
      }
      done = true;
      return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } finally {
      if (!done) void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* An interrupted read may still hold the lock. */
      }
    }
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (timeout.aborted) throw new UsageError("transport", "Usage response timed out.");
    throw error;
  }
}

/** Retry one failed connection without replaying HTTP errors or a caller cancellation. */
export async function fetchWithTransportRetry(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  callerSignal?: AbortSignal,
): Promise<UsageResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    callerSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let abandoned = false;
    let received: UsageResponse | undefined;
    try {
      const request = fetchImpl(url, { headers, signal, redirect: "error" }).then((response) => {
        received = response;
        if (abandoned) discardResponseBody(response);
        return response;
      });
      return await awaitWithAbort(request, signal);
    } catch (error) {
      // A custom transport may ignore cancellation and resolve after this
      // attempt is abandoned. Also cover a response racing the abort handler.
      abandoned = true;
      if (received) discardResponseBody(received);
      if (callerSignal?.aborted || attempt === 1) throw error;
    }
  }
  throw new Error("Unreachable request state");
}
