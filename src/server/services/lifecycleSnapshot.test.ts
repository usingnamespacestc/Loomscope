// EN (PR-2.5 slice 1) — reproduce/zero-behaviour unit tests for the
// pure lifecycle-snapshot aggregator. Proves it faithfully maps the
// facts the server already owns (sessionRegistry.snapshot +
// pendingPermissionTracker) into the §9.8 shape, stamped with the
// content watermark — and that it is PURE (no registry mutation, no
// broadcast: it only ever calls the injected `snapshot` reader).
//
// 中: PR-2.5 slice 1 纯聚合器单测。证明忠实映射 + 同版本号 + 纯读。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/services/chatFlowDeltaEngine", () => ({
  getCurrentSeq: vi.fn(),
}));
vi.mock("@/server/services/pendingPermissionTracker", () => ({
  getPendingPermission: vi.fn(),
}));

import { getCurrentSeq } from "@/server/services/chatFlowDeltaEngine";
import { getPendingPermission } from "@/server/services/pendingPermissionTracker";
import { buildLifecycleSnapshot } from "@/server/services/lifecycleSnapshot";
import type { SessionRegistry } from "@/server/services/sessionRegistry";
import type { HookEnvelope } from "@/server/services/hookEventBus";

type RegSnap = ReturnType<SessionRegistry["snapshot"]>;
function fakeRegistry(
  snap: RegSnap,
): { snapshot: (id: string) => RegSnap; calls: number } {
  const f = {
    calls: 0,
    snapshot(_id: string): RegSnap {
      f.calls += 1;
      return snap;
    },
  };
  return f;
}

const seq = vi.mocked(getCurrentSeq);
const perm = vi.mocked(getPendingPermission);

beforeEach(() => {
  seq.mockReset().mockReturnValue(0);
  perm.mockReset().mockReturnValue(null);
});

describe("buildLifecycleSnapshot — faithful mapping", () => {
  it("running + currentRun → turnRunning {since}, queueDepth from pendingCount", () => {
    seq.mockReturnValue(42);
    const reg = fakeRegistry({
      state: "running",
      pendingCount: 3,
      currentRun: { promptItemId: "i1", startedAt: 1717171717 },
    });
    expect(buildLifecycleSnapshot(reg, "s1")).toEqual({
      version: 42,
      turnRunning: { since: 1717171717 },
      pendingPermission: null,
      queueDepth: 3,
    });
  });

  it("idle → turnRunning null", () => {
    const reg = fakeRegistry({
      state: "idle",
      pendingCount: 0,
      currentRun: null,
    });
    expect(buildLifecycleSnapshot(reg, "s1").turnRunning).toBeNull();
  });

  it("registry has no entry (snapshot null) → idle/empty defaults", () => {
    const reg = fakeRegistry(null);
    expect(buildLifecycleSnapshot(reg, "s1")).toEqual({
      version: 0,
      turnRunning: null,
      pendingPermission: null,
      queueDepth: 0,
    });
  });

  it("defensive: state running but currentRun null → turnRunning null (no crash)", () => {
    const reg = fakeRegistry({
      state: "running",
      pendingCount: 1,
      currentRun: null,
    });
    expect(buildLifecycleSnapshot(reg, "s1").turnRunning).toBeNull();
    expect(buildLifecycleSnapshot(reg, "s1").queueDepth).toBe(1);
  });

  it("pending permission passes through verbatim; version = getCurrentSeq", () => {
    seq.mockReturnValue(7);
    const env: HookEnvelope = { session_id: "s1", extras: { tool_name: "Bash" } };
    perm.mockReturnValue(env);
    const reg = fakeRegistry({
      state: "idle",
      pendingCount: 0,
      currentRun: null,
    });
    const snap = buildLifecycleSnapshot(reg, "s1");
    expect(snap.version).toBe(7);
    expect(snap.pendingPermission).toEqual({ payload: env });
  });
});

describe("buildLifecycleSnapshot — purity (zero behaviour change)", () => {
  it("only ever READS via registry.snapshot — never mutates/broadcasts", () => {
    const reg = fakeRegistry({
      state: "running",
      pendingCount: 0,
      currentRun: { promptItemId: "i", startedAt: 1 },
    });
    buildLifecycleSnapshot(reg, "s1");
    buildLifecycleSnapshot(reg, "s1");
    // The only registry interaction is the read; no other surface
    // (the fake exposes no mutators, so a write would throw).
    expect(reg.calls).toBe(2);
    // getCurrentSeq / getPendingPermission are reads (mocked); the
    // aggregator added no side-effecting call.
    expect(seq).toHaveBeenCalledWith("s1");
    expect(perm).toHaveBeenCalledWith("s1");
  });
});
