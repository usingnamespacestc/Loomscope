// EN: extracted from sessions.ts route in v2.1 PR D1 so the delta
// engine (app.ts mainJsonlChangeHandler) can call the same loader
// the GET /:id route uses. Before this commit the function was a
// private helper inside the route file; now both call-sites pull
// from this module.
//
// Behavior is unchanged from the prior in-route implementation —
// closure ≤ 1 uses the incremental parser + state stash; otherwise
// it reads each closure jsonl, dedups by uuid in BFS order, and
// runs buildChatFlow on the merged record stream.
//
// 中: v2.1 PR D1 把 sessions.ts 路由里的私有 helper 提到独立模块。
// 行为不动；只是让 delta engine 也能用同一份 loader。

import {
  buildChatFlow,
  parseJsonlFileIncremental,
  readRecordsIncremental,
  type RecordsOnlyIncrementalState,
} from "@/parse/jsonl";
import type { RawRecord } from "@/parse/raw-record";
import {
  clearStashedState,
  getStashedState,
  setStashedState,
} from "@/server/services/chatFlowCache";
import type { ClosureMember } from "@/server/services/forkTree";
import type { ChatFlow } from "@/data/types";

/**
 * EN (v2.1 PR D4 stretch): per-member incremental read state for
 * multi-jsonl fork closure loaders. Keyed by `${entrySessionId}:${memberSessionId}`
 * because the same memberSessionId may appear under different entry
 * sessions (sibling forks with overlapping ancestor chains); we don't
 * want one entry's stash to clobber another's stash for the same
 * member jsonl.
 *
 * Lifetime: cleared on closure shape change (member added / removed)
 * and at session unsubscribe (via clearClosureMemberStash + resetSession
 * in the delta engine hooks).
 *
 * 中: closure 多成员的 per-member 增量读 state。key 用
 * `entry:member` 复合避免同 member 在不同 entry 下相互污染。closure
 * 形状变 → 清掉这条 stash 让 fallback 走全量。
 */
const closureMemberStash = new Map<string, RecordsOnlyIncrementalState>();

function memberStashKey(entrySid: string, memberSid: string): string {
  return `${entrySid}::${memberSid}`;
}

/** v2.1 PR D4: clear per-member stash for a given entry session.
 *  Called by sessions.ts route's SSE unsubscribe handler (alongside
 *  resetDeltaSession) so the next session reconnection starts fresh.
 *  中: SSE 最后一个订阅者断开时清掉 closure member stash。 */
export function clearClosureMemberStash(entrySid: string): void {
  const prefix = `${entrySid}::`;
  for (const k of Array.from(closureMemberStash.keys())) {
    if (k.startsWith(prefix)) closureMemberStash.delete(k);
  }
}

/**
 * EN (v2.2 PR E1): return shape extended to include `newRecords` —
 * the records appended since the previous incremental call, in the
 * same parser order. The mainJsonlChangeHandler broadcasts these as
 * raw-record SSE events for the client's optimistic-render fast path
 * (instant UI without waiting for buildChatFlow). When no prior state
 * exists (first call / state reset), newRecords is empty (= "we don't
 * know what's new; just trust the full chatFlow"). When the read
 * fell back to full (file shrunk etc.), also empty.
 *
 * 中: 返回值加 newRecords —— 跟上次相比新追加的 record 列表。
 * 主 jsonl 变更处理器拿这个广播 raw-record SSE 给客户端做即时
 * 渲染。没有 prev state 或 fallback 全量时 newRecords 为空（客户端
 * 等 ground-truth delta）。
 */
export interface LoadMergedResult {
  chatFlow: ChatFlow;
  newRecords: RawRecord[];
}

/** Load + merge a ChatFlow from a fork closure. Identical to the
 *  former sessions.ts internal helper — extracted so delta engine
 *  shares the same loader. */
export async function loadMergedChatFlowForDelta(args: {
  entryJsonlPath: string;
  entrySessionId: string;
  closure: ClosureMember[];
}): Promise<LoadMergedResult> {
  const { entryJsonlPath, entrySessionId, closure } = args;
  if (closure.length <= 1) {
    const prevState = getStashedState(entrySessionId);
    const prevCount = prevState?.records.length ?? 0;
    const r = await parseJsonlFileIncremental(entryJsonlPath, prevState);
    setStashedState(entrySessionId, r.state);
    // EN (PR E1): newRecords = records appended since prev call.
    // When usedIncremental is false (first call / file shrunk),
    // there's no "delta" to speak of — leave newRecords empty.
    // 中: 增量路径下 newRecords = records 尾部新增段；fallback 全量
    // 时不算 delta（客户端走 ground-truth）。
    const newRecords = r.usedIncremental
      ? r.state.records.slice(prevCount)
      : [];
    return { chatFlow: r.chatFlow, newRecords };
  }
  clearStashedState(entrySessionId);
  // v2.1 PR D4 stretch: per-member incremental read. Each closure
  // member maintains its own RecordsOnlyIncrementalState in
  // `closureMemberStash`. On fs.change we only read [byteSize, EOF)
  // for each member that grew, append to its cached records list,
  // then merge + dedup + buildChatFlow on the combined stream.
  //
  // Closure shape change handling: the stash is keyed by
  // `${entrySid}::${memberSid}`; if a new member appears, its stash
  // is missing and `readRecordsIncremental` falls back to full read
  // for that one member (others still incremental). If a member is
  // removed, its stash entry leaks until the next sessions.ts SSE
  // unsubscribe runs `clearClosureMemberStash` — bounded by user
  // tab lifecycle, not catastrophic.
  //
  // 中: 每个 closure member 自己存一份 records 增量 state；fs.change
  // 时只读 tail，合并后整体 dedup + buildChatFlow。member 列表变化
  // 时新成员走 full fallback；删除的 member stash 在 SSE 退订时清。
  const recordsByMember: Array<{
    sessionId: string;
    records: RawRecord[];
    newRecords: RawRecord[];
  }> = [];
  for (const m of closure) {
    const key = memberStashKey(entrySessionId, m.sessionId);
    const prevState = closureMemberStash.get(key);
    const prevCount = prevState?.records.length ?? 0;
    const r = await readRecordsIncremental(m.jsonlPath, prevState);
    closureMemberStash.set(key, r.state);
    // EN (PR E1): per-member newRecords. Aggregated across members
    // for the broadcast. Order across members isn't strictly
    // chronological (different files), but each record has uuid +
    // parentUuid so the client builder can stitch correctly.
    // 中: 每个 member 的 newRecords 累加广播。跨 member 不严格按时
    // 序但每条 record 自带 uuid + parentUuid 客户端能拼。
    const newRecords = r.usedIncremental
      ? r.records.slice(prevCount)
      : [];
    recordsByMember.push({
      sessionId: m.sessionId,
      records: r.records,
      newRecords,
    });
  }
  const seenUuids = new Set<string>();
  const merged: RawRecord[] = [];
  for (const { records } of recordsByMember) {
    for (const r of records) {
      if (r.uuid && seenUuids.has(r.uuid)) continue;
      if (r.uuid) seenUuids.add(r.uuid);
      merged.push(r);
    }
  }
  const chatFlow = buildChatFlow(merged, entryJsonlPath);
  chatFlow.id = entrySessionId;
  chatFlow.linkedSessions = closure.map((m) => m.sessionId);
  // Aggregate newRecords with uuid-dedup (same logic as merged).
  // 中: newRecords 跨 member 用 uuid 去重，避免 fork closure 重复广播。
  const newSeen = new Set<string>();
  const aggregatedNew: RawRecord[] = [];
  for (const { newRecords } of recordsByMember) {
    for (const r of newRecords) {
      if (r.uuid && newSeen.has(r.uuid)) continue;
      if (r.uuid) newSeen.add(r.uuid);
      aggregatedNew.push(r);
    }
  }
  return { chatFlow, newRecords: aggregatedNew };
}

/**
 * EN (v2.2 PR E1 fix): pure tail-read fast path. Returns only the
 * newly-appended records — does NOT run buildChatFlow (which is the
 * 1.5-2s bottleneck). Designed to be called BEFORE
 * loadMergedChatFlowForDelta so the mainJsonlChangeHandler can
 * broadcast a `raw-records` SSE event immediately, then continue
 * with the slow ground-truth build.
 *
 * Stash mutation: deliberately does NOT update the per-session
 * IncrementalParseState stash (which carries the cached ChatFlow).
 * The subsequent loadMergedChatFlowForDelta call will see the same
 * stash, do its own (now-redundant ~3-5ms) tail-read, and produce
 * the fresh ChatFlow. The duplicate IO is negligible vs. the
 * buildChatFlow cost it gates.
 *
 * For closure>1, we DO update the per-member records stash because
 * that one's stash-only (no chatFlow) and we want the slow path's
 * re-read to fast-path on `byteSize == prevState.byteSize`. (The
 * closure>1 path re-tail-reads either way; updating the stash saves
 * the second pass.)
 *
 * 中: 纯 tail-read 快速通道。只返回新追加 records，不跑
 * buildChatFlow（那是 1.5-2s 瓶颈）。主处理器先调它广播 raw-records
 * SSE，再去做慢路径 build + delta。closure≤1 故意不写主 stash 避免
 * 干扰后续 parseJsonlFileIncremental；closure>1 更新 per-member stash
 * 让慢路径走"无新字节"快通道。
 */
export async function peekNewRecordsForDelta(args: {
  entryJsonlPath: string;
  entrySessionId: string;
  closure: ClosureMember[];
}): Promise<RawRecord[]> {
  const { entryJsonlPath, entrySessionId, closure } = args;
  if (closure.length <= 1) {
    const prevState = getStashedState(entrySessionId);
    if (!prevState) return []; // first call — no baseline to diff
    const prevCount = prevState.records.length;
    // readRecordsIncremental's state shape matches IncrementalParseState's
    // record-bearing subset; the chatFlow field is irrelevant for pure
    // tail-read. We don't write back — see docblock.
    // 中: 用 records-only 接口做 tail-read；不回写主 stash，让 slow
    // 路径的 parseJsonlFileIncremental 看到正确的 prevState。
    const r = await readRecordsIncremental(entryJsonlPath, {
      records: prevState.records,
      parseFailures: prevState.parseFailures,
      byteSize: prevState.byteSize,
      mtimeMs: prevState.mtimeMs,
      pendingFragment: prevState.pendingFragment,
    });
    return r.usedIncremental ? r.records.slice(prevCount) : [];
  }
  // closure > 1: tail-read each member's per-member stash and
  // aggregate with uuid-dedup (matches loadMergedChatFlowForDelta).
  const aggregated: RawRecord[] = [];
  const seen = new Set<string>();
  for (const m of closure) {
    const key = memberStashKey(entrySessionId, m.sessionId);
    const prevState = closureMemberStash.get(key);
    if (!prevState) continue; // first call for this member — skip
    const prevCount = prevState.records.length;
    const r = await readRecordsIncremental(m.jsonlPath, prevState);
    closureMemberStash.set(key, r.state);
    if (!r.usedIncremental) continue;
    for (const rec of r.records.slice(prevCount)) {
      if (rec.uuid && seen.has(rec.uuid)) continue;
      if (rec.uuid) seen.add(rec.uuid);
      aggregated.push(rec);
    }
  }
  return aggregated;
}

/** Test-only: clear all per-member stashes between cases. */
export function _resetMemberStashForTests(): void {
  closureMemberStash.clear();
}
