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

import { createReadStream } from "node:fs";
import readline from "node:readline";

import {
  buildChatFlow,
  parseJsonlFileIncremental,
} from "@/parse/jsonl";
import { parseLine, type RawRecord } from "@/parse/raw-record";
import {
  clearStashedState,
  getStashedState,
  setStashedState,
} from "@/server/services/chatFlowCache";
import type { ClosureMember } from "@/server/services/forkTree";
import type { ChatFlow } from "@/data/types";

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
  const recordsByMember: Array<{ sessionId: string; records: RawRecord[] }> = [];
  for (const m of closure) {
    const records = await readAllRecords(m.jsonlPath);
    recordsByMember.push({ sessionId: m.sessionId, records });
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

async function readAllRecords(jsonlPath: string): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = parseLine(line);
    if (r) records.push(r);
  }
  return records;
}
