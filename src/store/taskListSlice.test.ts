import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "@/store/index";

const SID = "11111111-1111-4000-8000-000000000aaa";

describe("taskListSlice — refresh debounce / coalescing", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let calls: number;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    useStore.getState().clearTasks(SID);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it("two near-simultaneous refreshTasks calls coalesce into one fetch", async () => {
    const p1 = useStore.getState().refreshTasks(SID);
    const p2 = useStore.getState().refreshTasks(SID);
    // Advance past the 80ms debounce window.
    await vi.advanceTimersByTimeAsync(120);
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it("calls outside the debounce window each get their own fetch", async () => {
    const p1 = useStore.getState().refreshTasks(SID);
    await vi.advanceTimersByTimeAsync(120);
    await p1;
    expect(calls).toBe(1);

    const p2 = useStore.getState().refreshTasks(SID);
    await vi.advanceTimersByTimeAsync(120);
    await p2;
    expect(calls).toBe(2);
  });

  it("a third call within the window resets the timer (single fetch)", async () => {
    const p1 = useStore.getState().refreshTasks(SID);
    await vi.advanceTimersByTimeAsync(40);
    const p2 = useStore.getState().refreshTasks(SID);
    await vi.advanceTimersByTimeAsync(40);
    const p3 = useStore.getState().refreshTasks(SID);
    // After the third call, timer was just reset; need another 80ms.
    await vi.advanceTimersByTimeAsync(120);
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
  });

  it("clearTasks cancels a pending debounced refresh and resolves the promise", async () => {
    const p = useStore.getState().refreshTasks(SID);
    // Don't advance — clear before timer fires.
    useStore.getState().clearTasks(SID);
    await vi.advanceTimersByTimeAsync(120);
    await p; // should resolve, not hang
    expect(calls).toBe(0);
  });

  it("does not abort an inflight fetch when a new debounce batch starts", async () => {
    // Reproducing the "failed to load response data" symptom: when
    // a fetch is slow enough to still be inflight after the next
    // debounce window expires, we previously called .abort() on it
    // — surfacing as "(canceled)" in devtools. Last-write-wins via
    // controller mismatch is enough; abort is removed.
    const signals: AbortSignal[] = [];
    let resolveFirst: ((r: Response) => void) | null = null;

    fetchSpy.mockReset();
    fetchSpy.mockImplementationOnce((_url: unknown, opts: unknown) => {
      signals.push((opts as RequestInit).signal as AbortSignal);
      return new Promise<Response>((res) => {
        resolveFirst = res;
      });
    });
    fetchSpy.mockImplementationOnce(async (_url: unknown, opts: unknown) => {
      signals.push((opts as RequestInit).signal as AbortSignal);
      return new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const p1 = useStore.getState().refreshTasks(SID);
    await vi.advanceTimersByTimeAsync(120);
    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(false);

    // Trigger second batch while first is still inflight.
    const p2 = useStore.getState().refreshTasks(SID);
    await vi.advanceTimersByTimeAsync(120);
    expect(signals.length).toBe(2);
    // CRITICAL: fetch1's signal must NOT have been aborted.
    expect(signals[0].aborted).toBe(false);

    // Cleanup so the test doesn't hang on the dangling promise.
    resolveFirst!(
      new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await Promise.all([p1, p2]);
  });
});
