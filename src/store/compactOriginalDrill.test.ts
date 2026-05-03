// v0.7 M3 — store action enterCompactOriginal + resolveDrillView
// compact-original branch + computePreCompactRange helper.
//
// The drill semantic: clicking a compact ChatNode's "⤢ 展开 pre-compact"
// pushes (or replaces with) a `compact-original` DrillFrame; the
// resolver synthesises a ChatFlow holding only the pre-compact range
// (walked via parentChatNodeId from compactMetadata.logicalParentChatNodeId
// backward until session root or another compact ChatNode); App.tsx
// renders that synthetic flow recursively via ChatFlowCanvas (= reuses
// the v0.6 redo sub-chatflow path).

import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store/index";
import {
  computePreCompactRange,
  resolveDrillView,
} from "@/store/sessionSlice";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "00000000-0000-4000-8000-0000000000aa";

// Helpers ────────────────────────────────────────────────────────────

function chatNode(
  id: string,
  parentId: string | null,
  isCompact = false,
  logicalParentChatNodeId?: string | null,
): ChatNode {
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
          id: `compact-wn-${id}`,
          kind: "compact",
          parentUuid: null,
          summaryText: "...",
          trigger: "auto",
          logicalParentChatNodeId: logicalParentChatNodeId ?? null,
        }
      : undefined,
    meta: {},
  };
}

function chatFlow(nodes: ChatNode[]): ChatFlow {
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

function seed(cf: ChatFlow): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow: cf,
      foldedNodeIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      workflowSelectedNodeId: null,
      drillStack: [],
      subAgentCache: new Map(),
      isLoading: false,
      error: null,
      lastUpdated: Date.now(),
    });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

// ────────────────────────────────────────────────────────────────────
// computePreCompactRange
// ────────────────────────────────────────────────────────────────────

describe("computePreCompactRange", () => {
  // Layout: a → b → c → COMPACT(d, lpcn=c) → e → f → COMPACT(g, lpcn=f) → h
  // pre-compact range for d should be [a, b, c]
  // pre-compact range for g should be [e, f] (stops at d, the prior compact)
  function rangedFlow() {
    return chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b"),
      chatNode("d", "c", true, "c"),
      chatNode("e", "d"),
      chatNode("f", "e"),
      chatNode("g", "f", true, "f"),
      chatNode("h", "g"),
    ]);
  }

  it("walks parentChatNodeId from logicalParentChatNodeId back to root for the first compact", () => {
    const cf = rangedFlow();
    const range = computePreCompactRange(cf, "d");
    expect(range.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("stops at a previous compact ChatNode (does NOT include or cross it)", () => {
    const cf = rangedFlow();
    const range = computePreCompactRange(cf, "g");
    expect(range.map((c) => c.id)).toEqual(["e", "f"]);
  });

  it("returns [] when the anchor isn't a compact ChatNode", () => {
    const cf = rangedFlow();
    expect(computePreCompactRange(cf, "a")).toEqual([]);
  });

  it("returns [] when compactMetadata.logicalParentChatNodeId is missing", () => {
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("d", "a", true, null),
    ]);
    expect(computePreCompactRange(cf, "d")).toEqual([]);
  });

  it("returns [] when the resolved logicalParentChatNodeId points to a non-existent ChatNode", () => {
    const cf = chatFlow([chatNode("d", null, true, "ghost-id")]);
    expect(computePreCompactRange(cf, "d")).toEqual([]);
  });

  it("returns time-ascending order even when collected via reverse walk", () => {
    // Tail is c, walking back: c, b, a. Reversed for output: a, b, c.
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b"),
      chatNode("d", "c", true, "c"),
    ]);
    const range = computePreCompactRange(cf, "d");
    expect(range.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// enterCompactOriginal action
// ────────────────────────────────────────────────────────────────────

describe("enterCompactOriginal", () => {
  function seedRangedFlow() {
    seed(
      chatFlow([
        chatNode("a", null),
        chatNode("b", "a"),
        chatNode("c", "b"),
        chatNode("d", "c", true, "c"),
        chatNode("e", "d"),
      ]),
    );
  }

  it("from empty stack: pushes a single compact-original frame", () => {
    seedRangedFlow();
    useStore.getState().enterCompactOriginal(SID, "d");
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toEqual([{ kind: "compact-original", compactChatNodeId: "d" }]);
  });

  it("idempotent on the same compactChatNodeId at the top", () => {
    seedRangedFlow();
    useStore.getState().enterCompactOriginal(SID, "d");
    const before = useStore.getState().sessions.get(SID)?.drillStack;
    useStore.getState().enterCompactOriginal(SID, "d");
    const after = useStore.getState().sessions.get(SID)?.drillStack;
    expect(after).toEqual(before);
  });

  it("from chatnode-only stack: REPLACES with single compact-original frame (alternative view, not nested)", () => {
    seedRangedFlow();
    useStore.getState().enterWorkflow(SID, "d"); // viewing compact d's inner workflow
    useStore.getState().enterCompactOriginal(SID, "d");
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toEqual([{ kind: "compact-original", compactChatNodeId: "d" }]);
  });

  it("ignores when target is not a compact ChatNode", () => {
    seedRangedFlow();
    useStore.getState().enterCompactOriginal(SID, "a"); // a is not compact
    expect(useStore.getState().sessions.get(SID)?.drillStack).toEqual([]);
  });

  it("ignores when compact ChatNode has no logicalParentChatNodeId (rare)", () => {
    seed(
      chatFlow([
        chatNode("a", null),
        chatNode("d", "a", true, null), // missing lpcn
      ]),
    );
    useStore.getState().enterCompactOriginal(SID, "d");
    expect(useStore.getState().sessions.get(SID)?.drillStack).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// resolveDrillView compact-original branch
// ────────────────────────────────────────────────────────────────────

describe("resolveDrillView — compact-original frame", () => {
  function seedRangedFlow() {
    seed(
      chatFlow([
        chatNode("a", null),
        chatNode("b", "a"),
        chatNode("c", "b"),
        chatNode("d", "c", true, "c"),
        chatNode("e", "d"),
      ]),
    );
  }

  it("returns sub-chatflow mode with synthetic ChatFlow holding the pre-compact range", () => {
    seedRangedFlow();
    useStore.getState().enterCompactOriginal(SID, "d");
    const view = resolveDrillView(useStore.getState().sessions.get(SID)!);
    expect(view?.mode).toBe("sub-chatflow");
    if (view?.mode !== "sub-chatflow") throw new Error("expected sub-chatflow");
    expect(view.chatFlow.chatNodes.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("rewrites the head ChatNode's parentChatNodeId to null in the synthetic flow", () => {
    seedRangedFlow();
    useStore.getState().enterCompactOriginal(SID, "d");
    const view = resolveDrillView(useStore.getState().sessions.get(SID)!);
    if (view?.mode !== "sub-chatflow") throw new Error("expected sub-chatflow");
    expect(view.chatFlow.chatNodes[0].id).toBe("a");
    expect(view.chatFlow.chatNodes[0].parentChatNodeId).toBeNull();
    // Subsequent ChatNodes preserve their original parent chain.
    expect(view.chatFlow.chatNodes[1].parentChatNodeId).toBe("a");
    expect(view.chatFlow.chatNodes[2].parentChatNodeId).toBe("b");
  });

  it("breadcrumb frame has kind 'compact-original' and ⊞ pre-compact label", () => {
    seedRangedFlow();
    useStore.getState().enterCompactOriginal(SID, "d");
    const view = resolveDrillView(useStore.getState().sessions.get(SID)!);
    if (!view) throw new Error("expected resolved view");
    expect(view.frameLabels).toHaveLength(1);
    const f = view.frameLabels[0];
    expect(f.kind).toBe("compact-original");
    expect(f.label).toMatch(/pre-compact/);
    expect(f.label).toMatch(/⊞/);
    expect(f.title).toMatch(/pre-compact original sequence/);
  });

  it("returns null when range is empty (compactMetadata.logicalParentChatNodeId missing)", () => {
    seed(
      chatFlow([
        chatNode("a", null),
        chatNode("d", "a", true, null),
      ]),
    );
    // Bypass the action's validation guard to exercise the resolver
    // path directly.
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      sessions.set(SID, {
        ...cur,
        drillStack: [{ kind: "compact-original", compactChatNodeId: "d" }],
      });
      return { sessions };
    });
    const view = resolveDrillView(useStore.getState().sessions.get(SID)!);
    expect(view).toBeNull();
  });

  it("does not mutate the source ChatFlow's chatNodes (synthetic flow uses cloned head)", () => {
    seedRangedFlow();
    const before = useStore.getState().sessions.get(SID)!.chatFlow!.chatNodes[0];
    useStore.getState().enterCompactOriginal(SID, "d");
    resolveDrillView(useStore.getState().sessions.get(SID)!);
    const after = useStore.getState().sessions.get(SID)!.chatFlow!.chatNodes[0];
    expect(after).toBe(before);
    expect(after.parentChatNodeId).toBeNull(); // never had a parent originally
  });
});
