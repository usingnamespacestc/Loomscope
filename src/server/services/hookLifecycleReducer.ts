// EN (PR-2.5 slice 3a, design §9.8): server-side terminal-CC
// hook→lifecycle reducer. The SDK/Loomscope path's "is a turn
// running" is already a server fact (sessionRegistry owns the Query
// state machine — slice 1 reads it). The TERMINAL-CC path has no
// such owner: today the only server memory of a CC turn's lifecycle
// is the fire-and-forget hook broadcast + the file watcher. So a
// terminal-CC turn's running-state was un-versioned, un-replayable,
// and a lost Stop stranded the frontend ephemeral plane forever (the
// P5 three-freeze root, design §9.8 "Why").
//
// This generalises the PROVEN `pendingPermissionTracker` pattern
// (subscribeHooks reducer + per-session map + getter, init-once) from
// the permission sub-case to the turn-running fact:
//   • UserPromptSubmit → running { since }
//   • Stop / SessionEnd → cleared (turn ended / CC died)
//
// SLICE 3a SCOPE: the reducer scaffold only. Lost-Stop ROBUSTNESS
// (transcript-append turn-end cross-check + a tight TTL so a missed
// Stop still converges to idle on the next reconcile — the actual P5
// structural cure and the design's flagged "only genuinely new
// subtlety, needs empirical validation") is the NEXT sub-slice (3b),
// isolated with its own reproduce-first lost-Stop tests. Here we keep
// only a LONG defensive TTL leak-guard (mirrors
// pendingPermissionTracker's 10 min) — NOT the accurate turn-end
// derivation. Still recorded-not-consumed: buildLifecycleSnapshot
// composes this in, but the frontend does not read lifecycleSnapshot
// yet → zero behaviour change (PR-1 discipline maintained).
//
// 中: PR-2.5 slice 3a。终端 CC 路径的"turn 在跑"本无 server owner
// （只有 fire-and-forget hook + 文件监听）→ 丢 Stop 永久卡死前端临时
// 平面 = P5 根因。泛化已验证的 pendingPermissionTracker 范式：
// UserPromptSubmit→running{since}，Stop/SessionEnd→clear。本片只做
// reducer 脚手架 + 长 TTL 防泄漏;丢 Stop 的 transcript 交叉核对/紧
// TTL（真正的 P5 根治、设计点名需实测）留 3b 独立做。仍
// recorded-not-consumed、零行为变化。

import { subscribeHooks } from "@/server/services/hookEventBus";

// Defensive leak-guard ONLY (a stranded `running` from a lost Stop
// shouldn't live forever). This is intentionally LONG — the accurate,
// fast turn-end derivation (transcript cross-check + a tight TTL) is
// slice 3b. Matches pendingPermissionTracker's 10 min.
const TTL_MS = 10 * 60 * 1000;

interface RunningEntry {
  since: number;
}

const running = new Map<string, RunningEntry>();
let unsubscribe: (() => void) | null = null;

function clearTtlExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [sid, entry] of running) {
    if (entry.since < cutoff) running.delete(sid);
  }
}

/** Idempotent — wires the bus listener once at boot. */
export function initHookLifecycleReducer(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeHooks((event, payload) => {
    const sid = payload.session_id;
    if (event === "UserPromptSubmit") {
      // Turn started. Re-stamp `since` only if not already running
      // (a duplicate UserPromptSubmit for the same in-flight turn
      // should not reset the elapsed clock).
      if (!running.has(sid)) running.set(sid, { since: Date.now() });
      clearTtlExpired();
      return;
    }
    if (event === "Stop" || event === "SessionEnd") {
      // Turn ended (Stop) or CC process gone (SessionEnd, defensive).
      running.delete(sid);
      return;
    }
    // All other events: not turn-lifecycle boundaries — ignored.
    // (Tool activity does NOT extend/define the turn here; that, and
    // lost-Stop turn-end inference, is slice 3b.)
  });
}

/**
 * Terminal-CC turn-running fact for `sessionId`, or null when no CC
 * turn is in flight. Consumed by buildLifecycleSnapshot as the
 * fallback when the SDK registry has no running turn (terminal-CC
 * turns have no registry entry). Read-only; sweeps the defensive TTL.
 */
export function getTerminalTurnRunning(
  sessionId: string,
): { since: number } | null {
  clearTtlExpired();
  const e = running.get(sessionId);
  return e ? { since: e.since } : null;
}

/** Test helper — drops the bus listener + clears state. */
export function _resetHookLifecycleReducerForTests(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  running.clear();
}

/** Test helper — peek state for assertions. */
export function _peekHookLifecycleForTests(): Array<{
  sessionId: string;
  since: number;
}> {
  return [...running.entries()].map(([sessionId, e]) => ({
    sessionId,
    since: e.since,
  }));
}
