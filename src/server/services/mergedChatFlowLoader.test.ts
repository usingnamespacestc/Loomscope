// Regression: peek+load race for closure>1 produced stale empty
// workflows for newly-bucketed ChatNodes. peek advanced
// closureMemberStash to the file's new EOF; loadMergedChatFlowForDelta
// then read from that advanced stash and saw newRecords=[], which
// made dirty-bucket detection mark NOTHING dirty, so all buckets
// (including a brand-new one whose only prior state was the
// user-only empty workflow) were reused from the prev snapshot
// indefinitely.
//
// Repro shape (closure=2):
//   Tick 1: user record for new bucket X is appended.
//     • peek snapshots stash to EOF after user record.
//     • load builds chatFlow with bucket X = empty workflow (no
//       assistants yet); snapshot stored.
//   Tick 2: assistant records for bucket X are appended.
//     • peek tail-reads them, advances stash to new EOF.
//     • load runs from advanced stash → newRecords=[] → reuseHint
//       used with empty dirty set → bucket X reused as empty.
//
// Expected (post-fix): bucket X's workflow contains the assistant.

import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ClosureMember } from "@/server/services/forkTree";
import {
  clearClosureMemberStash,
  loadMergedChatFlowForDelta,
  peekNewRecordsForDelta,
} from "@/server/services/mergedChatFlowLoader";

const ENTRY_SID = "11111111-1111-4000-8000-000000000001";
const ANCESTOR_SID = "22222222-2222-4000-8000-000000000002";

function userRecord(uuid: string, promptId: string, sessionId: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    sessionId,
    promptId,
    isSidechain: false,
    message: { content: text, role: "user" },
  });
}

function assistantRecord(
  uuid: string,
  parentUuid: string,
  sessionId: string,
  text: string,
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: new Date().toISOString(),
    sessionId,
    isSidechain: false,
    message: {
      id: `msg_${uuid}`,
      model: "claude-sonnet-4-6",
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
}

describe("loadMergedChatFlowForDelta — peek+load race regression", () => {
  afterEach(() => {
    clearClosureMemberStash(ENTRY_SID);
  });

  it("newly-bucketed ChatNode keeps its assistant after peek+load+peek+load (closure=2)", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "loomscope-merged-"));
    const entryPath = path.join(tmpRoot, `${ENTRY_SID}.jsonl`);
    const ancestorPath = path.join(tmpRoot, `${ANCESTOR_SID}.jsonl`);
    // Ancestor: a single old bucket so closure=2 is real.
    await writeFile(
      ancestorPath,
      userRecord(
        "00000000-0000-4000-8000-000000000100",
        "promptid-ancestor-0001-4000-8000-000000000100",
        ANCESTOR_SID,
        "ancestor prompt",
      ) + "\n",
    );
    // Entry: start empty.
    await writeFile(entryPath, "");

    const closure: ClosureMember[] = [
      { sessionId: ENTRY_SID, jsonlPath: entryPath },
      { sessionId: ANCESTOR_SID, jsonlPath: ancestorPath },
    ];

    // First load (cold) — populates closureMemberStash + snapshot.
    const r0 = await loadMergedChatFlowForDelta({
      entryJsonlPath: entryPath,
      entrySessionId: ENTRY_SID,
      closure,
    });
    expect(r0.chatFlow.chatNodes).toHaveLength(1); // the ancestor

    // Tick 1: append a user record (new bucket X) to entry.
    const X_USER_UUID = "10000000-0000-4000-8000-000000000200";
    const X_PROMPT_ID = "promptid-newbucket-x-4000-8000-000000000200";
    await writeFile(
      entryPath,
      userRecord(X_USER_UUID, X_PROMPT_ID, ENTRY_SID, "new turn prompt") + "\n",
    );
    // Peek first (matches app.ts main handler order)…
    await peekNewRecordsForDelta({
      entryJsonlPath: entryPath,
      entrySessionId: ENTRY_SID,
      closure,
    });
    // …then load.
    const r1 = await loadMergedChatFlowForDelta({
      entryJsonlPath: entryPath,
      entrySessionId: ENTRY_SID,
      closure,
    });
    const bucketX_v1 = r1.chatFlow.chatNodes.find((cn) => cn.id === X_PROMPT_ID);
    expect(bucketX_v1, "bucket X exists after user-only tick").toBeDefined();
    expect(bucketX_v1!.workflow.nodes.length).toBe(0); // no assistant yet

    // Tick 2: append assistant record for bucket X.
    await writeFile(
      entryPath,
      userRecord(X_USER_UUID, X_PROMPT_ID, ENTRY_SID, "new turn prompt") +
        "\n" +
        assistantRecord(
          "20000000-0000-4000-8000-000000000300",
          X_USER_UUID,
          ENTRY_SID,
          "hello from the assistant — should be visible in workflow",
        ) +
        "\n",
    );
    // Peek first…
    const newRecsTick2 = await peekNewRecordsForDelta({
      entryJsonlPath: entryPath,
      entrySessionId: ENTRY_SID,
      closure,
    });
    expect(newRecsTick2.length, "peek tick2 sees the new assistant").toBe(1);

    // …then load. The bug: load reads from advanced stash → sees 0
    // newRecords → dirty set empty → bucket X reused as the empty
    // tick-1 version. Assistant lost.
    const r2 = await loadMergedChatFlowForDelta({
      entryJsonlPath: entryPath,
      entrySessionId: ENTRY_SID,
      closure,
    });
    const bucketX_v2 = r2.chatFlow.chatNodes.find((cn) => cn.id === X_PROMPT_ID);
    expect(bucketX_v2, "bucket X still present after tick 2").toBeDefined();
    const llmCount = bucketX_v2!.workflow.nodes.filter(
      (n) => n.kind === "llm_call",
    ).length;
    expect(
      llmCount,
      "bucket X's workflow must include the assistant llm_call",
    ).toBe(1);
  });
});
