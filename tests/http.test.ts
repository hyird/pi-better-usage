import { expect, it, vi } from "vitest";
import { fetchWithTransportRetry, type FetchLike, type UsageResponse } from "../src/http.ts";

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
