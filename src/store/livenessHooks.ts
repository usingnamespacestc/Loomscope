// EN: v0.9.1 Task 3 — "running" state derivation for live sessions.
//
// Loomscope is a passive observer of CC's jsonl writes; we have no
// authoritative "RUNNING" status field on any record. "Running" must
// be derived from the only signal we get: SSE `invalidate` events
// flowing in as the file ticks over. The store's
// `SessionState.lastInvalidateAt` is bumped on every invalidate;
// this hook reads it + checks against a decay window.
//
// Decay = orphan handling. If the backend dies / SSE disconnects /
// CC simply stops writing, no more invalidates arrive — the hook's
// active flag flips to false within `decayMs` and all the dashed-
// flowing edges, pulsing borders, etc. settle to static. There's no
// way for a session to look "running forever" — Agentloom-style
// (persistent RUNNING column + sweep on restart) doesn't apply here
// because we don't own the run, but the time-decay achieves the
// same UX guarantee: stale-running indicators self-heal.
//
// 中: Loomscope 是 CC jsonl 写入的被动观察者，记录里没有"RUNNING"
// 状态字段。"running"必须从唯一信号——SSE invalidate 事件——推导。
// store 的 lastInvalidateAt 每次 invalidate 都会更新；本 hook 读它
// 并比对 decay 窗口（默认 5s）。
//
// 衰减 = orphan 处理。后端挂掉 / SSE 断开 / CC 不再写入 → 没有
// invalidate 进来 → active flag 在 decayMs 内自然变 false → 所有
// 流动虚线、跳动边框退回静态。没有"永远 running"卡死状态。Agentloom
// 风格（持久 RUNNING 列 + 启动时 sweep）在这里不适用因为我们不
// 拥有 run，但时间衰减达到同样的 UX 保证：陈旧的 running 自愈。

import { useEffect, useState } from "react";

import { useStore } from "@/store/index";

const DEFAULT_DECAY_MS = 5_000;
// EN: tick interval when checking for decay. 1s is fine — the active
// state only matters at the granularity of "still running or not"
// and 1s of stale animation isn't visually distinguishable from
// fresh.
// 中: decay 检查间隔；1 秒足够（视觉上 1 秒延迟看不出来）。
const TICK_MS = 1_000;

/**
 * EN: True when this session received an SSE invalidate within the
 * decay window. Re-evaluates once per second internally so the
 * boolean flips back to false `decayMs` after the last activity
 * even when no new state changes nudge a re-render.
 *
 * 中: session 在 decay 窗口内收到过 SSE invalidate 时返回 true。
 * 内部每秒 tick，让超时后没有新事件也能自动 false。
 */
export function useSessionLiveness(
  sessionId: string,
  decayMs = DEFAULT_DECAY_MS,
): boolean {
  const lastInvalidateAt = useStore(
    (s) => s.sessions.get(sessionId)?.lastInvalidateAt ?? 0,
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (lastInvalidateAt === 0) return;
    // Set up a recurring tick while the session might still be
    // active. Once we cross the decay threshold, the next render
    // sees `active === false` and we stop scheduling.
    const remaining = decayMs - (Date.now() - lastInvalidateAt);
    if (remaining <= 0) return;
    const id = window.setTimeout(
      () => setTick((t) => t + 1),
      Math.min(TICK_MS, remaining + 50),
    );
    return () => window.clearTimeout(id);
  }, [lastInvalidateAt, decayMs, tick]);
  if (lastInvalidateAt === 0) return false;
  return Date.now() - lastInvalidateAt < decayMs;
}

/**
 * EN: Resolve the "currently running" ChatNode id for a session — by
 * convention the chronologically-last entry in `chatFlow.chatNodes`
 * (parser appends in JSONL order). Returns null when the session
 * isn't loaded or has no nodes. Caller combines with
 * `useSessionLiveness` to decide whether to show the running
 * affordance.
 *
 * 中: 取该 session 当前"运行中"的 ChatNode id —— 约定是
 * `chatFlow.chatNodes` 数组里最后一个（parser 按 jsonl 顺序 append）。
 * Session 未 load 或没节点时返回 null。调用方自己结合
 * useSessionLiveness 决定是否显示动画。
 */
export function useLatestChatNodeId(sessionId: string): string | null {
  return useStore((s) => {
    const cf = s.sessions.get(sessionId)?.chatFlow;
    if (!cf || cf.chatNodes.length === 0) return null;
    return cf.chatNodes[cf.chatNodes.length - 1].id;
  });
}

/**
 * EN: Convenience selector: is `chatNodeId` the currently-running
 * latest one for `sessionId`, AND is the session live? Returns true
 * only when both conditions hold. Used by ChatNodeCard to decide
 * whether to render the pulsing "live" outline.
 *
 * 中: 组合判定：sessionId 上当前是否在跑，且 chatNodeId 是不是最新
 * 那个。两个条件都成立才返回 true。ChatNodeCard 用它决定是否画
 * 跳动边框。
 */
export function useIsChatNodeRunning(
  sessionId: string,
  chatNodeId: string,
): boolean {
  const live = useSessionLiveness(sessionId);
  const latest = useLatestChatNodeId(sessionId);
  return live && latest === chatNodeId;
}
