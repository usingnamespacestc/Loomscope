// EN (PR-2, 2026-05-18): unit tests for the unified signal
// normaliser. One assertion block per SSE event type proving the
// folded shape (loomId / version / hasContent / lifecycle /
// reconcileReason) is what the classifier + scheduler expect.
//
// 中: PR-2 归一化器单测，逐事件类型断言折叠形状。

import { describe, expect, it } from "vitest";

import { normalizeSignal } from "@/sse/signalNormalizer";

describe("normalizeSignal — file delta channel", () => {
  it("chatnode-added → versioned + content", () => {
    const s = normalizeSignal("delta", {
      type: "chatnode-added",
      seq: 42,
      chatNode: { id: "p1", loomId: "L-1" },
    });
    expect(s).toMatchObject({
      version: 42,
      hasContent: true,
      loomId: "L-1",
      reconcileReason: null,
      sourceType: "delta",
    });
  });
  it("chatnode-summary-updated → versioned + content", () => {
    const s = normalizeSignal("delta", {
      type: "chatnode-summary-updated",
      seq: 43,
      chatNodeId: "p1",
    });
    expect(s.version).toBe(43);
    expect(s.hasContent).toBe(true);
  });
  it("checkpoint → versioned, NO content", () => {
    const s = normalizeSignal("delta", {
      type: "checkpoint",
      seq: 44,
      chatNodeCount: 10,
    });
    expect(s.version).toBe(44);
    expect(s.hasContent).toBe(false);
  });
  it("malformed delta → safe defaults (no throw)", () => {
    const s = normalizeSignal("delta", { type: 123, seq: "nope" });
    expect(s.version).toBeNull();
    expect(s.hasContent).toBe(false);
  });
});

describe("normalizeSignal — raw-records fast path", () => {
  it("non-empty records → content, no version", () => {
    const s = normalizeSignal("raw-records", {
      sessionId: "x",
      records: [{ uuid: "u1" }],
    });
    expect(s.hasContent).toBe(true);
    expect(s.version).toBeNull();
  });
  it("empty records → no content", () => {
    const s = normalizeSignal("raw-records", { sessionId: "x", records: [] });
    expect(s.hasContent).toBe(false);
  });
});

describe("normalizeSignal — drift-ping", () => {
  it("carries seq as version, no content, no implied reason (handler decides on local compare)", () => {
    const s = normalizeSignal("drift-ping", {
      sessionId: "x",
      seq: 70,
      chatNodeCount: 5,
      hash: "abc",
    });
    expect(s.version).toBe(70);
    expect(s.hasContent).toBe(false);
    expect(s.reconcileReason).toBeNull();
  });
});

describe("normalizeSignal — invalidate", () => {
  it("main invalidate → reconcile reason 'invalidate'", () => {
    const s = normalizeSignal("invalidate", { sessionId: "x", kind: "main" });
    expect(s.reconcileReason).toBe("invalidate");
  });
  it("tasks-kind invalidate → NO reconcile reason (task churn ≠ content)", () => {
    const s = normalizeSignal("invalidate", { sessionId: "x", kind: "tasks" });
    expect(s.reconcileReason).toBeNull();
  });
  it("kind-less invalidate (back-compat) → reconcile reason", () => {
    const s = normalizeSignal("invalidate", { sessionId: "x" });
    expect(s.reconcileReason).toBe("invalidate");
  });
});

describe("normalizeSignal — sdk lifecycle", () => {
  it("sdk-queue-state running → lifecycle running, no reconcile", () => {
    const s = normalizeSignal("sdk-queue-state", {
      sessionId: "x",
      state: "running",
    });
    expect(s.lifecycle).toBe("running");
    expect(s.reconcileReason).toBeNull();
  });
  it("sdk-queue-state idle → lifecycle idle + quiescence reconcile", () => {
    const s = normalizeSignal("sdk-queue-state", {
      sessionId: "x",
      state: "idle",
    });
    expect(s.lifecycle).toBe("idle");
    expect(s.reconcileReason).toBe("sdk-idle");
  });
  it("sdk-message → running + reconcile reason", () => {
    const s = normalizeSignal("sdk-message", { type: "assistant" });
    expect(s.lifecycle).toBe("running");
    expect(s.reconcileReason).toBe("sdk-message");
  });
  it("sdk-session-closed → idle + reconcile reason", () => {
    const s = normalizeSignal("sdk-session-closed", { sessionId: "x" });
    expect(s.lifecycle).toBe("idle");
    expect(s.reconcileReason).toBe("sdk-session-closed");
  });
});

describe("normalizeSignal — connection control", () => {
  it("hello → hello-reconnect reason (handler dedups first vs reconnect)", () => {
    expect(normalizeSignal("hello", {}).reconcileReason).toBe(
      "hello-reconnect",
    );
  });
  it("ping → pure heartbeat, nothing", () => {
    const s = normalizeSignal("ping", {});
    expect(s).toMatchObject({
      version: null,
      hasContent: false,
      lifecycle: null,
      reconcileReason: null,
    });
  });
  it("cc-hook → shape only (no reconcile; ghost-hazard avoided per §9.3)", () => {
    const s = normalizeSignal("cc-hook", {
      event: "Stop",
      payload: { session_id: "x", loomId: "L-9", extras: {} },
    });
    expect(s.reconcileReason).toBeNull();
    expect(s.loomId).toBe("L-9");
  });
  it("orthogonal control planes (rate-limit/deferral/respawn/permission) → shape only", () => {
    for (const t of [
      "sdk-rate-limit",
      "sdk-deferral",
      "sdk-respawn-notice",
      "permission-prompt",
      "permission-prompt-resolved",
      "totally-unknown",
    ]) {
      const s = normalizeSignal(t, { sessionId: "x" });
      expect(s.reconcileReason).toBeNull();
      expect(s.version).toBeNull();
      expect(s.hasContent).toBe(false);
    }
  });
});

describe("normalizeSignal — top-level loomId passthrough", () => {
  it("picks up a top-level loomId when no node-level one", () => {
    const s = normalizeSignal("delta", {
      type: "chatnode-summary-updated",
      seq: 5,
      loomId: "L-top",
    });
    expect(s.loomId).toBe("L-top");
  });
});
