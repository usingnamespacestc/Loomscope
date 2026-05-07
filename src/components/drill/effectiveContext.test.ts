import { describe, expect, it } from "vitest";

import { buildEffectiveContext } from "@/components/drill/effectiveContext";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "00000000-0000-4000-8000-0000000000ee";

function chatNode(
  id: string,
  parentId: string | null,
  opts: {
    isCompactSummary?: boolean;
    hasInnerCompact?: boolean;
    summaryText?: string;
  } = {},
): ChatNode {
  const isCompact = opts.isCompactSummary ?? false;
  const hasInner = opts.hasInnerCompact ?? false;
  return {
    kind: "chat",
    id,
    parentChatNodeId: parentId,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: `prompt-${id}`, attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: isCompact,
    hasInnerCompact: hasInner || undefined,
    compactMetadata:
      isCompact || hasInner
        ? {
            id: `compact-wn-${id}`,
            kind: "compact",
            parentUuid: null,
            summaryText: opts.summaryText ?? `summary-of-${id}`,
            trigger: "auto",
            logicalParentChatNodeId: hasInner ? id : null,
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

describe("buildEffectiveContext", () => {
  it("returns empty when target id not found", () => {
    const cf = chatFlow([chatNode("a", null)]);
    expect(buildEffectiveContext(cf, "missing")).toEqual([]);
  });

  it("no compact in chain → all ancestors + current_turn, in chain order", () => {
    // a → b → c → target
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b"),
      chatNode("target", "c"),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["ancestor", "a"],
      ["ancestor", "b"],
      ["ancestor", "c"],
      ["current_turn", "target"],
    ]);
  });

  it("single compact in chain → summary + ancestors after cutoff + current_turn", () => {
    // a → b(compact) → c → target
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a", { isCompactSummary: true, summaryText: "B-summary" }),
      chatNode("c", "b"),
      chatNode("target", "c"),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => s.kind)).toEqual([
      "compact_summary",
      "ancestor",
      "current_turn",
    ]);
    expect(segs[0].sourceChatNodeId).toBe("b");
    expect(segs[0].summaryText).toBe("B-summary");
    expect(segs[1].sourceChatNodeId).toBe("c");
    expect(segs[2].sourceChatNodeId).toBe("target");
  });

  it("multiple compacts in chain → cutoff is the LATEST", () => {
    // a → b(compact) → c → d(compact) → e → target
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a", { isCompactSummary: true, summaryText: "B-summary" }),
      chatNode("c", "b"),
      chatNode("d", "c", { isCompactSummary: true, summaryText: "D-summary" }),
      chatNode("e", "d"),
      chatNode("target", "e"),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["compact_summary", "d"],
      ["ancestor", "e"],
      ["current_turn", "target"],
    ]);
    expect(segs[0].summaryText).toBe("D-summary");
  });

  it("hybrid in chain → summary + hybrid's own ancestor + post-cutoff ancestors", () => {
    // a → b → h(hybrid) → c → target
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("h", "b", {
        hasInnerCompact: true,
        summaryText: "H-inner-summary",
      }),
      chatNode("c", "h"),
      chatNode("target", "c"),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["compact_summary", "h"],
      ["ancestor", "h"], // hybrid's own user/assistant pair (post-compact tail)
      ["ancestor", "c"],
      ["current_turn", "target"],
    ]);
    expect(segs[0].summaryText).toBe("H-inner-summary");
    expect(segs[0].isHybridAncestor).toBe(true);
    expect(segs[1].isHybridAncestor).toBe(true);
  });

  it("pure compact AFTER hybrid wins as cutoff (latest rule)", () => {
    // a → h(hybrid) → b → c(compact) → d → target
    // c is later than h → c wins, h is dropped from rendering
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("h", "a", { hasInnerCompact: true, summaryText: "H-summary" }),
      chatNode("b", "h"),
      chatNode("c", "b", { isCompactSummary: true, summaryText: "C-summary" }),
      chatNode("d", "c"),
      chatNode("target", "d"),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["compact_summary", "c"],
      ["ancestor", "d"],
      ["current_turn", "target"],
    ]);
    expect(segs[0].summaryText).toBe("C-summary");
  });

  it("hybrid AFTER pure compact wins as cutoff (latest rule)", () => {
    // a → c(compact) → b → h(hybrid) → target
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("c", "a", { isCompactSummary: true, summaryText: "C-summary" }),
      chatNode("b", "c"),
      chatNode("h", "b", { hasInnerCompact: true, summaryText: "H-summary" }),
      chatNode("target", "h"),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["compact_summary", "h"],
      ["ancestor", "h"],
      ["current_turn", "target"],
    ]);
  });

  it("target is pure compact → single compact_summary_only segment", () => {
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("compact-target", "b", {
        isCompactSummary: true,
        summaryText: "compacted-content",
      }),
    ]);
    const segs = buildEffectiveContext(cf, "compact-target");
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("compact_summary_only");
    expect(segs[0].sourceChatNodeId).toBe("compact-target");
    expect(segs[0].summaryText).toBe("compacted-content");
  });

  it("target is hybrid → walks chain normally, target's inner compact does NOT cut its own context", () => {
    // a → b → target(hybrid)
    // The inline compact happens AFTER target receives context, so
    // target's effective inbound = a + b normally + current_turn(target).
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("target", "b", {
        hasInnerCompact: true,
        summaryText: "target-inner-summary",
      }),
    ]);
    const segs = buildEffectiveContext(cf, "target");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["ancestor", "a"],
      ["ancestor", "b"],
      ["current_turn", "target"],
    ]);
  });

  it("root target with empty chain → only current_turn", () => {
    const cf = chatFlow([chatNode("root", null)]);
    const segs = buildEffectiveContext(cf, "root");
    expect(segs.map((s) => [s.kind, s.sourceChatNodeId])).toEqual([
      ["current_turn", "root"],
    ]);
  });

  it("missing parent in chain doesn't loop forever", () => {
    // target's parent points at a node that isn't in the chatFlow
    // (defensive — shouldn't occur from a well-formed parser, but
    // hand-crafted fixtures or partial loads could trip it).
    const cf = chatFlow([chatNode("target", "ghost")]);
    const segs = buildEffectiveContext(cf, "target");
    // Walk stops as soon as we miss; chain becomes empty.
    expect(segs).toEqual([
      { kind: "current_turn", sourceChatNodeId: "target", summaryText: "" },
    ]);
  });
});
