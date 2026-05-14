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

/**
 * EN (v2.2 PR E3): per-entry-session snapshot of the LAST merged
 * ChatFlow + the closure shape it was built from. Lets the closure>1
 * path feed a `BuildChatFlowReuseHint` into buildChatFlow so dirty-
 * bucket reuse kicks in (otherwise every chokidar event rebuilds all
 * 664 ChatNodes — ~6s on the user's main session).
 *
 * Cache invalidation:
 *   • Closure shape change (member added/removed) → drop snapshot;
 *     reuse hint is shape-dependent.
 *   • Closure>1 → ≤1 transition → drop (caller switches to the
 *     stash-based incremental path; merged snapshot is stale).
 *   • Member jsonl shrunk → readRecordsIncremental falls back to
 *     full; we drop the snapshot too because newRecords becomes
 *     unreliable (full record set, not a delta).
 *
 * 中: 每个 entry session 保留上次合并 ChatFlow + closure 形状，让
 * closure>1 路径喂 buildChatFlow reuseHint，dirty bucket 复用生效——
 * 否则每次 chokidar 都重建所有 664 ChatNode (~6s)。closure 形状变 /
 * shrink fallback 时 drop snapshot。
 */
interface MergedChatFlowSnapshot {
  chatFlow: ChatFlow;
  closureMemberIds: string[];
}
const mergedChatFlowSnapshot = new Map<string, MergedChatFlowSnapshot>();

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
  // v2.2 PR E3: also drop the merged-chatflow snapshot; without
  // matching member-stashes there's no usable reuseHint to derive.
  // 中: per-member stash 清空时同时 drop 整体 snapshot（reuseHint
  // 失去来源）。
  mergedChatFlowSnapshot.delete(entrySid);
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
    // PR E3: drop merged snapshot if we just transitioned from
    // closure>1 — its reuse hint is no longer applicable.
    // 中: 形态从 closure>1 切回 ≤1 时 drop snapshot，旧 hint 失效。
    mergedChatFlowSnapshot.delete(entrySessionId);
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
  // Aggregate newRecords with uuid-dedup (same logic as merged). We
  // need these BEFORE buildChatFlow so we can hand them to the
  // reuseHint as the dirty-record list (PR E3).
  // 中: newRecords 跨 member 去重；PR E3 把这个列表喂给 reuseHint
  // 做 dirty bucket detection。
  const newSeen = new Set<string>();
  const aggregatedNew: RawRecord[] = [];
  for (const { newRecords } of recordsByMember) {
    for (const r of newRecords) {
      if (r.uuid && newSeen.has(r.uuid)) continue;
      if (r.uuid) newSeen.add(r.uuid);
      aggregatedNew.push(r);
    }
  }

  // PR E3: build reuseHint when we have a prior snapshot of the same
  // closure shape. Without this, buildChatFlow rebuilds every bucket
  // (~6s on 664-ChatNode sessions). With it, dirty buckets are
  // typically 1-2 (the just-appended turn), bringing build to
  // ~50-100ms.
  //
  // Shape check: closureMemberIds (in declaration order) must match.
  // If a member was added/removed/reordered, we can't safely reuse —
  // the merged record stream's bucket-to-promptId mapping could
  // differ.
  //
  // 中: 同 closure 形状下走 reuseHint，dirty 1-2 buckets → ~50ms。
  // member 变动则不安全，跳过 reuse。
  const currentShape = closure.map((m) => m.sessionId);
  const prevSnapshot = mergedChatFlowSnapshot.get(entrySessionId);
  const shapeMatches =
    prevSnapshot != null &&
    prevSnapshot.closureMemberIds.length === currentShape.length &&
    prevSnapshot.closureMemberIds.every((id, i) => id === currentShape[i]);
  // Also: when ANY member fell back to full-read (usedIncremental=false),
  // newRecords contains the entire member's records, so dirty-bucket
  // detection would mark everything dirty — defeating the optimization
  // AND producing a misleading newRecords broadcast. Drop reuseHint in
  // that case.
  // 中: 任一 member 落回 full-read 时 newRecords 实际是全量，dirty
  // 检测会标全脏；reuseHint 没意义，跳过。
  const anyMemberFellBack = recordsByMember.some(
    (m) => m.newRecords.length > 0 && m.newRecords.length === m.records.length,
  );
  const reuseHint =
    shapeMatches && prevSnapshot && !anyMemberFellBack
      ? {
          prevChatFlow: prevSnapshot.chatFlow,
          prevRecordCount: 0, // unused in newRecords mode
          newRecords: aggregatedNew,
        }
      : undefined;

  const chatFlow = buildChatFlow(merged, entryJsonlPath, {}, reuseHint);
  chatFlow.id = entrySessionId;
  chatFlow.linkedSessions = closure.map((m) => m.sessionId);

  // Update merged snapshot for the next call.
  // 中: 写回 snapshot 给下次 reuseHint 用。
  mergedChatFlowSnapshot.set(entrySessionId, {
    chatFlow,
    closureMemberIds: currentShape,
  });

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
 * Stash mutation: deliberately does NOT update any stash. The
 * subsequent loadMergedChatFlowForDelta call needs to see the prev
 * stash unchanged so its own tail-read produces a non-empty
 * newRecords list — that list feeds buildChatFlow's reuse-hint
 * dirty-bucket detection. If peek were to advance the stash, load's
 * newRecords would be empty, dirty detection would mark nothing
 * dirty, and ALL chatNodes (including a brand-new bucket whose
 * tick-1 snapshot held only the user prompt with no assistant yet)
 * would be reused from the prev snapshot indefinitely.
 *
 * The duplicate tail-read IO (peek's + load's) costs ~3-5ms total,
 * negligible vs. buildChatFlow's 1.5-2s and vastly cheaper than the
 * "newly-bucketed turns lose their assistant text" bug it prevents
 * (see mergedChatFlowLoader.test.ts).
 *
 * 中: 纯 tail-read 快速通道，故意 NOT mutate stash（包括 closure>1
 * 的 per-member stash）。后续 loadMergedChatFlowForDelta 必须看到
 * 原始 prevState 才能算出非空 newRecords，dirty 检测才能把刚到的
 * 桶标脏。如果 peek 提前 advance stash，load 看到的 newRecords=[]
 * → dirty 集为空 → 所有 chatNode 都从 prev snapshot 复用，导致
 * 新桶（tick-1 还只有 user 没 assistant 的空 workflow）永远卡在
 * 空状态。代价 = ~3-5ms 重复 tail-read IO，跟 1.5-2s 的
 * buildChatFlow 相比可以忽略。
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
  // Read against a SHALLOW COPY of prevState so we don't advance the
  // shared closureMemberStash; the subsequent
  // loadMergedChatFlowForDelta needs to see prevState unchanged to
  // compute non-empty newRecords for buildChatFlow's reuse hint.
  // 中: 用 prevState 的浅拷贝走 readRecordsIncremental，避免回写
  // 共享 stash 导致 slow path 看不到新 record。
  const aggregated: RawRecord[] = [];
  const seen = new Set<string>();
  for (const m of closure) {
    const key = memberStashKey(entrySessionId, m.sessionId);
    const prevState = closureMemberStash.get(key);
    if (!prevState) continue; // first call for this member — skip
    const prevCount = prevState.records.length;
    const r = await readRecordsIncremental(m.jsonlPath, {
      records: prevState.records,
      parseFailures: prevState.parseFailures,
      byteSize: prevState.byteSize,
      mtimeMs: prevState.mtimeMs,
      pendingFragment: prevState.pendingFragment,
    });
    // INTENTIONALLY do NOT write r.state back. See docblock.
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
  mergedChatFlowSnapshot.clear();
}
