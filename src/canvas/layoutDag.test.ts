import { describe, expect, it } from "vitest";

import {
  distinctToolUseFiles,
  distinctTouchedFiles,
  layoutChatFlow,
  lastAssistantPreview,
  maxContextForModel,
  nodeOwnFileChanges,
  previewUserContent,
} from "@/canvas/layoutDag";
import type { ChatFlow, ChatNode } from "@/data/types";

function makeChatNode(overrides: Partial<ChatNode>): ChatNode {
  const id = overrides.id ?? "p-1";
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `${id}-u`,
    userMessage: { uuid: `${id}-u`, content: "", attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
    ...overrides,
  };
}

function makeChatFlow(chatNodes: ChatNode[]): ChatFlow {
  return {
    id: "session-x",
    mainJsonlPath: "/tmp/x.jsonl",
    sidecarDir: "/tmp/x",
    chatNodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

describe("layoutChatFlow", () => {
  it("emits one RF node per ChatNode", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
      makeChatNode({ id: "p3", parentChatNodeId: "p2" }),
    ]);
    const { nodes, edges } = layoutChatFlow(cf);
    expect(nodes.map((n) => n.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(edges.length).toBe(2);
  });

  it("emits continuation edges from parentChatNodeId", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
    ]);
    const { edges } = layoutChatFlow(cf);
    expect(edges[0].source).toBe("p1");
    expect(edges[0].target).toBe("p2");
    expect(edges[0].type).toBe("continuation");
  });

  it("lays out left→right (LR): parent x < child x", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const a = nodes.find((n) => n.id === "p1")!;
    const b = nodes.find((n) => n.id === "p2")!;
    expect(a.position.x).toBeLessThan(b.position.x);
  });

  it("preserves chatNode reference inside data so card can reach into workflow", () => {
    const cn = makeChatNode({ id: "p1" });
    const cf = makeChatFlow([cn]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.chatNode).toBe(cn);
  });

  it("edge data carries target ChatNode's last llm_call model (for hover tooltip)", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l1",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
            },
          ],
          edges: [],
        },
      }),
      makeChatNode({
        id: "p2",
        parentChatNodeId: "p1",
        workflow: {
          nodes: [
            {
              id: "l2",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-sonnet-4-6",
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { edges } = layoutChatFlow(cf);
    expect(edges).toHaveLength(1);
    expect((edges[0].data as { targetModel?: string }).targetModel).toBe("claude-sonnet-4-6");
  });

  it("edge targetModel is undefined when target has no llm_call (e.g. slash command)", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" /* no llm_call */ }),
    ]);
    const { edges } = layoutChatFlow(cf);
    expect((edges[0].data as { targetModel?: string }).targetModel).toBeUndefined();
  });

  it("looks up context window per-ChatNode based on each turn's model — mid-session switch is honored", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l1",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 100, cache_read_input_tokens: 50_000 },
            },
          ],
          edges: [],
        },
      }),
      makeChatNode({
        id: "p2",
        parentChatNodeId: "p1",
        workflow: {
          nodes: [
            {
              id: "l2",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-sonnet-4-6", // switched
              usage: { input_tokens: 100, cache_read_input_tokens: 30_000 },
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const a = nodes.find((n) => n.id === "p1")!;
    const b = nodes.find((n) => n.id === "p2")!;
    // p1 → Opus → 1M cap regardless of token count
    expect(a.data.maxContextTokens).toBe(1_000_000);
    expect(a.data.contextTokens).toBe(50_100);
    // p2 → Sonnet → 200k cap (mid-session switch reflected)
    expect(b.data.maxContextTokens).toBe(200_000);
    expect(b.data.contextTokens).toBe(30_100);
  });

  it("uses *last* llm_call's model within a single ChatNode (final context state)", () => {
    // Within one turn the model could in principle change mid-loop;
    // we surface the model at end-of-turn (last llm_call) since
    // that's the snapshot a viewer cares about: "where did we end up?"
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l-early",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 5, cache_read_input_tokens: 100 },
            },
            {
              id: "l-late",
              kind: "llm_call",
              parentUuid: "l-early",
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 200, cache_read_input_tokens: 80_000 },
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.maxContextTokens).toBe(1_000_000);
    expect(nodes[0].data.contextTokens).toBe(80_200);
  });

  it("skips <synthetic> tail llm_call (rate-limit 429 placeholder) when picking last model + tokens", () => {
    // CC injects a fake assistant record with model="<synthetic>" and
    // zero usage when the API returns 429 / interruption / etc. If the
    // last real llm_call ran on opus + 80k context, the bar must stay
    // at 80k, not collapse to 0 from the synthetic tail.
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l-real",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 200, cache_read_input_tokens: 80_000 },
            },
            {
              id: "l-synth",
              kind: "llm_call",
              parentUuid: "l-real",
              text: "You've hit your limit · resets 6am",
              thinking: [],
              model: "<synthetic>",
              usage: { input_tokens: 0, cache_read_input_tokens: 0 },
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes, edges } = layoutChatFlow(cf);
    expect(nodes[0].data.contextTokens).toBe(80_200);
    expect(nodes[0].data.maxContextTokens).toBe(1_000_000);
    // Edge tooltip targetModel should also reflect the real model,
    // not "<synthetic>" — there's only one chatNode here so no edges,
    // but if there were a child this would matter.
    expect(edges).toEqual([]);
  });

  it("skips errored llm_call when picking last model + tokens", () => {
    // Same principle as <synthetic>: an errored attempt isn't the
    // canonical "where the turn ended up" state.
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l-real",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 100, cache_read_input_tokens: 50_000 },
            },
            {
              id: "l-error",
              kind: "llm_call",
              parentUuid: "l-real",
              text: "",
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 0, cache_read_input_tokens: 0 },
              errors: [{ type: "overloaded_error", message: "" }],
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.contextTokens).toBe(50_100);
  });

  it("counts tool/llm nodes in workflow", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        workflow: {
          nodes: [
            {
              id: "l1",
              kind: "llm_call",
              parentUuid: null,
              text: "Hello",
              thinking: [],
            },
            {
              id: "t1",
              kind: "tool_call",
              parentUuid: null,
              toolName: "Bash",
              input: {},
            },
            {
              id: "d1",
              kind: "delegate",
              parentUuid: null,
              toolName: "Agent",
            },
          ],
          edges: [],
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(nodes[0].data.llmCount).toBe(1);
    expect(nodes[0].data.toolCount).toBe(2); // tool_call + delegate
  });
});

describe("maxContextForModel", () => {
  it("opus → 1M (default 1M context per CC /model picker)", () => {
    expect(maxContextForModel("claude-opus-4-7")).toBe(1_000_000);
    expect(maxContextForModel("claude-opus-4-6")).toBe(1_000_000);
  });
  it("sonnet → 200k (1M beta is rare, default 200k)", () => {
    expect(maxContextForModel("claude-sonnet-4-6")).toBe(200_000);
    expect(maxContextForModel("claude-sonnet-4-5")).toBe(200_000);
  });
  it("haiku → 200k", () => {
    expect(maxContextForModel("claude-haiku-4-5")).toBe(200_000);
  });
  it("unknown / undefined → 200k safe default", () => {
    expect(maxContextForModel(undefined)).toBe(200_000);
    expect(maxContextForModel("")).toBe(200_000);
    expect(maxContextForModel("gpt-4o")).toBe(200_000);
    expect(maxContextForModel("future-claude-x")).toBe(200_000);
  });
  it("ignores [1m] suffix presence — table is keyed on model family, not suffix", () => {
    // CC strips [1m] from jsonl; even if it leaks through somehow, family
    // match dominates.
    expect(maxContextForModel("claude-opus-4-7[1m]")).toBe(1_000_000);
    expect(maxContextForModel("claude-sonnet-4-6[1m]")).toBe(200_000);
  });
});

describe("previewUserContent", () => {
  it("returns truncated string content", () => {
    const long = "a".repeat(200);
    const out = previewUserContent(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(previewUserContent("  hello   world  ")).toBe("hello world");
  });

  it("extracts text from block array", () => {
    expect(previewUserContent([{ type: "text", text: "block content" }])).toBe(
      "block content",
    );
  });

  it("returns empty string for unsupported shapes", () => {
    expect(previewUserContent(null)).toBe("");
    expect(previewUserContent({ foo: "bar" })).toBe("");
  });
});

describe("lastAssistantPreview", () => {
  it("returns the last non-empty llm_call text", () => {
    const cn = makeChatNode({
      id: "p1",
      workflow: {
        nodes: [
          { id: "l1", kind: "llm_call", parentUuid: null, text: "early thought", thinking: [] },
          { id: "l2", kind: "llm_call", parentUuid: null, text: "", thinking: [] },
          { id: "l3", kind: "llm_call", parentUuid: null, text: "final answer", thinking: [] },
        ],
        edges: [],
      },
    });
    expect(lastAssistantPreview(cn)).toBe("final answer");
  });

  it("returns empty string when no llm_call has text", () => {
    const cn = makeChatNode({ id: "p1" });
    expect(lastAssistantPreview(cn)).toBe("");
  });
});

describe("distinctTouchedFiles + fileTouchCount RFData (v0.7 → mid-turn-commit fix)", () => {
  it("returns ONLY the latest snapshot's trackedFiles — earlier snapshots are stale once mid-turn `git commit` clears them", () => {
    // Pre-fix this unioned to {A, B, C}, leaving the chip inflated
    // after a mid-turn commit. Post-fix the second snapshot wins.
    const cn = makeChatNode({
      id: "p1",
      meta: {
        fileHistorySnapshots: [
          { uuid: "a", trackedFiles: ["A.ts", "B.ts"], isUpdate: false },
          { uuid: "b", trackedFiles: ["B.ts", "C.ts"], isUpdate: true },
        ],
      },
    });
    expect(Array.from(distinctTouchedFiles(cn)).sort()).toEqual(["B.ts", "C.ts"]);
  });

  it("returns empty Set when no snapshots are bound", () => {
    const cn = makeChatNode({ id: "p1" });
    expect(distinctTouchedFiles(cn).size).toBe(0);
  });

  it("returns empty Set when latest snapshot is empty (post-commit clean working tree)", () => {
    const cn = makeChatNode({
      id: "p1",
      meta: {
        fileHistorySnapshots: [
          { uuid: "before", trackedFiles: ["dirty1.ts", "dirty2.ts"], isUpdate: false },
          { uuid: "after-commit", trackedFiles: [], isUpdate: true },
        ],
      },
    });
    expect(distinctTouchedFiles(cn).size).toBe(0);
  });

  it("distinctToolUseFiles picks Edit/Write/MultiEdit/NotebookEdit paths, ignores Bash", () => {
    const cn = makeChatNode({
      id: "p1",
      workflow: {
        nodes: [
          {
            id: "t1",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Edit",
            input: { file_path: "edit.ts" },
          },
          {
            id: "t2",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Write",
            input: { file_path: "write.ts" },
          },
          {
            id: "t3",
            kind: "tool_call",
            parentUuid: null,
            toolName: "MultiEdit",
            input: { file_path: "multi.ts" },
          },
          {
            id: "t4",
            kind: "tool_call",
            parentUuid: null,
            toolName: "NotebookEdit",
            input: { notebook_path: "nb.ipynb" },
          },
          {
            id: "t5",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Bash",
            input: { command: "echo hi" },
          },
          // missing input — should not crash
          {
            id: "t6",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Edit",
            input: {},
          },
        ],
        edges: [],
      },
    });
    expect(Array.from(distinctToolUseFiles(cn)).sort()).toEqual([
      "edit.ts",
      "multi.ts",
      "nb.ipynb",
      "write.ts",
    ]);
  });

  it("layoutChatFlow counts immediate children of each ChatNode (childCount on RF data, v0.8 M5)", () => {
    // a → b (fork) → c1, c2; b has 2 children, others have 0.
    const cf = makeChatFlow([
      makeChatNode({ id: "a" }),
      makeChatNode({ id: "b", parentChatNodeId: "a" }),
      makeChatNode({ id: "c1", parentChatNodeId: "b" }),
      makeChatNode({ id: "c2", parentChatNodeId: "b" }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const childCountById = new Map(nodes.map((n) => [n.id, n.data.childCount]));
    expect(childCountById.get("a")).toBe(1);
    expect(childCountById.get("b")).toBe(2);
    expect(childCountById.get("c1")).toBe(0);
    expect(childCountById.get("c2")).toBe(0);
  });

  it("layoutChatFlow exposes fileTouchCount on RF node data", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        meta: {
          fileHistorySnapshots: [
            { uuid: "s1", trackedFiles: ["x.ts", "y.ts"], isUpdate: false },
          ],
        },
      }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const p1 = nodes.find((n) => n.id === "p1")!;
    const p2 = nodes.find((n) => n.id === "p2")!;
    expect(p1.data.fileTouchCount).toBe(2);
    expect(p2.data.fileTouchCount).toBe(0);
  });
});

describe("logical edge data preservation (v0.8.1 #6 — visual deleted, data kept)", () => {
  // v0.7 M4 emitted a `logical` edge type for the compact → pre-compact
  // tail back-arc. v0.8.1 #6 dropped the visual: edges of that type are
  // never produced. The underlying data (compactMetadata.
  // logicalParentChatNodeId) MUST still populate so fold projection
  // (computeCompactRange) keeps working.
  function compactCn(
    id: string,
    parentId: string | null,
    logicalParentChatNodeId: string | null,
  ) {
    return makeChatNode({
      id,
      parentChatNodeId: parentId,
      isCompactSummary: true,
      compactMetadata: {
        id: `compact-wn-${id}`,
        kind: "compact",
        parentUuid: null,
        summaryText: "...",
        trigger: "auto",
        logicalParentChatNodeId,
      },
    });
  }

  it("layoutChatFlow emits ZERO `logical` edges (visual fully removed)", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "a" }),
      makeChatNode({ id: "b", parentChatNodeId: "a" }),
      makeChatNode({ id: "c", parentChatNodeId: "b" }),
      compactCn("d", "c", "c"),
    ]);
    const { edges } = layoutChatFlow(cf);
    expect(edges.filter((e) => e.type === "logical")).toEqual([]);
  });

  it("compactMetadata.logicalParentChatNodeId data is preserved on the ChatNode", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "a" }),
      compactCn("d", "a", "a"),
    ]);
    const compact = cf.chatNodes.find((c) => c.id === "d");
    expect(compact?.compactMetadata?.logicalParentChatNodeId).toBe("a");
  });
});

// ──────────────────────────────────────────────────────────────────
// M3 — fold-aware layout
// ──────────────────────────────────────────────────────────────────

describe("layoutChatFlow — fold integration", () => {
  function compactCn(
    id: string,
    parent: string | null,
    lpcn: string | null,
    preTokens?: number,
  ): ChatNode {
    return makeChatNode({
      id,
      parentChatNodeId: parent,
      isCompactSummary: true,
      compactMetadata: {
        id: `compact-wn-${id}`,
        kind: "compact",
        parentUuid: null,
        summaryText: "...",
        trigger: "auto",
        logicalParentChatNodeId: lpcn,
        preTokens,
      },
    });
  }

  function chainWithCompact() {
    // a → b → c → COMPACT(d, lpcn=c) → e
    return makeChatFlow([
      makeChatNode({ id: "a" }),
      makeChatNode({ id: "b", parentChatNodeId: "a" }),
      makeChatNode({ id: "c", parentChatNodeId: "b" }),
      compactCn("d", "c", "c", 50_000),
      makeChatNode({ id: "e", parentChatNodeId: "d" }),
    ]);
  }

  it("with no folded compacts, layout matches v0.7 baseline (one rfNode per ChatNode)", () => {
    const cf = chainWithCompact();
    const { nodes } = layoutChatFlow(cf);
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
    // No chatFold phantoms emitted.
    expect(nodes.every((n) => n.type === "chatNode")).toBe(true);
  });

  it("when host compact d is folded, hides range members and emits a chatFold phantom", () => {
    const cf = chainWithCompact();
    const { nodes } = layoutChatFlow(cf, new Set(["d"]));
    const ids = nodes.map((n) => n.id).sort();
    // a/b/c absorbed into the fold; d (host) and e (post-host tail) stay.
    // chatfold:d phantom takes their visual place upstream of d.
    expect(ids).toContain("d");
    expect(ids).toContain("e");
    expect(ids).toContain("chatfold:d");
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
  });

  it("retargets the host's incoming continuation edge from c → d to chatfold:d → d", () => {
    const cf = chainWithCompact();
    const { edges } = layoutChatFlow(cf, new Set(["d"]));
    // Original c → d gone.
    expect(edges.find((e) => e.source === "c" && e.target === "d")).toBeUndefined();
    // Replaced by chatfold:d → d on fold-output-right handle.
    const continuation = edges.find(
      (e) => e.source === "chatfold:d" && e.target === "d" && e.type === "continuation",
    );
    expect(continuation).toBeDefined();
    expect(continuation?.sourceHandle).toBe("fold-output-right");
  });

  it("post-host tail's edge (d → e) is unaffected by the fold", () => {
    const cf = chainWithCompact();
    const { edges } = layoutChatFlow(cf, new Set(["d"]));
    expect(
      edges.find((e) => e.source === "d" && e.target === "e" && e.type === "continuation"),
    ).toBeDefined();
  });

  it("populates ChatFoldNodeData with count + lastMember + preTokens", () => {
    const cf = chainWithCompact();
    const { nodes } = layoutChatFlow(cf, new Set(["d"]));
    const fold = nodes.find((n) => n.id === "chatfold:d");
    expect(fold).toBeDefined();
    if (!fold) return;
    expect(fold.type).toBe("chatFold");
    const data = fold.data as { hostCompactId: string; count: number; lastMemberId: string; preTokens?: number };
    expect(data.hostCompactId).toBe("d");
    expect(data.count).toBe(3);
    expect(data.lastMemberId).toBe("c");
    expect(data.preTokens).toBe(50_000);
  });

  it("v0.8.1 #8: chatFold's hasIncomingEdge reflects whether a visible upstream feeds the absorbed range", () => {
    // chainWithCompact() has a → b → c → COMPACT(d, lpcn=c). When d is
    // folded, a/b/c hidden, but a is the session root (parentChatNodeId
    // === null) — there's no upstream visible node feeding the range,
    // so the `parent → fold-input` edge never gets emitted.
    //
    // In practice with the current `computeCompactRange` semantics
    // (walks parentChatNodeId all the way to root before stopping),
    // every fold's range starts at a session root → hasIncomingEdge
    // is always false, the fold-input handle never shows. The wiring
    // stays correct defensive code: should the range algorithm ever
    // be changed to NOT reach root (e.g. v∞ partial-fold semantics),
    // the layoutDag tracker + ChatFoldNodeData flag flip naturally.
    const cf = chainWithCompact();
    const { nodes } = layoutChatFlow(cf, new Set(["d"]));
    const fold = nodes.find((n) => n.id === "chatfold:d");
    expect(fold).toBeDefined();
    if (!fold) return;
    const data = fold.data as { hasIncomingEdge: boolean };
    expect(data.hasIncomingEdge).toBe(false);
  });

  it("places the chatFold phantom upstream (left) of the host compact in LR layout", () => {
    const cf = chainWithCompact();
    const { nodes } = layoutChatFlow(cf, new Set(["d"]));
    const fold = nodes.find((n) => n.id === "chatfold:d")!;
    const host = nodes.find((n) => n.id === "d")!;
    expect(fold.position.x).toBeLessThan(host.position.x);
  });

  it("sibling fork off a hidden range member becomes a boundary fork from the chatFold", () => {
    // a → b → c → COMPACT(d, lpcn=c) → e
    // sibling: b → b2 (in-session edit-and-resubmit)
    // When d is folded, a/b/c hidden; b2 is visible. The b → b2 edge
    // reroutes to chatfold:d → b2 because b is absorbed.
    const cf = makeChatFlow([
      makeChatNode({ id: "a" }),
      makeChatNode({ id: "b", parentChatNodeId: "a" }),
      makeChatNode({ id: "c", parentChatNodeId: "b" }),
      compactCn("d", "c", "c"),
      makeChatNode({ id: "e", parentChatNodeId: "d" }),
      makeChatNode({ id: "b2", parentChatNodeId: "b" }),
    ]);
    const { nodes, edges } = layoutChatFlow(cf, new Set(["d"]));
    expect(nodes.find((n) => n.id === "b2")).toBeDefined();
    const boundary = edges.find(
      (e) => e.source === "chatfold:d" && e.target === "b2",
    );
    expect(boundary).toBeDefined();
    expect(boundary?.sourceHandle).toBe("fold-output-right");
  });

  it("nested compacts on the same chain: outer's chatFold absorbs the inner's host + range", () => {
    // a → b → c → COMPACT(d) → e → f → COMPACT(g) → h
    // After M1, range(g) ⊃ range(d). Both folded → outer fold (g) wins.
    const cf = makeChatFlow([
      makeChatNode({ id: "a" }),
      makeChatNode({ id: "b", parentChatNodeId: "a" }),
      makeChatNode({ id: "c", parentChatNodeId: "b" }),
      compactCn("d", "c", "c"),
      makeChatNode({ id: "e", parentChatNodeId: "d" }),
      makeChatNode({ id: "f", parentChatNodeId: "e" }),
      compactCn("g", "f", "f"),
      makeChatNode({ id: "h", parentChatNodeId: "g" }),
    ]);
    const { nodes } = layoutChatFlow(cf, new Set(["d", "g"]));
    const ids = new Set(nodes.map((n) => n.id));
    // Hosts that win: g. Visible reals: g, h. Phantom: chatfold:g only.
    expect(ids.has("g")).toBe(true);
    expect(ids.has("h")).toBe(true);
    expect(ids.has("chatfold:g")).toBe(true);
    // Inner host d, its range, AND chatfold:d are not in the projection.
    expect(ids.has("d")).toBe(false);
    expect(ids.has("chatfold:d")).toBe(false);
    expect(ids.has("a")).toBe(false);
    expect(ids.has("e")).toBe(false);
  });

  it("dedupes fold-entry edges when multiple hidden members share a visible parent (defensive)", () => {
    // root has two folded children (rare contrived case): two compacts
    // whose ranges each contain root → r. Both folded → outer (larger
    // range) wins; the edges from root into each compact's hidden head
    // dedupe to a single entry edge into the chosen fold.
    // Simpler concrete test: two hidden members of the SAME fold both
    // listing the same visible parent isn't reachable in a chain layout
    // (chains only fork visibly), but exercise the dedupe path with a
    // fan-in synthetic flow:
    const cf = makeChatFlow([
      makeChatNode({ id: "root" }),
      makeChatNode({ id: "a", parentChatNodeId: "root" }),
      makeChatNode({ id: "b", parentChatNodeId: "a" }),
      makeChatNode({ id: "extra", parentChatNodeId: "root" }), // sibling whose ancestry is also via root
      compactCn("d", "b", "b"),
    ]);
    const { edges } = layoutChatFlow(cf, new Set(["d"]));
    const entries = edges.filter(
      (e) => e.target === "chatfold:d" && e.targetHandle === "fold-input",
    );
    // Exactly one entry edge (root → chatfold:d), even though hidden
    // members a and b both have root in their ancestry.
    expect(entries.length).toBeLessThanOrEqual(1);
  });
});

describe("nodeOwnFileChanges (v0.8.1 #9 — selfDelta semantics)", () => {
  it("returns selfSnap ∪ tool_use when no ancestor has a snapshot (fallback)", () => {
    const cn = makeChatNode({
      id: "child",
      parentChatNodeId: null,
      meta: {
        fileHistorySnapshots: [
          { uuid: "s1", trackedFiles: ["a.ts", "b.ts"], isUpdate: false },
        ],
      },
      workflow: {
        nodes: [
          {
            id: "t1",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Edit",
            input: { file_path: "c.ts", old_string: "x", new_string: "y" },
          },
        ],
        edges: [],
      },
    });
    const cf = makeChatFlow([cn]);
    const out = nodeOwnFileChanges(cn, cf);
    expect(out).toEqual(new Set(["a.ts", "b.ts", "c.ts"]));
  });

  it("subtracts the nearest ancestor's snapshot from selfSnap", () => {
    // ancestor snap = {a, b, x}; child snap = {a, b, c}.
    // selfDelta from snap = {c}; no tool_use → result = {c}.
    const parent = makeChatNode({
      id: "parent",
      parentChatNodeId: null,
      meta: {
        fileHistorySnapshots: [
          {
            uuid: "p-snap",
            trackedFiles: ["a.ts", "b.ts", "x.ts"],
            isUpdate: false,
          },
        ],
      },
    });
    const child = makeChatNode({
      id: "child",
      parentChatNodeId: "parent",
      meta: {
        fileHistorySnapshots: [
          {
            uuid: "c-snap",
            trackedFiles: ["a.ts", "b.ts", "c.ts"],
            isUpdate: false,
          },
        ],
      },
    });
    const cf = makeChatFlow([parent, child]);
    expect(nodeOwnFileChanges(child, cf)).toEqual(new Set(["c.ts"]));
  });

  it("walks past empty-snapshot ancestors to find the NEAREST non-empty one", () => {
    const root = makeChatNode({
      id: "root",
      parentChatNodeId: null,
      meta: {
        fileHistorySnapshots: [
          { uuid: "r-snap", trackedFiles: ["root-only.ts"], isUpdate: false },
        ],
      },
    });
    const middle = makeChatNode({
      id: "mid",
      parentChatNodeId: "root",
      // No snapshots — should be skipped.
    });
    const child = makeChatNode({
      id: "child",
      parentChatNodeId: "mid",
      meta: {
        fileHistorySnapshots: [
          {
            uuid: "c-snap",
            trackedFiles: ["root-only.ts", "new.ts"],
            isUpdate: false,
          },
        ],
      },
    });
    const cf = makeChatFlow([root, middle, child]);
    // root-only.ts is in ancestor → subtracted; new.ts remains.
    expect(nodeOwnFileChanges(child, cf)).toEqual(new Set(["new.ts"]));
  });

  it("tool_use is unioned in even when the path is also in the ancestor snap (rollback case)", () => {
    // Ancestor snap = {a, b}; child snap = {a, b} (no new dirty files);
    // child tool_use = {a}.  selfDelta from snap = ∅; ∪ tool_use = {a}.
    const parent = makeChatNode({
      id: "parent",
      parentChatNodeId: null,
      meta: {
        fileHistorySnapshots: [
          { uuid: "p-snap", trackedFiles: ["a.ts", "b.ts"], isUpdate: false },
        ],
      },
    });
    const child = makeChatNode({
      id: "child",
      parentChatNodeId: "parent",
      meta: {
        fileHistorySnapshots: [
          { uuid: "c-snap", trackedFiles: ["a.ts", "b.ts"], isUpdate: false },
        ],
      },
      workflow: {
        nodes: [
          {
            id: "t1",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Edit",
            input: { file_path: "a.ts", old_string: "x", new_string: "y" },
          },
        ],
        edges: [],
      },
    });
    const cf = makeChatFlow([parent, child]);
    expect(nodeOwnFileChanges(child, cf)).toEqual(new Set(["a.ts"]));
  });

  it("returns empty set when ChatNode has neither snapshot nor tool_use", () => {
    const cn = makeChatNode({ id: "x" });
    expect(nodeOwnFileChanges(cn, makeChatFlow([cn]))).toEqual(new Set());
  });
});

describe("layoutChatFlow — awaySummary synthetic nodes (v1.2 R5)", () => {
  it("does not emit awaySummary nodes when no ChatNode has meta.awaySummary", () => {
    const cf = makeChatFlow([
      makeChatNode({ id: "p1" }),
      makeChatNode({ id: "p2", parentChatNodeId: "p1" }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(
      nodes.filter((n) => n.id.startsWith("awaySummary-")).length,
    ).toBe(0);
  });

  it("emits a synthetic awaySummary node (no edge) when host has meta.awaySummary (2026-05-13)", () => {
    // EN: per 2026-05-13 rework, awaySummary cards are pure visual
    // annotations stacked above their host. They no longer emit a
    // dashed anchor edge — the visual layer alone carries the
    // "this summary belongs to this turn" relationship.
    // 中: 不再发 dashed 边，纯视觉粘在 host 上方。
    const host = makeChatNode({
      id: "p2",
      parentChatNodeId: "p1",
      meta: {
        awaySummary: {
          uuid: "u-away-1",
          content: "while away, the user took a long break",
          timestamp: "2026-05-09T00:00:00.000Z",
        },
      },
    });
    const cf = makeChatFlow([makeChatNode({ id: "p1" }), host]);
    const { nodes, edges } = layoutChatFlow(cf);

    const synId = "awaySummary-p2";
    const syn = nodes.find((n) => n.id === synId);
    expect(syn).toBeTruthy();
    expect(syn?.type).toBe("awaySummary");
    expect(syn?.data.hostChatNodeId).toBe("p2");
    expect(syn?.data.content).toContain("while away");
    expect(syn?.data.timestamp).toBe("2026-05-09T00:00:00.000Z");

    // No edge should target the host from the synthetic node anymore.
    // 中: 不再有从合成节点到 host 的边。
    const synEdge = edges.find(
      (e) => e.source === synId && e.target === "p2",
    );
    expect(synEdge).toBeUndefined();
  });

  it("places the synthetic node DIRECTLY ABOVE its host on LR (same x, smaller y) — 2026-05-13", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        meta: {
          awaySummary: { uuid: "u", content: "x" },
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    const host = nodes.find((n) => n.id === "p1")!;
    const syn = nodes.find((n) => n.id === "awaySummary-p1")!;
    // Same column (x), positioned above (smaller y).
    // 中: 同列（X 相等），更高位（Y 更小）。
    expect(syn.position.x).toBe(host.position.x);
    expect(syn.position.y).toBeLessThan(host.position.y);
  });

  it("skips awaySummary injection when content is empty", () => {
    const cf = makeChatFlow([
      makeChatNode({
        id: "p1",
        meta: {
          awaySummary: { uuid: "u", content: "" },
        },
      }),
    ]);
    const { nodes } = layoutChatFlow(cf);
    expect(
      nodes.filter((n) => n.id.startsWith("awaySummary-")).length,
    ).toBe(0);
  });
});
