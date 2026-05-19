// EN (PR-4 "content single-source", slice 1) — reproduce-first.
//
// Bug: the conversation bubble went BLANK on the Loomscope-send (SDK)
// path while the canvas card showed the assistant reply correctly;
// only a page reload recovered it. Root cause: rounds did
// `if (access.workflow) return buildConversationRounds(access.workflow)`,
// so a stale/early workflowCache fetch won OUTRIGHT over the fresh
// live `summary.assistantText` (the same source the canvas card
// reads). deriveConversationRounds makes the TEXT canonically the
// live store summary; the fetched workflow only enriches tool pills.
// These cases FAIL under the old "workflow wins" logic and pass now.
//
// 中: SDK 路径对话空白、卡片正常、刷新才好。根因 workflow 一存在就
// 赢、无视 live summary。改为文本以 store summary 为唯一真源，
// workflow 仅附加工具 pill。下列用例在旧逻辑下失败、现在通过。

import { describe, expect, it } from "vitest";

import { deriveConversationRounds } from "./ConversationView";
import type { ChatNode, WorkFlow } from "@/data/types";

function cn(assistantText: string[] | undefined): ChatNode {
  return {
    kind: "chat",
    id: "p1",
    parentChatNodeId: null,
    rootUserUuid: "u1",
    userMessage: { uuid: "u1", content: "q", attachments: [] },
    workflow: {
      nodes: [],
      edges: [],
      summary:
        assistantText === undefined
          ? undefined
          : ({ assistantText } as unknown as ChatNode["workflow"]["summary"]),
    },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  } as unknown as ChatNode;
}
function llm(id: string, text: string): WorkFlow["nodes"][number] {
  return {
    id,
    kind: "llm_call",
    parentUuid: null,
    text,
    thinking: [],
  } as unknown as WorkFlow["nodes"][number];
}
function tool(id: string, name: string): WorkFlow["nodes"][number] {
  return {
    id,
    kind: "tool_call",
    parentUuid: null,
    toolName: name,
    input: {},
  } as unknown as WorkFlow["nodes"][number];
}
function wf(nodes: WorkFlow["nodes"]): WorkFlow {
  return { nodes, edges: [] } as WorkFlow;
}

describe("deriveConversationRounds — content single-source", () => {
  it("THE BUG: a stale/empty fetched workflow must NOT blank the bubble — live summary text wins", () => {
    // Exactly the SDK-path repro: workflowCache fetched early/stale
    // (no llm nodes) but the assistant reply has since streamed into
    // the live store summary (canvas card shows it).
    const rounds = deriveConversationRounds(
      cn(["the streamed assistant reply"]),
      wf([]), // non-null but stale/empty → old code returned [] (blank)
    );
    expect(rounds).toEqual([
      { llmIndex: 0, text: "the streamed assistant reply", tools: [] },
    ]);
  });

  it("workflow null + summary text → text rounds (the always-worked path still works)", () => {
    expect(deriveConversationRounds(cn(["hello"]), null)).toEqual([
      { llmIndex: 0, text: "hello", tools: [] },
    ]);
  });

  it("loaded workflow only ENRICHES tools onto the canonical summary text (by llm index)", () => {
    const rounds = deriveConversationRounds(
      cn(["round zero text", "round one text"]),
      wf([
        llm("l0", "round zero text"),
        tool("t0", "Bash"),
        llm("l1", "round one text"),
      ]),
    );
    expect(rounds).toHaveLength(2);
    expect(rounds[0].text).toBe("round zero text");
    expect(rounds[0].tools.map((t) => (t as { toolName: string }).toolName)).toEqual([
      "Bash",
    ]);
    expect(rounds[1].text).toBe("round one text");
    expect(rounds[1].tools).toEqual([]);
  });

  it("stale workflow with FEWER rounds than summary → all summary text shown, tools best-effort", () => {
    const rounds = deriveConversationRounds(
      cn(["t0", "t1 (newer, not yet in fetched wf)"]),
      wf([llm("l0", "t0"), tool("t0a", "Read")]),
    );
    expect(rounds.map((r) => r.text)).toEqual([
      "t0",
      "t1 (newer, not yet in fetched wf)",
    ]);
    expect(rounds[0].tools).toHaveLength(1);
    expect(rounds[1].tools).toEqual([]);
  });

  it("no canonical summary text → falls back to fetched workflow (sub-agent inline / orphan-tool, no regression)", () => {
    const rounds = deriveConversationRounds(
      cn([]),
      wf([llm("l0", "only-on-workflow text"), tool("t0", "Grep")]),
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0].text).toBe("only-on-workflow text");
    expect(rounds[0].tools).toHaveLength(1);
  });

  it("summary undefined + workflow null → empty (no crash)", () => {
    expect(deriveConversationRounds(cn(undefined), null)).toEqual([]);
  });

  it("drops fully-empty rounds (empty text + no tools), matching buildConversationRounds", () => {
    const rounds = deriveConversationRounds(cn(["", "real text"]), null);
    expect(rounds).toEqual([{ llmIndex: 1, text: "real text", tools: [] }]);
  });
});
