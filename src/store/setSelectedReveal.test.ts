// #6b: selecting/jumping to a folded-away node unfolds the chain to
// reveal it and re-windows with the target as focus.
import { beforeEach, describe, expect, it } from "vitest";

import type { ChatFlow, ChatNode } from "@/data/types";
import { computeFoldProjection } from "@/canvas/foldProjection";
import { useStore } from "@/store/index";
import { makeSessionState } from "@/test/factories";

const SID = "reveal-sid-0001";

function cn(id: string, parentId: string | null, isCompact = false): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parentId,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: isCompact,
    compactMetadata: isCompact
      ? {
          id: `cw-${id}`,
          kind: "compact",
          parentUuid: null,
          summaryText: "...",
          trigger: "auto",
          logicalParentChatNodeId: parentId,
        }
      : undefined,
    meta: {},
  } as ChatNode;
}

// a → b → c → COMPACT(d) → e. Folding d hides [a, b, c].
function flow(): ChatFlow {
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: [
      cn("a", null),
      cn("b", "a"),
      cn("c", "b"),
      cn("d", "c", true),
      cn("e", "d"),
    ],
    orphans: [],
    flowEvents: [],
    trigger: "user",
  } as ChatFlow;
}

function seed(foldedCompactIds: Set<string>): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      ...makeSessionState(),
      chatFlow: flow(),
      foldedCompactIds,
    });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("setSelected — #6b reveal folded target", () => {
  it("unfolds the chain to reveal a folded node and selects it", () => {
    seed(new Set(["d"])); // d folded → a, b, c hidden
    // precondition: 'b' is hidden
    const before = computeFoldProjection(flow(), new Set(["d"]));
    expect(before.hidden.has("b")).toBe(true);

    useStore.getState().setSelected(SID, "b");

    const cur = useStore.getState().sessions.get(SID)!;
    expect(cur.selectedNodeId).toBe("b");
    // 'd' got unfolded → 'b' is now visible
    const after = computeFoldProjection(cur.chatFlow!, cur.foldedCompactIds);
    expect(after.hidden.has("b")).toBe(false);
    expect(cur.foldedCompactIds.has("d")).toBe(false);
  });

  it("leaves fold state untouched when selecting an already-visible node", () => {
    seed(new Set(["d"]));
    useStore.getState().setSelected(SID, "e"); // e is visible (not in d's range)
    const cur = useStore.getState().sessions.get(SID)!;
    expect(cur.selectedNodeId).toBe("e");
    expect(cur.foldedCompactIds.has("d")).toBe(true); // unchanged
  });
});
