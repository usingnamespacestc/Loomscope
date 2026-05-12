// EN (v2.1 PR D3): periodic drift-detection broadcaster. Insurance
// policy that catches the class of bugs where the delta seq advances
// correctly but the actual chatflow state silently drifts (reducer
// edge case, race, jsonl rewrite, etc.).
//
// Every `intervalSec` seconds, for each session with an active
// delta-engine snapshot we emit:
//
//   event: drift-ping
//   data: { sessionId, seq, chatNodeCount, hash }
//
// The client compares `hash` to a locally-computed hash of its own
// ChatFlow (using the same `chatFlowHash` algorithm in
// `src/utils/chatFlowSig.ts`). On any mismatch (count, seq, or
// hash), the client falls back to full refresh.
//
// `intervalSec === 0` disables the loop entirely (user opt-out).
//
// 中: 周期性 drift 检测保险丝。每 intervalSec 秒 emit drift-ping，
// 客户端用同一 chatFlowHash 算法对比 hash；不一致就走 refresh 强同步。
// intervalSec=0 完全停掉定时器。

import { broadcast } from "@/server/services/sseHub";
import {
  buildDriftPing,
  listSessionsWithSnapshot,
} from "@/server/services/chatFlowDeltaEngine";

let timer: ReturnType<typeof setInterval> | null = null;
let currentIntervalSec = 0;

function tick(): void {
  for (const sid of listSessionsWithSnapshot()) {
    const ping = buildDriftPing(sid);
    if (!ping) continue;
    broadcast(sid, {
      event: "drift-ping",
      data: { sessionId: sid, ...ping },
    });
  }
}

/**
 * EN: start (or restart) the periodic loop. intervalSec=0 stops the
 * loop; positive value clamps to [1, 600]. Idempotent — calling with
 * the same value is a no-op.
 *
 * 中: 起 / 重启周期循环。0 停掉；正值钳到 [1, 600]。重复调同值无效。
 */
export function setDriftDetectionInterval(intervalSec: number): void {
  const next = intervalSec <= 0 ? 0 : Math.min(600, Math.max(1, intervalSec));
  if (next === currentIntervalSec) return;
  currentIntervalSec = next;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (next > 0) {
    timer = setInterval(tick, next * 1000);
    if (typeof timer.unref === "function") timer.unref();
  }
}

export function getDriftDetectionInterval(): number {
  return currentIntervalSec;
}

/** Test-only: trigger a tick manually without the timer. */
export function _tickForTests(): void {
  tick();
}

/** Test-only: stop + reset state between cases. */
export function _resetForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  currentIntervalSec = 0;
}
