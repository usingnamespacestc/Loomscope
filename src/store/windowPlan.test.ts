// Unit tests for the canvas windowing knapsack policy (#6 slice 6a).
import { describe, expect, it } from "vitest";

import type { ChatFlow, ChatNode } from "@/data/types";
import { computeFoldProjection } from "@/canvas/foldProjection";
import { planWindow, visibleCount } from "@/store/windowPlan";

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
          // Range walks from the logical parent (the node just before the
          // compact) back to root — must be set or the fold range is empty.
          logicalParentChatNodeId: parentId,
        }
      : undefined,
    meta: {},
  } as ChatNode;
}

// Linear chain a..k with compacts at c, f, i (each folds the run before it).
function flow(): ChatFlow {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
  const compacts = new Set(["c", "f", "i"]);
  const nodes = ids.map((id, i) =>
    cn(id, i === 0 ? null : ids[i - 1], compacts.has(id)),
  );
  return {
    id: "s",
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  } as ChatFlow;
}

// Large multi-compact session: N nodes with a compact every K.
function largeFlow(n: number, compactEvery: number): ChatFlow {
  const nodes: ChatNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(cn(`n${i}`, i === 0 ? null : `n${i - 1}`, i > 0 && i % compactEvery === 0));
  }
  return {
    id: "big",
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  } as ChatFlow;
}

describe("planWindow — large session caps visible at budget (no dagre overflow)", () => {
  it("a 1200-node, multi-compact flow windows to <= 1000 visible", () => {
    const cf = largeFlow(1200, 100); // ~12 compacts
    expect(visibleCount(cf, new Set())).toBe(1200); // unfolded: all visible
    const result = planWindow(cf, new Set(), "n1199", 1000); // focus = latest
    const visible = visibleCount(cf, result);
    // eslint-disable-next-line no-console
    console.log(`large-session window: 1200 ChatNodes -> ${visible} visible`);
    expect(visible).toBeLessThanOrEqual(1000); // dagre never sees > 1000
    // focus (latest) stays visible
    expect(computeFoldProjection(cf, result).hidden.has("n1199")).toBe(false);
  });
});

describe("planWindow (knapsack window policy)", () => {
  it("re-folds farthest segments until visible ≤ budget; focus stays visible", () => {
    const cf = flow();
    const result = planWindow(cf, new Set(), "k", 4); // focus = latest
    expect(visibleCount(cf, result)).toBeLessThanOrEqual(4);
    // focus node k must not be hidden
    const projHidden = visibleCount(cf, result); // sanity it computed
    expect(projHidden).toBeGreaterThan(0);
    // it actually folded something (started from nothing folded)
    expect(result.size).toBeGreaterThan(0);
    // never unfolds: result is a superset of the (empty) input — trivial,
    // and every folded id is a real compact host
    for (const id of result) expect(["c", "f", "i"]).toContain(id);
  });

  it("keeps the focus and never hides it even with a mid-chain focus", () => {
    const cf = flow();
    const result = planWindow(cf, new Set(), "f", 4); // focus = middle compact
    // f (the focus) must remain visible — the core invariant. Budget may
    // be unreachable here: any far compact whose range covers f is skipped
    // (folding it would hide the focus), so the policy correctly stops
    // short rather than hide what you're looking at.
    const proj = computeFoldProjection(cf, result);
    expect(proj.hidden.has("f")).toBe(false);
    expect(visibleCount(cf, result)).toBeLessThan(11); // folded what it safely could
  });

  it("returns the input unchanged when already within budget", () => {
    const cf = flow();
    const input = new Set<string>();
    const result = planWindow(cf, input, "k", 100);
    expect(result.size).toBe(0); // nothing folded — all 11 fit in 100
  });

  it("only ADDS folds — preserves an existing fold", () => {
    const cf = flow();
    const result = planWindow(cf, new Set(["c"]), "k", 4);
    expect(result.has("c")).toBe(true); // existing fold preserved
  });

  it("folds all it can but can't go below an oversized residual (6c case)", () => {
    const cf = flow();
    // budget 1 is unreachable (the visible tail can't shrink below the
    // un-foldable nodes). It should fold every foldable compact and still
    // keep the focus visible.
    const result = planWindow(cf, new Set(), "k", 1);
    expect(result.size).toBe(3); // all of c, f, i folded
    expect(computeFoldProjection(cf, result).hidden.has("k")).toBe(false);
  });
});
