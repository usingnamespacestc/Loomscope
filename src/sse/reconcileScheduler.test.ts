// EN (PR-2, 2026-05-18): reproduce-first deterministic tests for the
// convergent reconcile scheduler. Pure clock injection (no fake DOM
// timers), exactly the stalenessWatchdog.test.ts house style: a
// mutable `t`, `now: () => t`, advance `t`, call `tick()`.
//
// Covers the handoff §2 reproduce-first matrix items:
//   • debounce/max-wait coalescing: a burst → exactly ONE reconcile.
//   • re-entrancy: overlapping triggers → no storm; mid-run trigger
//     not lost.
//   • version-equal short-circuit: due reconcile no-ops when the
//     store already covers the max observed server version.
//   • quiescence: schedule on idle/turn-end fires with NO further
//     signal.
//
// 中: PR-2 reconcile 调度器复现优先单测。纯注入时钟，复刻 watchdog
// 测试风格。覆盖去抖合并 / 不可重入不风暴 / 版本短路 / 静默触发。

import { describe, expect, it } from "vitest";

import {
  RECONCILE_DEBOUNCE_MS,
  RECONCILE_MAX_WAIT_MS,
  RECONCILE_TICK_MS,
  createReconcileScheduler,
} from "@/sse/reconcileScheduler";

function mk(versions: { applied: number | null; server: number | null }) {
  let t = 0;
  const v = { ...versions };
  const s = createReconcileScheduler({
    debounceMs: RECONCILE_DEBOUNCE_MS,
    maxWaitMs: RECONCILE_MAX_WAIT_MS,
    now: () => t,
    getVersions: () => v,
  });
  return {
    s,
    adv: (ms: number) => {
      t += ms;
    },
    at: (ms: number) => {
      t = ms;
    },
    setVersions: (nv: { applied: number | null; server: number | null }) => {
      v.applied = nv.applied;
      v.server = nv.server;
    },
  };
}

describe("reconcileScheduler — coalescing", () => {
  it("a burst of triggers within the debounce window → exactly ONE reconcile", () => {
    const { s, adv } = mk({ applied: 5, server: 9 });
    // 4 triggers, each well within debounce of the previous.
    s.schedule("invalidate");
    adv(50);
    s.schedule("sdk-message");
    adv(50);
    s.schedule("seq-gap");
    adv(50);
    s.schedule("invalidate"); // dup reason — must not double
    // Not yet quiet long enough → idle.
    adv(RECONCILE_DEBOUNCE_MS - 1);
    expect(s.tick().action).toBe("idle");
    // Now quiet past debounce → exactly one reconcile carrying the
    // de-duplicated reason set.
    adv(2);
    const d = s.tick();
    expect(d.action).toBe("reconcile");
    if (d.action === "reconcile") {
      expect([...d.reasons].sort()).toEqual(
        ["invalidate", "sdk-message", "seq-gap"].sort(),
      );
    }
    // Disarmed after firing: a second tick (still in flight) is idle.
    expect(s.tick().action).toBe("idle");
    s.done();
    // Fully quiet, nothing pending → still idle (no phantom re-fire).
    adv(RECONCILE_MAX_WAIT_MS * 2);
    expect(s.tick().action).toBe("idle");
  });

  it("a steady drip never starves: max-wait forces a fire even if debounce keeps resetting", () => {
    const { s, adv } = mk({ applied: 1, server: 7 });
    s.schedule("sdk-message");
    // Drip a trigger every (debounce-10)ms so debounce never elapses.
    let elapsed = 0;
    const step = RECONCILE_DEBOUNCE_MS - 10;
    while (elapsed < RECONCILE_MAX_WAIT_MS) {
      adv(step);
      elapsed += step;
      s.schedule("sdk-message");
      if (elapsed < RECONCILE_MAX_WAIT_MS) {
        // Before max-wait the debounce-reset keeps it idle.
        expect(s.tick().action).toBe("idle");
      }
    }
    // Past max-wait from the first trigger → fires despite the drip.
    adv(1);
    expect(s.tick().action).toBe("reconcile");
  });
});

describe("reconcileScheduler — version-equal short-circuit", () => {
  it("due reconcile no-ops when appliedVersion already covers the server version", () => {
    const { s, adv } = mk({ applied: 9, server: 9 });
    s.schedule("invalidate");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    const d = s.tick();
    expect(d.action).toBe("short-circuit");
    if (d.action === "short-circuit") expect(d.coveredVersion).toBe(9);
    // Short-circuit disarms WITHOUT entering in-flight (no done()
    // needed) and does not re-fire.
    expect(s.inFlight()).toBe(false);
    adv(RECONCILE_MAX_WAIT_MS);
    expect(s.tick().action).toBe("idle");
  });

  it("still reconciles when the server is ahead (real gap)", () => {
    const { s, adv } = mk({ applied: 4, server: 12 });
    s.schedule("seq-gap");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    expect(s.tick().action).toBe("reconcile");
  });

  it("reconciles when appliedVersion is null (post-refresh re-baseline window)", () => {
    const { s, adv } = mk({ applied: null, server: 12 });
    s.schedule("hello-reconnect");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    // applied==null ⇒ cannot prove convergence ⇒ must reconcile.
    expect(s.tick().action).toBe("reconcile");
  });

  it("no server version observed ⇒ never short-circuits (quiescence convergence still runs)", () => {
    const { s, adv } = mk({ applied: 3, server: null });
    s.schedule("sdk-idle");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    // server==null (e.g. only sdk-idle/invalidate seen, no versioned
    // signal) ⇒ must NOT short-circuit; the missed-terminal-delta /
    // turn-end case depends on this path firing.
    expect(s.tick().action).toBe("reconcile");
  });
});

describe("reconcileScheduler — re-entrancy (no storm; no lost trigger)", () => {
  it("at most one reconcile in flight; triggers during a run are remembered and re-armed", () => {
    const { s, adv } = mk({ applied: 2, server: 8 });
    s.schedule("seq-gap");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    const d1 = s.tick();
    expect(d1.action).toBe("reconcile");
    expect(s.inFlight()).toBe(true);

    // Storm pressure while the (slow) reconcile runs: many triggers.
    s.schedule("invalidate");
    s.schedule("drift-mismatch");
    s.schedule("invalidate");
    // tick() during in-flight is ALWAYS idle (no second concurrent
    // reconcile — the d50bfe0 "recovery heavier than disease" guard).
    adv(RECONCILE_MAX_WAIT_MS * 3);
    expect(s.tick().action).toBe("idle");
    expect(s.inFlight()).toBe(true);

    // Reconcile finishes. The mid-run triggers must NOT be lost —
    // they re-arm a fresh window.
    s.done();
    expect(s.inFlight()).toBe(false);
    expect([...s.pendingReasons()].sort()).toEqual(
      ["drift-mismatch", "invalidate"].sort(),
    );
    // After the re-armed debounce they converge once more.
    adv(RECONCILE_DEBOUNCE_MS + 1);
    expect(s.tick().action).toBe("reconcile");
  });

  it("done() with no mid-run triggers leaves the scheduler quiescent", () => {
    const { s, adv } = mk({ applied: 0, server: 5 });
    s.schedule("invalidate");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    expect(s.tick().action).toBe("reconcile");
    s.done();
    adv(RECONCILE_MAX_WAIT_MS * 2);
    expect(s.tick().action).toBe("idle");
    expect(s.pendingReasons()).toEqual([]);
  });
});

describe("reconcileScheduler — quiescence", () => {
  it("schedule on turn-end idle fires with NO further signal arriving", () => {
    const { s, adv } = mk({ applied: 6, server: 7 }); // server ahead by a missed terminal delta
    // Turn ends; sdk-queue-state→idle is the ONLY thing that arrives.
    s.schedule("sdk-idle");
    // No other signal ever comes. The old per-event recovery could
    // not fire here (nothing to hook). The scheduler must.
    adv(RECONCILE_DEBOUNCE_MS + 1);
    expect(s.tick().action).toBe("reconcile");
  });
});

describe("reconcileScheduler — baseline gate (cold-storm guard)", () => {
  it("a due reconcile stays idle WITHOUT consuming the window while canReconcile() is false, then fires once it flips true", () => {
    let t = 0;
    let baselineReady = false;
    let runs = 0;
    const s = createReconcileScheduler({
      debounceMs: RECONCILE_DEBOUNCE_MS,
      maxWaitMs: RECONCILE_MAX_WAIT_MS,
      now: () => t,
      // server ahead of applied ⇒ would reconcile if not gated; this
      // is exactly the cold-load window (applied null/behind, heavy
      // signals arriving) the gate must not storm.
      getVersions: () => ({ applied: null, server: 9 }),
      canReconcile: () => baselineReady,
    });
    s.schedule("seq-gap");
    s.schedule("hello-reconnect");

    // Cold window: many ticks across a long span — NONE may fire a
    // reconcile (the storm that never let the cold 600-node run
    // render). The armed window must be PRESERVED, not consumed.
    for (let i = 0; i < 50; i++) {
      t += RECONCILE_TICK_MS;
      expect(s.tick().action).toBe("idle");
      runs += s.inFlight() ? 1 : 0;
    }
    expect(runs).toBe(0);
    expect(s.inFlight()).toBe(false);

    // Baseline arrives (loadSession resolved, chatFlow present).
    baselineReady = true;
    t += RECONCILE_TICK_MS;
    const d = s.tick();
    expect(d.action).toBe("reconcile");
    if (d.action === "reconcile") {
      // The reasons scheduled during the cold window were NOT lost.
      expect([...d.reasons].sort()).toEqual(
        ["hello-reconnect", "seq-gap"].sort(),
      );
    }
  });

  it("absent canReconcile → always allowed (pure tests unaffected)", () => {
    const { s, adv } = mk({ applied: 2, server: 9 });
    s.schedule("invalidate");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    expect(s.tick().action).toBe("reconcile");
  });
});

describe("reconcileScheduler — reset", () => {
  it("reset() drops pending + in-flight for a fresh socket", () => {
    const { s, adv } = mk({ applied: 1, server: 9 });
    s.schedule("seq-gap");
    adv(RECONCILE_DEBOUNCE_MS + 1);
    expect(s.tick().action).toBe("reconcile");
    expect(s.inFlight()).toBe(true);
    s.reset();
    expect(s.inFlight()).toBe(false);
    expect(s.pendingReasons()).toEqual([]);
    expect(s.tick().action).toBe("idle");
  });
});
