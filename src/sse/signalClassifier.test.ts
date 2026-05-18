// EN (PR-2, 2026-05-18): unit tests for the ①②③ classifier.
// Proves the create/patch/ack/noop split + the ③ render-suppression
// decision (the "redundant confirm" case). ④ retract is PR-3 — not
// asserted here.
//
// 中: PR-2 ①②③ 分类器单测。④ retract 属 PR-3，不在此断言。

import { describe, expect, it } from "vitest";

import { classifySignal } from "@/sse/signalClassifier";
import type { UnifiedSignal } from "@/sse/signalNormalizer";

function sig(o: Partial<UnifiedSignal>): UnifiedSignal {
  return {
    loomId: undefined,
    version: null,
    hasContent: false,
    lifecycle: null,
    reconcileReason: null,
    sourceType: "test",
    ...o,
  };
}

describe("classifySignal — ① create", () => {
  it("unseen loomId → create", () => {
    const r = classifySignal(sig({ loomId: "L1", hasContent: true }), {
      loomIdSeen: () => false,
      appliedVersion: null,
    });
    expect(r.kind).toBe("create");
    expect(r.suppressRender).toBe(false);
  });
});

describe("classifySignal — ② patch", () => {
  it("seen loomId + new content → patch", () => {
    const r = classifySignal(
      sig({ loomId: "L1", hasContent: true, version: 9 }),
      { loomIdSeen: () => true, appliedVersion: 3 },
    );
    expect(r.kind).toBe("patch");
  });
  it("no loomId but carries content (pre-binding delta path) → patch", () => {
    const r = classifySignal(sig({ hasContent: true, version: 4 }), {
      loomIdSeen: () => false,
      appliedVersion: 3,
    });
    expect(r.kind).toBe("patch");
  });
});

describe("classifySignal — ③ ack (render suppression)", () => {
  it("version ≤ appliedVersion AND no content → ack + suppressRender", () => {
    const r = classifySignal(sig({ version: 5, hasContent: false }), {
      loomIdSeen: () => true,
      appliedVersion: 5,
    });
    expect(r.kind).toBe("ack");
    expect(r.suppressRender).toBe(true);
  });
  it("strictly-behind version, no content → ack", () => {
    const r = classifySignal(sig({ version: 2, hasContent: false }), {
      loomIdSeen: () => false,
      appliedVersion: 9,
    });
    expect(r.kind).toBe("ack");
    expect(r.suppressRender).toBe(true);
  });
  it("a stale duplicate that ALSO has a seen loomId is still ack, not patch", () => {
    // ③ is checked before ② so a re-sent old node can't masquerade
    // as a fresh patch.
    const r = classifySignal(
      sig({ loomId: "L1", version: 3, hasContent: false }),
      { loomIdSeen: () => true, appliedVersion: 7 },
    );
    expect(r.kind).toBe("ack");
  });
  it("seen loomId, no content, NOT behind watermark → still ack (in-band confirm)", () => {
    const r = classifySignal(
      sig({ loomId: "L1", version: 10, hasContent: false }),
      { loomIdSeen: () => true, appliedVersion: 4 },
    );
    expect(r.kind).toBe("ack");
    expect(r.suppressRender).toBe(true);
  });
});

describe("classifySignal — noop (control/heartbeat)", () => {
  it("ping-like signal (no loomId, no content, no version) → noop", () => {
    const r = classifySignal(sig({}), {
      loomIdSeen: () => false,
      appliedVersion: 5,
    });
    expect(r.kind).toBe("noop");
    expect(r.suppressRender).toBe(false);
  });
  it("hello-like (reconcileReason set but no content/version) → noop (scheduler handles it)", () => {
    const r = classifySignal(sig({ reconcileReason: "hello-reconnect" }), {
      loomIdSeen: () => false,
      appliedVersion: null,
    });
    expect(r.kind).toBe("noop");
  });
});

describe("classifySignal — null watermark guards", () => {
  it("appliedVersion null → never ack on version (cannot prove redundancy) → content patches", () => {
    const r = classifySignal(sig({ version: 1, hasContent: true }), {
      loomIdSeen: () => false,
      appliedVersion: null,
    });
    expect(r.kind).toBe("patch");
  });
  it("appliedVersion null + no content + no loomId → noop (not a false ack)", () => {
    const r = classifySignal(sig({ version: 1, hasContent: false }), {
      loomIdSeen: () => false,
      appliedVersion: null,
    });
    expect(r.kind).toBe("noop");
  });
});
