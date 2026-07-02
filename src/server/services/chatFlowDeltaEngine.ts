// EN (v2.1 PR D1): server-side delta emitter for the read pipeline.
//
// Before v2.1 every chokidar fire broadcasted `invalidate` on the SSE
// channel; clients respond by GET /api/sessions/<sid> for the full
// lite ChatFlow. For 120 MB sessions that's a ~16.8 MB / ~4.2 s
// round-trip; under the rc.2 1 Hz invalidate cadence the client is
// always one cycle behind.
//
// This module replaces that with a semantic diff:
//   - Per-session "last pushed snapshot" — a ChatNodeSignature map
//     built from the most recently parsed ChatFlow we sent to clients.
//   - On every fresh parse (caller responsibility — usually triggered
//     from sessionWatcher right after `invalidateSession`), pass the
//     parsed ChatFlow into `processFresh()`. It diffs against the
//     snapshot and emits semantic events:
//       chatnode-added              new ChatNode (full body)
//       chatnode-summary-updated    existing ChatNode whose summary
//                                   changed (streaming token deltas,
//                                   tool_use additions, etc.)
//       chatnode-removed            ChatNode no longer in fresh
//                                   (rare: fork purge, trash)
//       checkpoint                  end-of-batch marker with the
//                                   server's current seq, so clients
//                                   can detect dropped events
//   - Each event carries a monotonic `seq` per session. Clients track
//     `lastSeq`; gaps trigger a fallback full refresh.
//
// Per-session promise chain serialises concurrent fresh parses so
// two near-simultaneous chokidar fires can't race their diffs and
// emit out-of-order events.
//
// Scope (PR D1): build the emitter + broadcast on the existing SSE
// bus alongside `invalidate`. Clients ignore the new event for now;
// PR D2 wires the reducer.
//
// 中: server-side delta 引擎。chokidar 触发后调 processFresh，对比
// 上次 snapshot 算出语义事件（增/改/删/checkpoint），通过 SSE
// `delta` 推给 client。每条事件带递增 seq。per-session promise 链
// 串行化并发的 fresh parse，避免事件乱序。PR D1 只 ship 服务端，
// client 不变；PR D2 才 cutover。

import type { ChatFlow, ChatNode, WorkflowSummary } from "@/data/types";
import { createIdleMap } from "@/server/services/idleMap";
import { broadcast } from "@/server/services/sseHub";
import {
  chatNodeSig,
  hashFromSigs,
} from "@/utils/chatFlowSig";

/**
 * EN: per-ChatNode signature used for diff. We deliberately keep this
 * small — the diff only needs to answer "did this ChatNode's summary
 * change in a way the client should hear about?" Structural identity
 * (id / parentChatNodeId / rootUserUuid) covers added/removed; the
 * `summarySig` hash covers update detection without holding the full
 * payload.
 *
 * 中: 每个 ChatNode 的签名，只够回答"这个 ChatNode 客户端该收到更
 * 新通知吗"。结构字段判增删，summarySig 判更新；不存 full payload。
 */
interface ChatNodeSignature {
  id: string;
  rootUserUuid: string;
  parentChatNodeId: string | null;
  isCompactSummary: boolean;
  summarySig: string;
  /** v2.1 PR D3: full chatNodeSig string (for drift hash). Same
   *  string the client computes locally — matching hashes both
   *  sides means no drift.
   *  中: 完整 chatNodeSig，drift hash 用同一串。 */
  fullSig: string;
}

interface SessionSnapshot {
  byId: Map<string, ChatNodeSignature>;
  /** Last broadcast seq for this session. Resets to 0 on resetSession. */
  seq: number;
}

// v2.6 leak fix: snapshots (one signature-map per session ever
// processed) had no eviction — PR D5 removed the unsubscribe-time
// resetSession call and nothing replaced it. Idle-evicted now. The
// eviction is SAFE because `seq` lives in `seqBySession` below, NOT in
// the evicted value: an evicted session's next computeDeltas sees "no
// snapshot" (cold-start re-emit of every node as chatnode-added, which
// the client's add-or-replace reducer dedups) but the seq keeps
// counting monotonically — if seq were evicted too, it would restart
// at 0 and a still-subscribed client would drop every new delta as a
// replay (`seq ≤ appliedVersion`).
// 中: snapshot 改 idleMap 堵泄漏。seq 拆到 seqBySession(每 session
// 一个数字,不淘汰)——若跟着归零,在订阅的客户端会把新 delta 全当
// 重放丢弃。淘汰后重建 = 冷启动全量 re-emit,客户端去重兜住。
const snapshots = createIdleMap<SessionSnapshot>({
  ttlMs: 30 * 60_000,
  maxEntries: 64,
});
const seqBySession = new Map<string, number>();
/** Per-session promise chain. processFresh's body runs serialised
 *  against the previous call for the same session, so two near-
 *  simultaneous chokidar fires can't race their diffs. */
const chains = new Map<string, Promise<void>>();

/**
 * EN: signature derived from WorkflowSummary's user-visible fields.
 * Concatenated into a `|`-delimited string so equality check is a
 * single ===. Includes everything a canvas card / conversation
 * bubble renders — if any of these changes, clients need to know.
 *
 * Excludes:
 *   - `assistantPreview` content text (variable length, but
 *     `assistantPreview.length` covers most updates)
 *   - per-node thinking / tool body content (changes mid-stream but
 *     not what cards show; lazy-fetched via workflows endpoint)
 *
 * 中: WorkflowSummary 的签名，把 user-visible 字段拼成串。卡片 /
 * 气泡显示的所有信号都覆盖；细到 thinking/tool body 文本变化由
 * 客户端 lazy-fetch workflow 走，不在 delta 信号链上。
 */
function summarySig(cn: ChatNode): string {
  const s = cn.workflow.summary;
  if (!s) return "no-summary";
  return [
    s.llmCount,
    s.assistantText.length,
    s.toolCount,
    s.hasInFlightWork ? "1" : "0",
    s.inputTokens,
    s.outputTokens,
    s.assistantPreview.length,
    s.lastModel ?? "",
    s.durationMs ?? 0,
  ].join("|");
}

function signatureOf(cn: ChatNode): ChatNodeSignature {
  return {
    id: cn.id,
    rootUserUuid: cn.rootUserUuid,
    parentChatNodeId: cn.parentChatNodeId,
    isCompactSummary: cn.isCompactSummary,
    summarySig: summarySig(cn),
    fullSig: chatNodeSig(cn),
  };
}

/**
 * EN: SSE event payloads. Mirrored as `SdkChatFlowDelta*` on client.
 * Keep this discriminated union tight — every new variant must have
 * a corresponding client reducer case.
 *
 * 中: SSE delta 事件载荷。每新增一种变体客户端 reducer 也要加 case。
 */
export type ChatFlowDeltaEvent =
  | {
      type: "chatnode-added";
      seq: number;
      chatNode: ChatNode;
    }
  | {
      type: "chatnode-summary-updated";
      seq: number;
      chatNodeId: string;
      summary: WorkflowSummary;
    }
  | {
      type: "chatnode-removed";
      seq: number;
      chatNodeId: string;
    }
  | {
      type: "checkpoint";
      seq: number;
      /** Total ChatNode count after this checkpoint. Cheap sanity
       *  check: if client's tally differs, it knows it dropped
       *  something. */
      chatNodeCount: number;
    };

/**
 * EN: process a freshly parsed ChatFlow. Diffs against snapshot,
 * emits deltas, broadcasts via SSE, updates snapshot. Per-session
 * serialised — callers can fire multiple processFresh calls without
 * worrying about race. Returns the deltas emitted (for tests).
 *
 * 中: 处理一次新解析的 ChatFlow。diff + emit + broadcast + 更新
 * snapshot，per-session 串行。
 */
export async function processFresh(
  sessionId: string,
  fresh: ChatFlow,
): Promise<ChatFlowDeltaEvent[]> {
  const prev = chains.get(sessionId) ?? Promise.resolve();
  let resolve!: () => void;
  const pending = new Promise<void>((r) => {
    resolve = r;
  });
  // Chain ourselves AFTER any in-flight processFresh for this session
  // returns. The chain "tail" is always the most-recent pending.
  // 中: 把自己挂到当前 session 的链尾，串行执行。
  chains.set(sessionId, pending);
  await prev;
  try {
    const deltas = computeDeltas(sessionId, fresh);
    for (const d of deltas) {
      broadcast(sessionId, { event: "delta", data: d });
    }
    return deltas;
  } finally {
    resolve();
    if (chains.get(sessionId) === pending) {
      chains.delete(sessionId);
    }
  }
}

function computeDeltas(
  sessionId: string,
  fresh: ChatFlow,
): ChatFlowDeltaEvent[] {
  const old = snapshots.get(sessionId);
  const deltas: ChatFlowDeltaEvent[] = [];
  // v2.6: seq is sourced from the non-evicted side table so it stays
  // monotonic across snapshot eviction (see the snapshots docblock).
  let seq = seqBySession.get(sessionId) ?? old?.seq ?? 0;
  const nextById = new Map<string, ChatNodeSignature>();
  for (const cn of fresh.chatNodes) {
    const sig = signatureOf(cn);
    nextById.set(cn.id, sig);
    const prevSig = old?.byId.get(cn.id);
    if (!prevSig) {
      seq += 1;
      deltas.push({ type: "chatnode-added", seq, chatNode: cn });
      continue;
    }
    if (prevSig.summarySig !== sig.summarySig) {
      // EN: existing ChatNode whose user-visible state moved. Only
      // emit if summary is present — `summary` is technically
      // optional on the type but in practice always populated for
      // parsed ChatNodes.
      const summary = cn.workflow.summary;
      if (summary) {
        seq += 1;
        deltas.push({
          type: "chatnode-summary-updated",
          seq,
          chatNodeId: cn.id,
          summary,
        });
      }
    }
  }
  // Detect removals: ids present in `old.byId` but absent in `nextById`.
  // Rare path — happens on fork-merge purge or trash, NOT during
  // normal streaming.
  // 中: 检测删除。streaming 几乎不会触发，fork purge / trash 才发生。
  if (old) {
    for (const id of old.byId.keys()) {
      if (!nextById.has(id)) {
        seq += 1;
        deltas.push({ type: "chatnode-removed", seq, chatNodeId: id });
      }
    }
  }
  // Always emit a checkpoint at end-of-batch so the client can verify
  // it received the expected number of events. If `chatNodeCount`
  // doesn't match the client's tally, it knows it missed some.
  // 中: batch 末尾一律 emit checkpoint，client 用 chatNodeCount 做
  // 一致性自检。
  seq += 1;
  deltas.push({
    type: "checkpoint",
    seq,
    chatNodeCount: fresh.chatNodes.length,
  });
  snapshots.set(sessionId, { byId: nextById, seq });
  seqBySession.set(sessionId, seq);
  return deltas;
}

/**
 * EN: reset all state for this session. Call when the session closes
 * (browser unsubscribes + last subscriber gone) so a fresh re-open
 * goes through full refresh + builds a new snapshot. Prevents
 * resurrecting a stale snapshot when a new connection arrives.
 *
 * 中: session 关闭时调，清掉 snapshot 让下次重连走 full refresh。
 */
export function resetSession(sessionId: string): void {
  snapshots.delete(sessionId);
  seqBySession.delete(sessionId);
  chains.delete(sessionId);
}

/** Server-side accessor — current seq for a session. Used by drift
 *  detection (PR D3) to broadcast periodic hashes. */
export function getCurrentSeq(sessionId: string): number {
  return seqBySession.get(sessionId) ?? 0;
}

/**
 * EN (v2.1 PR D3): build a drift-ping payload from the current
 * snapshot. Returns null when no snapshot exists (no chatflow has
 * been processed for this session yet — drift loop should skip it).
 *
 * 中: 用当前 snapshot 算 drift ping 内容，没 snapshot 返回 null。
 */
export function buildDriftPing(sessionId: string): {
  seq: number;
  chatNodeCount: number;
  hash: string;
} | null {
  const snap = snapshots.get(sessionId);
  if (!snap) return null;
  const sigs = Array.from(snap.byId.values(), (s) => s.fullSig);
  return {
    seq: snap.seq,
    chatNodeCount: snap.byId.size,
    hash: hashFromSigs(sigs),
  };
}

/** Test-only — list active session ids. Used by drift broadcaster
 *  tests + the periodic loop iteration helper. */
export function _listActiveSessionsForTests(): string[] {
  return Array.from(snapshots.keys());
}

/** v2.1 PR D3: enumerate sessions that have a snapshot (= eligible
 *  for drift ping). Public for the drift-broadcaster timer. */
export function listSessionsWithSnapshot(): string[] {
  return Array.from(snapshots.keys());
}

/** Test-only — inspect snapshot directly. */
export function _getSnapshotForTests(
  sessionId: string,
): SessionSnapshot | null {
  return snapshots.get(sessionId) ?? null;
}

/** Test-only — clear all module state between cases. */
export function _resetAllForTests(): void {
  snapshots.clear();
  seqBySession.clear();
  chains.clear();
}
