// EN (PR-2, 2026-05-18): coalesced + quiescence-capable convergent
// reconcile scheduler — the new correctness BACKBONE.
//
// Design: docs/design-live-update-convergence.md §9.1/§9.4/§9.7.
// Today recovery is "5 holey event-driven triggers each independently
// firing a ~5 s full GET" (delta seq-gap, drift-mismatch, hello-
// reconnect, watchdog half-open, no-baseline). That is racey, can
// double-fetch, and CANNOT fire during pure quiescence (a missed
// terminal `chatnode-summary-updated` only surfaces when the stream
// goes quiet — exactly the screenshot summary-divergence bug). This
// replaces the *decision* of when to reconcile with ONE path that is:
//
//   • coalesced  — a burst of triggers ⇒ exactly one reconcile
//     (debounce ≤ debounceMs, bounded by maxWaitMs so a steady drip
//     still converges within ~1 s).
//   • quiescence-capable — `schedule` can be called on turn-end /
//     idle / silence; the tick fires the reconcile even if no further
//     signal ever arrives.
//   • re-entrancy-guarded — at most ONE reconcile in flight; triggers
//     during a run are remembered and re-armed afterwards (so a
//     reason that arrived mid-reconcile is never lost — and never
//     stacks into a storm; the `d50bfe0` lesson: recovery must not be
//     heavier than the disease).
//   • version-short-circuited — if the store's appliedVersion already
//     covers the max observed server version, the due reconcile is a
//     no-op (the parallel old path may have already converged). This
//     is what makes PR-2 SAFE to run ADDITIVELY alongside the still-
//     present band-aids (PR-5 deletes them; not here).
//
// PURE + clock-injectable, exactly like stalenessWatchdog: no DOM
// timers in the logic; `now()` is injected so the whole state machine
// is deterministically unit-testable without fake timers. The actual
// reconcile action (a refreshSession today; an incremental version-
// GET in a later PR) and the version source are injected — the
// scheduler owns only WHEN, never HOW.
//
// ADDITIVE SCOPE: this adds a parallel convergent path. It does NOT
// delete the existing seq-gap/drift/hello/watchdog refreshes (PR-5),
// does NOT touch sessionRegistry (PR-2.5), and contains no retract
// arm (PR-3).
//
// 中: PR-2 收敛 reconcile 调度器——新的正确性主干。把"何时 reconcile"
// 收敛成单一路径：去抖合并 + 静默期可触发 + 不可重入 + 版本短路。
// 纯函数 + 注入时钟（同 stalenessWatchdog），可确定性单测。附加层：
// 不删旧 band-aid（PR-5）、不碰 sessionRegistry（PR-2.5）、无 retract（PR-3）。

import type { ReconcileReason } from "@/sse/signalNormalizer";

export interface ReconcileScheduler {
  /** Request a reconcile. Cheap + idempotent within a window: many
   *  calls coalesce into one due reconcile. Safe to call during an
   *  in-flight reconcile (remembered, re-armed on completion). */
  schedule(reason: ReconcileReason): void;
  /** Periodic poll (drive from a setInterval finer than debounceMs).
   *  Returns the decision; on `"reconcile"` the caller MUST run the
   *  async action and then call `done()` exactly once. */
  tick(): ReconcileTick;
  /** Mark the in-flight reconcile finished (success or failure). Re-
   *  arms if any trigger arrived while it was running. */
  done(): void;
  /** Re-arm/clear on (re)connect — drop pending state for a fresh
   *  socket, keep no stale in-flight flag. */
  reset(): void;
  /** Test/telemetry introspection. */
  pendingReasons(): ReconcileReason[];
  inFlight(): boolean;
}

export type ReconcileTick =
  | { action: "idle" } // nothing armed / not yet due / in flight
  | { action: "short-circuit"; coveredVersion: number } // due but already converged
  | { action: "reconcile"; reasons: ReconcileReason[] };

export function createReconcileScheduler(opts: {
  /** Quiet-for-this-long after the LAST trigger ⇒ fire. */
  debounceMs: number;
  /** Hard cap from the FIRST trigger of a window ⇒ fire even if
   *  triggers keep dripping (so a steady stream still converges). */
  maxWaitMs: number;
  /** Injected clock (defaults Date.now) — tests pass a fake. */
  now?: () => number;
  /** Current watermarks. `applied` = store.appliedVersion (gap
   *  detector's input). `server` = max server version observed across
   *  normalised signals. Short-circuit when `server` is non-null and
   *  `applied != null && applied >= server` (already converged). */
  getVersions: () => { applied: number | null; server: number | null };
  /** Baseline gate. The convergent reconcile converges an EXISTING
   *  baseline to newer ground truth; the INITIAL fetch of a cold/huge
   *  session is loadSession's job. During the cold-load (and every
   *  post-refresh re-baseline) window `applied` is `null`, so the
   *  version short-circuit cannot fire — without this gate the tick
   *  would pile heavy refreshSession full-rebuilds on top of the
   *  already-cold 600-node buildChatFlow: the "recovery heavier than
   *  the disease" storm (d50bfe0 / design §9.7), which regressed the
   *  cold sse_longconv run. Mirrors stalenessWatchdog's
   *  arm-on-first-event rationale. Return false until the session has
   *  a baseline (chatFlow present) and no load/refresh is in flight;
   *  a due reconcile then stays idle (NOT consumed) until it is safe.
   *  Optional (defaults always-true) so the pure unit tests that seed
   *  a baseline are unaffected. */
  canReconcile?: () => boolean;
}): ReconcileScheduler {
  const now = opts.now ?? (() => Date.now());
  const canReconcile = opts.canReconcile ?? (() => true);

  // Armed window state.
  let firstScheduledAt: number | null = null; // max-wait anchor
  let lastScheduledAt = 0; // debounce anchor
  let reasons: ReconcileReason[] = [];

  // Re-entrancy.
  let running = false;
  // Triggers that arrived while a reconcile was in flight — re-armed
  // by done() so a mid-run reason is never dropped.
  let deferred: ReconcileReason[] = [];

  const armed = (): boolean => firstScheduledAt !== null;

  function arm(reason: ReconcileReason): void {
    const t = now();
    if (firstScheduledAt === null) firstScheduledAt = t;
    lastScheduledAt = t;
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  function disarm(): void {
    firstScheduledAt = null;
    lastScheduledAt = 0;
    reasons = [];
  }

  return {
    schedule(reason) {
      if (running) {
        // Remember — do NOT arm a second overlapping window. done()
        // re-arms from these so the mid-run trigger still converges.
        if (!deferred.includes(reason)) deferred.push(reason);
        return;
      }
      arm(reason);
    },

    tick() {
      if (running || !armed()) return { action: "idle" };
      const t = now();
      const dueByDebounce = t - lastScheduledAt >= opts.debounceMs;
      const dueByMaxWait =
        firstScheduledAt !== null && t - firstScheduledAt >= opts.maxWaitMs;
      if (!dueByDebounce && !dueByMaxWait) return { action: "idle" };

      // Baseline gate (cold-storm guard). Due, but no baseline yet /
      // a load is in flight ⇒ stay idle WITHOUT consuming the armed
      // window: the request is preserved and fires the moment it is
      // safe (post-baseline), instead of piling a heavy full-rebuild
      // onto the cold initial load. (Without this the cold 600-node
      // sse_longconv run never rendered — design §9.7 / d50bfe0.)
      if (!canReconcile()) return { action: "idle" };

      // Version-equal short-circuit. If the store already applied a
      // version that covers everything the server has announced, the
      // parallel old path (or earlier deltas) already converged —
      // running another GET would be the "recovery heavier than the
      // disease" storm. Disarm and no-op.
      const { applied, server } = opts.getVersions();
      if (server !== null && applied !== null && applied >= server) {
        disarm();
        return { action: "short-circuit", coveredVersion: server };
      }

      const fired = reasons.slice();
      disarm();
      running = true;
      return { action: "reconcile", reasons: fired };
    },

    done() {
      running = false;
      if (deferred.length > 0) {
        const carry = deferred.slice();
        deferred = [];
        for (const r of carry) arm(r);
      }
    },

    reset() {
      disarm();
      running = false;
      deferred = [];
    },

    pendingReasons() {
      return reasons.slice();
    },
    inFlight() {
      return running;
    },
  };
}

// Tick cadence — must be comfortably finer than RECONCILE_DEBOUNCE_MS
// so debounce/max-wait resolve promptly; cheap (a few comparisons).
export const RECONCILE_TICK_MS = 100;
// Quiet-after-last-trigger before firing. Long enough to coalesce a
// natural delta burst (server emits a cluster within ~tens of ms),
// short enough that turn-end quiescence converges fast.
export const RECONCILE_DEBOUNCE_MS = 250;
// Hard cap from the first trigger so a steady drip of signals can't
// defer convergence indefinitely. ~1 s per design §9.7.
export const RECONCILE_MAX_WAIT_MS = 1_000;
