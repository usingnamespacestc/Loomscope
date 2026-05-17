// EN (2026-05-16): integration repro for "first append after session
// open emits no chatnode-added delta".
//
// e2e (e2e/sse_autorefresh.spec.ts) consistently showed turn-2 (the
// first jsonl append after the browser opened the session) never
// receiving a `chatnode-added` delta — it rendered only via the
// raw-records optimistic placeholder, so the assistant content never
// filled in without a manual refresh.
//
// This isolates the SERVER pipeline deterministically (no browser):
//   1. write turn1
//   2. "GET /:id open"  → loadMergedChatFlowForDelta primes the
//      shared stash; the GET route does NOT call processFresh.
//   3. append turn2
//   4. "chokidar change" → loadMergedChatFlowForDelta → processFresh.
//      ASSERT: deltas include chatnode-added for turn2's promptId.
//   5. repeat for turn3..turn6.
//
// 中: 复现"开会话后第一次 append 不发 chatnode-added"。GET 只 prime
// stash 不 processFresh；首个 chokidar 才 processFresh。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadMergedChatFlowForDelta,
} from "@/server/services/mergedChatFlowLoader";
import {
  processFresh,
  _resetAllForTests,
} from "@/server/services/chatFlowDeltaEngine";
import { _resetForTests as _resetCacheForTests } from "@/server/services/chatFlowCache";
import type { ClosureMember } from "@/server/services/forkTree";

const SID = "feeed000-0000-4000-8000-000000000abc";
let dir: string;
let jsonlPath: string;
let closure: ClosureMember[];
let lastUuid: string | null = null;
let turn = 0;

function userRec(pid: string, uuid: string, parent: string | null): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    promptId: pid,
    type: "user",
    message: { role: "user", content: `turn ${turn} prompt` },
    uuid,
    timestamp: new Date().toISOString(),
    permissionMode: "bypassPermissions",
    userType: "external",
    entrypoint: "cli",
    cwd: "/home/u",
    sessionId: SID,
    version: "2.1.133",
    gitBranch: "HEAD",
  });
}
function asstRec(uuid: string, parent: string): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      id: `msg_${uuid.slice(0, 12)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `turn ${turn} reply` }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 20,
      },
    },
    uuid,
    timestamp: new Date().toISOString(),
    cwd: "/home/u",
    sessionId: SID,
    version: "2.1.133",
    gitBranch: "HEAD",
  });
}
async function appendTurn(): Promise<string> {
  turn += 1;
  const n = turn;
  const pid = `feeed000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const u = `aaaa0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const a = `bbbb0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lines = userRec(pid, u, lastUuid) + "\n" + asstRec(a, u) + "\n";
  await appendFile(jsonlPath, lines);
  lastUuid = a;
  return pid;
}

async function chokidarTick(): Promise<string[]> {
  const { chatFlow } = await loadMergedChatFlowForDelta({
    entryJsonlPath: jsonlPath,
    entrySessionId: SID,
    closure,
  });
  const deltas = await processFresh(SID, chatFlow);
  return deltas
    .filter((d) => d.type === "chatnode-added")
    .map((d) => (d as { chatNode: { id: string } }).chatNode.id);
}

beforeEach(async () => {
  _resetAllForTests();
  _resetCacheForTests();
  dir = await mkdtemp(path.join(os.tmpdir(), "loomscope-delta-open-"));
  jsonlPath = path.join(dir, `${SID}.jsonl`);
  closure = [{ sessionId: SID, jsonlPath }];
  lastUuid = null;
  turn = 0;
  await writeFile(jsonlPath, "");
});
afterEach(async () => {
  _resetAllForTests();
  _resetCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("delta engine — first append after open emits chatnode-added", () => {
  it("turn2 (first append after GET-open) gets a chatnode-added delta", async () => {
    const t1 = await appendTurn(); // turn1 — pre-open seed

    // "GET /:id open": primes the shared incremental-parse stash.
    // The real GET route does NOT call processFresh — only chokidar
    // does. So snapshot stays unseeded here.
    await loadMergedChatFlowForDelta({
      entryJsonlPath: jsonlPath,
      entrySessionId: SID,
      closure,
    });

    // First append after open.
    const t2 = await appendTurn();
    const added1 = await chokidarTick();

    // Both turn1 + turn2 should appear as chatnode-added (snapshot was
    // never seeded → first processFresh emits added-for-all).
    expect(added1, "turn1 + turn2 both added on first processFresh").toEqual(
      expect.arrayContaining([t1, t2]),
    );

    // Subsequent appends each get exactly one new chatnode-added.
    const t3 = await appendTurn();
    const added2 = await chokidarTick();
    expect(added2).toContain(t3);
    expect(added2).not.toContain(t2); // already in snapshot

    const t4 = await appendTurn();
    const added3 = await chokidarTick();
    expect(added3).toContain(t4);
  });

  it("every one of 8 sequential appends yields its chatnode-added", async () => {
    await appendTurn(); // turn1 seed
    await loadMergedChatFlowForDelta({
      entryJsonlPath: jsonlPath,
      entrySessionId: SID,
      closure,
    });
    const got = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const pid = await appendTurn();
      const added = await chokidarTick();
      for (const id of added) got.add(id);
      expect(
        got.has(pid),
        `append #${i + 2} (${pid}) must have a chatnode-added by now`,
      ).toBe(true);
    }
  });
});
