// EN (2026-05-17, #226): correctness gate for incrementalAppendLayout.
//
// The cheap path is only safe if its output is INDISTINGUISHABLE from
// a full dagre relayout for the cases it claims to handle. These tests
// assert byte-equality (positions + card data + edges) of
// incremental-vs-full for linear tail append (single + batch), and
// assert it bails to null (→ caller does full) for every structural
// deviation: fork, active fold, awaySummary appearance, compact node,
// removal, reorder, parent relink, first build, prev-with-phantoms.

import { describe, expect, it } from "vitest";

import {
  chatFlowLayoutSignature,
  incrementalAppendLayout,
  layoutChatFlow,
  type PrevLayout,
} from "@/canvas/layoutDag";
import type { ChatFlow, ChatNode } from "@/data/types";

function makeChatNode(overrides: Partial<ChatNode>): ChatNode {
  const id = overrides.id ?? "p-1";
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `${id}-u`,
    userMessage: { uuid: `${id}-u`, content: `msg ${id}`, attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
    ...overrides,
  } as ChatNode;
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
  } as ChatFlow;
}

function linearChain(n: number): ChatNode[] {
  const out: ChatNode[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      makeChatNode({ id: `c${i}`, parentChatNodeId: i === 0 ? null : `c${i - 1}` }),
    );
  }
  return out;
}

function asPrev(cf: ChatFlow, folded?: Set<string>): PrevLayout {
  return {
    sig: chatFlowLayoutSignature(cf, folded),
    result: layoutChatFlow(cf, folded),
    chatNodes: cf.chatNodes,
  };
}

describe("incrementalAppendLayout — byte-equal to full relayout", () => {
  it("single tail append (linear chain) matches full layout exactly", () => {
    const base = linearChain(8);
    const prevCf = makeChatFlow(base);
    const prev = asPrev(prevCf);

    const appendedNodes = [
      ...base,
      makeChatNode({ id: "c8", parentChatNodeId: "c7" }),
    ];
    const newCf = makeChatFlow(appendedNodes);

    const incr = incrementalAppendLayout(prev, newCf, undefined);
    expect(incr, "cheap path should fire for linear tail append").not.toBeNull();
    const full = layoutChatFlow(newCf, undefined);

    expect(incr!.nodes).toEqual(full.nodes);
    expect(incr!.edges).toEqual(full.edges);
  });

  it("batch tail append (3 new linear turns) matches full layout exactly", () => {
    const base = linearChain(20);
    const prev = asPrev(makeChatFlow(base));
    const newNodes = [
      ...base,
      makeChatNode({ id: "c20", parentChatNodeId: "c19" }),
      makeChatNode({ id: "c21", parentChatNodeId: "c20" }),
      makeChatNode({ id: "c22", parentChatNodeId: "c21" }),
    ];
    const newCf = makeChatFlow(newNodes);
    const incr = incrementalAppendLayout(prev, newCf, undefined);
    expect(incr).not.toBeNull();
    const full = layoutChatFlow(newCf, undefined);
    expect(incr!.nodes).toEqual(full.nodes);
    expect(incr!.edges).toEqual(full.edges);
  });

  it("existing-node content change + tail append: positions + edges still match full", () => {
    const base = linearChain(10);
    const prev = asPrev(makeChatFlow(base));
    // Content delta on an existing node (new object ref, same
    // structural fields) + a tail append in the SAME chatFlow.
    const mutated = base.map((cn, i) =>
      i === 4
        ? ({
            ...cn,
            workflow: {
              nodes: [],
              edges: [],
              summary: {
                assistantPreview: "x",
                assistantText: ["streamed reply"],
                hasInFlightWork: false,
                llmCount: 3,
                chainCount: 1,
                toolCount: 2,
                totalThinkingChars: 5,
                contextTokens: 1,
                maxContextTokens: 200000,
                inputTokens: 1,
                outputTokens: 1,
                durationMs: 1,
                toolUseFilePaths: [],
              },
            },
          } as ChatNode)
        : cn,
    );
    const newCf = makeChatFlow([
      ...mutated,
      makeChatNode({ id: "c10", parentChatNodeId: "c9" }),
    ]);
    const incr = incrementalAppendLayout(prev, newCf, undefined);
    expect(incr).not.toBeNull();
    const full = layoutChatFlow(newCf, undefined);
    expect(incr!.nodes).toEqual(full.nodes);
    expect(incr!.edges).toEqual(full.edges);
  });

  it("dagre keeps existing node positions stable across a tail append", () => {
    // The premise the cheap path relies on: appending a sink to the
    // rightmost leaf does NOT move any existing node in dagre LR.
    const base = linearChain(12);
    const full1 = layoutChatFlow(makeChatFlow(base), undefined);
    const full2 = layoutChatFlow(
      makeChatFlow([
        ...base,
        makeChatNode({ id: "c12", parentChatNodeId: "c11" }),
      ]),
      undefined,
    );
    const pos1 = new Map(full1.nodes.map((n) => [n.id, n.position]));
    for (const n of full2.nodes) {
      if (n.id === "c12") continue;
      expect(n.position, `position of ${n.id} must be stable`).toEqual(
        pos1.get(n.id),
      );
    }
  });
});

describe("incrementalAppendLayout — bails to null (caller does full)", () => {
  const base = linearChain(6);
  const prevCf = makeChatFlow(base);

  it("null when prev is null (first build)", () => {
    expect(
      incrementalAppendLayout(null, makeChatFlow(linearChain(7)), undefined),
    ).toBeNull();
  });

  it("null on fork (existing leaf gains a 2nd child)", () => {
    const prev = asPrev(prevCf);
    // c5 already child of c4; add ANOTHER child of c4 → fork.
    const forked = makeChatFlow([
      ...base,
      makeChatNode({ id: "c6", parentChatNodeId: "c4" }),
    ]);
    expect(incrementalAppendLayout(prev, forked, undefined)).toBeNull();
  });

  it("null when two appended nodes share a parent (fork in batch)", () => {
    const prev = asPrev(prevCf);
    const cf = makeChatFlow([
      ...base,
      makeChatNode({ id: "c6", parentChatNodeId: "c5" }),
      makeChatNode({ id: "c7", parentChatNodeId: "c5" }),
    ]);
    expect(incrementalAppendLayout(prev, cf, undefined)).toBeNull();
  });

  it("null when fold set is non-empty (prev has phantom nodes)", () => {
    const compactNodes = [
      makeChatNode({ id: "c0" }),
      makeChatNode({ id: "c1", parentChatNodeId: "c0" }),
      makeChatNode({
        id: "c2",
        parentChatNodeId: "c1",
        isCompactSummary: true,
        compactMetadata: { logicalParentChatNodeId: "c0", preTokens: 1000 },
      } as Partial<ChatNode>),
      makeChatNode({ id: "c3", parentChatNodeId: "c2" }),
    ];
    const cf = makeChatFlow(compactNodes);
    const folded = new Set(["c2"]);
    const prev = asPrev(cf, folded);
    const cf2 = makeChatFlow([
      ...compactNodes,
      makeChatNode({ id: "c4", parentChatNodeId: "c3" }),
    ]);
    expect(incrementalAppendLayout(prev, cf2, folded)).toBeNull();
  });

  it("null when appended node carries an awaySummary", () => {
    const prev = asPrev(prevCf);
    const cf = makeChatFlow([
      ...base,
      makeChatNode({
        id: "c6",
        parentChatNodeId: "c5",
        meta: { awaySummary: { uuid: "as", content: "recap" } },
      }),
    ]);
    expect(incrementalAppendLayout(prev, cf, undefined)).toBeNull();
  });

  it("null when appended node is a compact", () => {
    const prev = asPrev(prevCf);
    const cf = makeChatFlow([
      ...base,
      makeChatNode({
        id: "c6",
        parentChatNodeId: "c5",
        isCompactSummary: true,
        compactMetadata: { logicalParentChatNodeId: "c0", preTokens: 9 },
      } as Partial<ChatNode>),
    ]);
    expect(incrementalAppendLayout(prev, cf, undefined)).toBeNull();
  });

  it("null on removal (new graph shorter / existing line gone)", () => {
    const prev = asPrev(prevCf);
    const cf = makeChatFlow(base.slice(0, 4));
    expect(incrementalAppendLayout(prev, cf, undefined)).toBeNull();
  });

  it("null on existing-node parent relink (structural line changed)", () => {
    const prev = asPrev(prevCf);
    const relinked = base.map((cn) =>
      cn.id === "c3" ? makeChatNode({ id: "c3", parentChatNodeId: "c1" }) : cn,
    );
    const cf = makeChatFlow([
      ...relinked,
      makeChatNode({ id: "c6", parentChatNodeId: "c5" }),
    ]);
    expect(incrementalAppendLayout(prev, cf, undefined)).toBeNull();
  });

  it("null when prev result contains a non-chatNode phantom", () => {
    const prev: PrevLayout = {
      sig: chatFlowLayoutSignature(prevCf, undefined),
      result: {
        nodes: [
          {
            id: "chatfold-x",
            type: "chatFold",
            position: { x: 0, y: 0 },
            data: {} as never,
          } as never,
        ],
        edges: [],
      },
      chatNodes: base,
    };
    const cf = makeChatFlow([
      ...base,
      makeChatNode({ id: "c6", parentChatNodeId: "c5" }),
    ]);
    expect(incrementalAppendLayout(prev, cf, undefined)).toBeNull();
  });
});
