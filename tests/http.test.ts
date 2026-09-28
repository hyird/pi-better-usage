import { expect, it, vi } from "vitest";
import {
  fetchWithTransportRetry,
  readJsonResponse,
  MAX_RESPONSE_BYTES,
  type FetchLike,
  type UsageResponse,
} from "../src/http.ts";

it("bounds accumulated response bytes and releases oversized streams", async () => {
  for (const size of [MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1]) {
    const bytes = new TextEncoder().encode(JSON.stringify("x".repeat(size - 2)));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
          controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
        if (size === MAX_RESPONSE_BYTES) controller.close();
      },
      cancel,
    });
    const reading = readJsonResponse(new Response(body));
    if (size === MAX_RESPONSE_BYTES) {
      expect(((await reading) as string).length).toBe(size - 2);
      expect(cancel).not.toHaveBeenCalled();
    } else {
      await expect(reading).rejects.toMatchObject({ kind: "oversize" });
      expect(cancel).toHaveBeenCalledOnce();
    }
    expect(body.locked).toBe(false);
  }
});

it.each([false, true])(
  "discards a response arriving around cancellation: %s",
  async (arrivesFirst) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response: UsageResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({ cancel }),
      json: vi.fn(),
    };
    let release!: (response: UsageResponse) => void;
    const fetchImpl = vi.fn<FetchLike>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = fetchWithTransportRetry(
      fetchImpl,
      "https://example.test/usage",
      {},
      controller.signal,
    );
    if (arrivesFirst) release(response);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    if (!arrivesFirst) release(response);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(response.json).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  },
);

it("discards a timed-out response without cancelling the successful retry", async () => {
  const timeout = new AbortController();
  const clock = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(timeout.signal)
    .mockReturnValueOnce(new AbortController().signal);
  const cancelOld = vi.fn();
  const cancelNew = vi.fn();
  const response = (cancel: () => void): UsageResponse => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({ cancel }),
    json: async () => ({}),
  });
  const replacement = response(cancelNew);
  let release!: (response: UsageResponse) => void;
  const fetchImpl = vi
    .fn<FetchLike>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(replacement);
  try {
    const pending = fetchWithTransportRetry(fetchImpl, "https://example.test/usage", {});
    timeout.abort();
    expect(await pending).toBe(replacement);
    release(response(cancelOld));
    await vi.waitFor(() => expect(cancelOld).toHaveBeenCalledOnce());
    expect(cancelNew).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
    await replacement.body?.cancel();
  }
});
