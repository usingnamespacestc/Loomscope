// PR-1 (2026-05-18, convergence rework §9.4): every outbound SSE
// signal must carry a top-level `version` so the client has ONE
// place to read the server-authoritative monotonic seq regardless of
// event type. Reproduce-first: these assert the stamping is present,
// non-overriding, and inert for non-object payloads.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTests,
  broadcast,
  setSseVersionResolver,
  subscribe,
  type SseMessage,
} from "@/server/services/sseHub";

const SID = "11111111-1111-4000-8000-000000000abc";

beforeEach(() => {
  _resetForTests();
  // Default resolver back to 0 (constructor default) between tests.
  setSseVersionResolver(() => 0);
});

afterEach(() => {
  _resetForTests();
  setSseVersionResolver(() => 0);
});

function collect(): { received: SseMessage[]; unsub: () => void } {
  const received: SseMessage[] = [];
  const unsub = subscribe(SID, { send: (m) => received.push(m) });
  return { received, unsub };
}

describe("sseHub — PR-1 version stamping", () => {
  it("stamps the resolver's version onto an object payload", () => {
    setSseVersionResolver((sid) => (sid === SID ? 42 : -1));
    const { received } = collect();
    broadcast(SID, { event: "raw-records", data: { records: [] } });
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ records: [], version: 42 });
  });

  it("leaves seq-carrying payloads byte-identical (delta/checkpoint/drift-ping unchanged — no version injected)", () => {
    // The regression guard: stamping `version` onto a `delta` payload
    // changed its wire shape and broke chatFlowDeltaEngine's exact-
    // shape tests. PR-1 must be ZERO wire change for already-
    // versioned (seq-carrying) events.
    setSseVersionResolver(() => 999);
    const { received } = collect();
    broadcast(SID, {
      event: "delta",
      data: { type: "chatnode-added", seq: 7 },
    });
    expect(received[0].data).toEqual({ type: "chatnode-added", seq: 7 });
    expect(
      (received[0].data as Record<string, unknown>).version,
    ).toBeUndefined();
  });

  it("does NOT override a version the payload already carries", () => {
    setSseVersionResolver(() => 999);
    const { received } = collect();
    broadcast(SID, { event: "custom", data: { foo: 1, version: 3 } });
    expect((received[0].data as { version: number }).version).toBe(3);
  });

  it("leaves non-object payloads untouched (no crash, no wrap)", () => {
    setSseVersionResolver(() => 5);
    const { received } = collect();
    broadcast(SID, { event: "ping", data: null });
    broadcast(SID, { event: "x", data: "scalar" });
    broadcast(SID, { event: "y", data: [1, 2] });
    expect(received[0].data).toBeNull();
    expect(received[1].data).toBe("scalar");
    expect(received[2].data).toEqual([1, 2]);
  });

  it("default resolver yields 0 (safe pre-wire / test boot)", () => {
    const { received } = collect();
    broadcast(SID, { event: "invalidate", data: { kind: "main" } });
    expect((received[0].data as { version: number }).version).toBe(0);
  });

  it("is per-session — resolver is called with the broadcast sessionId", () => {
    const seen: string[] = [];
    setSseVersionResolver((sid) => {
      seen.push(sid);
      return 1;
    });
    collect();
    broadcast(SID, { event: "cc-hook", data: { event: "Stop" } });
    expect(seen).toEqual([SID]);
  });
});
