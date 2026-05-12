// Unit tests for the SDK channel slice — race-mitigation respawn
// notice in particular. The other reducers (queue-state /
// session-closed / error) have de-facto coverage through the broader
// integration tests; this file lands now because the new
// `respawnNotice` shape needs a dedicated check (set / clear /
// idempotent-clear-on-empty).

import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store/index";
import { getInflight } from "@/store/sdkChannelSlice";

const SID_A = "11111111-1111-4000-8000-000000000aaa";
const SID_B = "22222222-2222-4000-8000-000000000bbb";

beforeEach(() => {
  // Reset just the slice surface we touch; leave other slices as
  // their hydrate defaults.
  useStore.setState({ inflightBySession: new Map() }, false);
});

describe("sdkChannelSlice — respawn notice", () => {
  it("setRespawnNotice writes per-session notice; getInflight reads it back", () => {
    useStore
      .getState()
      .setRespawnNotice(SID_A, { startedAt: 1, reason: "per-send" });
    expect(getInflight(useStore.getState(), SID_A).respawnNotice).toEqual({
      startedAt: 1,
      reason: "per-send",
    });
    // Other sessions stay empty.
    expect(getInflight(useStore.getState(), SID_B).respawnNotice).toBeNull();
  });

  it("setRespawnNotice(sid, null) clears", () => {
    useStore.getState().setRespawnNotice(SID_A, {
      startedAt: 1,
      reason: "staleness-detected",
    });
    useStore.getState().setRespawnNotice(SID_A, null);
    expect(getInflight(useStore.getState(), SID_A).respawnNotice).toBeNull();
  });

  it("setRespawnNotice(unknown_sid, null) is a no-op (no map allocation)", () => {
    // Common path: every `sdk-message` SSE arrival fires
    // setRespawnNotice(sid, null) as the early-clear signal. For the
    // 99% of sessions that never had a notice set, we don't want each
    // such call to allocate a per-session SdkInflight entry filled
    // with EMPTY_INFLIGHT defaults. Verify the slice short-circuits.
    const before = useStore.getState().inflightBySession;
    useStore.getState().setRespawnNotice(SID_A, null);
    const after = useStore.getState().inflightBySession;
    // Same Map identity = no `new Map(...)` happened = no allocation.
    expect(after).toBe(before);
    expect(after.has(SID_A)).toBe(false);
  });

  it("preserves other inflight fields when toggling respawn notice", () => {
    useStore.getState().applySdkQueueState(SID_A, {
      state: "running",
      currentRun: { promptItemId: "x", startedAt: 0 },
      pendingPrompts: [],
    });
    useStore.getState().setSdkError(SID_A, "boom");
    useStore.getState().setRespawnNotice(SID_A, {
      startedAt: 100,
      reason: "per-send",
    });

    const inflight = getInflight(useStore.getState(), SID_A);
    expect(inflight.state).toBe("running");
    expect(inflight.lastError).toBe("boom");
    expect(inflight.respawnNotice?.reason).toBe("per-send");

    useStore.getState().setRespawnNotice(SID_A, null);
    const cleared = getInflight(useStore.getState(), SID_A);
    expect(cleared.state).toBe("running");
    expect(cleared.lastError).toBe("boom");
    expect(cleared.respawnNotice).toBeNull();
  });

  it("overwriting an existing notice replaces it (most-recent wins)", () => {
    useStore.getState().setRespawnNotice(SID_A, {
      startedAt: 1,
      reason: "per-send",
    });
    useStore.getState().setRespawnNotice(SID_A, {
      startedAt: 2,
      reason: "staleness-detected",
    });
    expect(getInflight(useStore.getState(), SID_A).respawnNotice).toEqual({
      startedAt: 2,
      reason: "staleness-detected",
    });
  });

  // Respawn-aware close: when the registry closes a Query for the
  // sake of immediately respawning (per-send / staleness-detected),
  // the SSE order is sdk-respawn-notice → sdk-session-closed → new
  // queue-state. The frontend MUST keep the respawnNotice alive
  // through the close so the composer banner doesn't blink off
  // mid-respawn. This test pins that contract.
  it("clearSdkSession preserves respawnNotice + pendingPrompts when set (mid-respawn close)", () => {
    const pending = [
      {
        id: "p-1",
        text: "queued",
        imageCount: 0,
        priority: "next" as const,
        createdAt: 0,
      },
    ];
    useStore.getState().applySdkQueueState(SID_A, {
      state: "running",
      currentRun: { promptItemId: "x", startedAt: 0 },
      pendingPrompts: pending,
    });
    useStore.getState().setSdkError(SID_A, "stale-error");
    useStore.getState().setRespawnNotice(SID_A, {
      startedAt: 1,
      reason: "per-send",
    });

    // session-closed fires from the registry's close() during respawn.
    useStore.getState().clearSdkSession(SID_A);

    const after = getInflight(useStore.getState(), SID_A);
    // Notice survives — composer banner stays visible.
    expect(after.respawnNotice).toEqual({ startedAt: 1, reason: "per-send" });
    // Pendings survive — the user's PendingBubble doesn't flicker off
    // during the close→spawn window. Server-side respawnPreservingQueue
    // keeps the queue intact; frontend mirrors that.
    expect(after.pendingPrompts).toEqual(pending);
    // Queue/error state is reset (the old Query is gone).
    expect(after.state).toBe("idle");
    expect(after.lastError).toBeNull();
    expect(after.currentRun).toBeNull();
  });

  it("clearSdkSession drops the entry entirely when no respawn notice", () => {
    useStore.getState().applySdkQueueState(SID_A, {
      state: "running",
      currentRun: { promptItemId: "x", startedAt: 0 },
      pendingPrompts: [],
    });
    useStore.getState().clearSdkSession(SID_A);
    // Map entry is gone — no stale "idle empty" carcass left behind.
    expect(useStore.getState().inflightBySession.has(SID_A)).toBe(false);
  });
});

describe("sdkChannelSlice — rate-limit events (v2.0.1 PR A)", () => {
  beforeEach(() => {
    useStore.setState({ rateLimitBySession: new Map() }, false);
  });

  it("applyRateLimitEvent writes per-session rate-limit info", () => {
    useStore.getState().applyRateLimitEvent(SID_A, {
      status: "allowed_warning",
      utilization: 0.9,
      resetsAt: 1700000000,
      rateLimitType: "five_hour",
      surpassedThreshold: 0.9,
      receivedAt: 1699000000,
    });
    const info = useStore.getState().rateLimitBySession.get(SID_A);
    expect(info?.status).toBe("allowed_warning");
    expect(info?.utilization).toBe(0.9);
    expect(info?.rateLimitType).toBe("five_hour");
    // Other sessions stay empty.
    // 中: 别的 session 不受影响。
    expect(useStore.getState().rateLimitBySession.get(SID_B)).toBeUndefined();
  });

  it("applyRateLimitEvent overwrites prior info — latest is authoritative", () => {
    useStore.getState().applyRateLimitEvent(SID_A, {
      status: "allowed_warning",
      utilization: 0.9,
      receivedAt: 1,
    });
    useStore.getState().applyRateLimitEvent(SID_A, {
      status: "allowed",
      receivedAt: 2,
    });
    expect(useStore.getState().rateLimitBySession.get(SID_A)?.status).toBe(
      "allowed",
    );
  });

  it("clearSdkSession (no respawn notice) drops both inflight + rate-limit entries", () => {
    useStore.getState().applySdkQueueState(SID_A, {
      state: "running",
      currentRun: { promptItemId: "x", startedAt: 0 },
      pendingPrompts: [],
    });
    useStore.getState().applyRateLimitEvent(SID_A, {
      status: "rejected",
      utilization: 1,
      receivedAt: 1,
    });
    useStore.getState().clearSdkSession(SID_A);
    expect(useStore.getState().inflightBySession.has(SID_A)).toBe(false);
    // Rate-limit snapshot also dropped — fresh spawn re-emits on its own.
    // 中: rate-limit 缓存也清；下次 spawn 自然会再触发。
    expect(useStore.getState().rateLimitBySession.has(SID_A)).toBe(false);
  });
});
