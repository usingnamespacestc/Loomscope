// EN (PR-2.5, design §9.7 item 3 + §9.8): server-held, version-
// stamped per-session LIFECYCLE snapshot — the dual of the content
// watermark. §9.8 (user chose option A) folds the three
// unsynchronised frontend planes (content / hook-ephemeral /
// SDK-channel) into ONE reconcilable, server-held, versioned fact so
// "is a turn running / pending permission / queue depth" stops being
// a best-effort cross-plane OR whose any-source clear-event loss
// sticks (the P5 three-freeze root).
//
// SLICE 1 (this file): the SHAPE + a PURE read builder sourced from
// facts the server ALREADY owns — `sessionRegistry` (SDK/Loomscope
// path: state / currentRun / queue) + `pendingPermissionTracker`
// (terminal-CC permission) — stamped with the SAME monotonic content
// version (`getCurrentSeq`). Exposed read-only on an additive
// endpoint; the frontend does NOT consume it yet. This is the PR-1
// discipline applied to the high-risk server surface: additive,
// recorded-not-consumed, ZERO writes, ZERO behaviour change. No new
// state machine — sessionRegistry already owns these facts and
// broadcasts them fire-and-forget; this only READS + versions them.
//
// DEFERRED to later slices (NOT here): subscribe-time replay +
// reconcile-GET inclusion; the terminal-CC hook→lifecycle reducer
// (generalising pendingPermissionTracker, incl. lost-Stop transcript
// cross-check + TTL); respawn/deferral/rate-limit fields; and the
// frontend collapse of the cross-plane "is running" OR.
//
// 中: PR-2.5 slice 1。server 持、与内容同版本的 lifecycle 快照之
// 形状 + 纯读 builder（源自 sessionRegistry + pendingPermissionTracker
// 已拥有的事实，用 getCurrentSeq 盖同一版本号）。附加只读端点暴露，
// 前端先不消费——PR-1 纪律：附加、记录不消费、零写入、零行为变化。
// 不新建状态机。subscribe 补发 / 终端 hook reducer / respawn 等字段
// / 前端 OR 收敛 留后续片。

import { getCurrentSeq } from "@/server/services/chatFlowDeltaEngine";
import type { HookEnvelope } from "@/server/services/hookEventBus";
import { getTerminalTurnRunning } from "@/server/services/hookLifecycleReducer";
import { getPendingPermission } from "@/server/services/pendingPermissionTracker";
import type { SessionRegistry } from "@/server/services/sessionRegistry";

export interface LifecycleSnapshot {
  /** Same monotonic watermark as content (chatFlowDeltaEngine seq;
   *  0 when no snapshot yet). One watermark for content + lifecycle
   *  (§9.8). RECORDED-NOT-CONSUMED in this slice. */
  version: number;
  /** SDK/Loomscope-path fact owned by sessionRegistry. `null` = the
   *  registry has no running turn (idle / no entry). `since` is the
   *  in-flight turn's wall-clock start. */
  turnRunning: { since: number } | null;
  /** Terminal-CC-path fact owned by pendingPermissionTracker. The
   *  raw hook payload (same shape `applyCcHookEvent` consumes), or
   *  `null` when nothing is pending. */
  pendingPermission: { payload: HookEnvelope } | null;
  /** Backlog depth — does NOT include the in-flight turn (mirrors
   *  sessionRegistry.snapshot().pendingCount). */
  queueDepth: number;
}

/**
 * Pure aggregator. Reads only — never mutates registry/tracker state,
 * never broadcasts. `registry` is passed in (it is DI'd per app, not
 * a module singleton) and narrowed to just the `snapshot` reader so
 * tests can supply a tiny fake.
 */
export function buildLifecycleSnapshot(
  registry: Pick<SessionRegistry, "snapshot">,
  sessionId: string,
): LifecycleSnapshot {
  const reg = registry.snapshot(sessionId);
  const perm = getPendingPermission(sessionId);
  // turnRunning composition (design §9.8: ONE fact from whichever
  // path owns the turn). SDK/Loomscope path: sessionRegistry owns
  // the Query state machine. Terminal-CC path: no registry entry —
  // fall back to the hook→lifecycle reducer (slice 3a). They are
  // mutually exclusive in practice (a session is driven by one path
  // at a time); registry-running takes precedence when both somehow
  // report.
  const sdkRunning =
    reg && reg.state === "running" && reg.currentRun
      ? { since: reg.currentRun.startedAt }
      : null;
  return {
    version: getCurrentSeq(sessionId),
    turnRunning: sdkRunning ?? getTerminalTurnRunning(sessionId),
    pendingPermission: perm ? { payload: perm } : null,
    queueDepth: reg?.pendingCount ?? 0,
  };
}
