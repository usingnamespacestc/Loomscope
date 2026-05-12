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

/** Load + merge a ChatFlow from a fork closure. Identical to the
 *  former sessions.ts internal helper — extracted so delta engine
 *  shares the same loader. */
export async function loadMergedChatFlowForDelta(args: {
  entryJsonlPath: string;
  entrySessionId: string;
  closure: ClosureMember[];
}): Promise<ChatFlow> {
  const { entryJsonlPath, entrySessionId, closure } = args;
  if (closure.length <= 1) {
    const prevState = getStashedState(entrySessionId);
    const r = await parseJsonlFileIncremental(entryJsonlPath, prevState);
    setStashedState(entrySessionId, r.state);
    return r.chatFlow;
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
  const recordsByMember: Array<{ sessionId: string; records: RawRecord[] }> = [];
  for (const m of closure) {
    const key = memberStashKey(entrySessionId, m.sessionId);
    const prevState = closureMemberStash.get(key);
    const r = await readRecordsIncremental(m.jsonlPath, prevState);
    closureMemberStash.set(key, r.state);
    recordsByMember.push({ sessionId: m.sessionId, records: r.records });
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
  return chatFlow;
}

/** Test-only: clear all per-member stashes between cases. */
export function _resetMemberStashForTests(): void {
  closureMemberStash.clear();
}
