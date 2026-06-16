// 2026-06-16: applyAssistantStreamText feeds streaming text from SDK
// sdk-message frames into the host ChatNode's summary, mirroring the
// jsonl-driven applyRawRecord path. Loomscope-spawned sessions only.
import { beforeEach, describe, expect, it } from "vitest";

import type { ChatFlow, ChatNode } from "@/data/types";
import { useStore } from "@/store/index";
import { makeSessionState, makeWorkflowSummary } from "@/test/factories";

const SID = "stream-sid-0001";

function placeholderNode(id: string): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: "", attachments: [] },
    workflow: { nodes: [], edges: [], summary: makeWorkflowSummary() },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  } as ChatNode;
}

function seed(nodes: ChatNode[] = [placeholderNode("p1")]): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      ...makeSessionState({
        chatFlow: {
          id: SID,
          mainJsonlPath: "/x.jsonl",
          sidecarDir: "/x",
          chatNodes: nodes,
          orphans: [],
          flowEvents: [],
          trigger: "user",
        } as ChatFlow,
      }),
    });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("applyAssistantStreamText", () => {
  it("appends text to the host ChatNode's assistantText and bumps preview", () => {
    seed();
    useStore.getState().applyAssistantStreamText(SID, {
      promptId: "p1",
      chunkId: "msg_001",
      text: "Hello",
      model: "claude-opus-4-8",
    });
    const s = useStore.getState().sessions.get(SID)!;
    const summary = s.chatFlow!.chatNodes[0].workflow.summary!;
    expect(summary.assistantText).toEqual(["Hello"]);
    expect(summary.assistantPreview).toBe("Hello");
    expect(summary.hasInFlightWork).toBe(true);
    expect(summary.lastModel).toBe("claude-opus-4-8");
  });

  it("dedups on chunkId — same id twice is a no-op", () => {
    seed();
    const apply = useStore.getState().applyAssistantStreamText;
    apply(SID, { promptId: "p1", chunkId: "msg_001", text: "Hello" });
    apply(SID, { promptId: "p1", chunkId: "msg_001", text: "Hello" });
    const s = useStore.getState().sessions.get(SID)!;
    expect(s.chatFlow!.chatNodes[0].workflow.summary!.assistantText).toEqual([
      "Hello",
    ]);
  });

  it("different chunkIds append in order (streaming)", () => {
    seed();
    const apply = useStore.getState().applyAssistantStreamText;
    apply(SID, { promptId: "p1", chunkId: "msg_001", text: "Hello " });
    apply(SID, { promptId: "p1", chunkId: "msg_002", text: "world" });
    const summary =
      useStore.getState().sessions.get(SID)!.chatFlow!.chatNodes[0].workflow
        .summary!;
    expect(summary.assistantText.join("")).toBe("Hello world");
  });

  it("no-ops when host ChatNode is absent (placeholder not yet created)", () => {
    seed([]); // empty chatFlow
    useStore.getState().applyAssistantStreamText(SID, {
      promptId: "p1",
      chunkId: "msg_001",
      text: "Hello",
    });
    expect(
      useStore.getState().sessions.get(SID)!.chatFlow!.chatNodes,
    ).toHaveLength(0);
  });

  it("no-ops when text is empty", () => {
    seed();
    useStore.getState().applyAssistantStreamText(SID, {
      promptId: "p1",
      chunkId: "msg_001",
      text: "",
    });
    expect(
      useStore.getState().sessions.get(SID)!.chatFlow!.chatNodes[0].workflow
        .summary!.assistantText,
    ).toEqual([]);
  });
});
