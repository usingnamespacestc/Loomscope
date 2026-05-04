// M2 — fold projection algorithm. Five behaviours under test:
//
//   1. Empty foldedCompactIds → empty projection (short-circuit).
//   2. Single-fold case: range members hidden, host stays visible,
//      lastMember points at the chain tail.
//   3. Nested compacts: largest-first attribution. Outer fold absorbs
//      the inner compact + its range. The inner compact gets ZERO
//      claimed members (orphan filter drops it from activeFoldHostIds
//      while it's still in foldedCompactIds — when user unfolds outer,
//      inner appears fresh on next projection invocation).
//   4. Sibling branches off the main chain are NOT absorbed by a
//      main-chain compact's fold. They remain visible.
//   5. Defensive guards: missing range / dangling logical parent /
//      self-referencing compactMetadata don't crash.

import { describe, expect, it } from "vitest";

import {
  CHAT_FOLD_PREFIX,
  chatFoldIdFor,
  compactIdFromFoldId,
  computeFoldProjection,
  isChatFoldId,
} from "@/canvas/foldProjection";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "00000000-0000-4000-8000-0000000000aa";

function chatNode(
  id: string,
  parentId: string | null,
  isCompact = false,
  logicalParentChatNodeId?: string | null,
  preTokens?: number,
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
          preTokens,
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

// ────────────────────────────────────────────────────────────────────
// fold-id helpers
// ────────────────────────────────────────────────────────────────────

describe("chatFoldIdFor / isChatFoldId / compactIdFromFoldId", () => {
  it("round-trips a host compact id through the fold-id encoding", () => {
    const hostId = "abc-123";
    const foldId = chatFoldIdFor(hostId);
    expect(foldId).toBe(`${CHAT_FOLD_PREFIX}${hostId}`);
    expect(isChatFoldId(foldId)).toBe(true);
    expect(compactIdFromFoldId(foldId)).toBe(hostId);
  });

  it("rejects non-prefixed ids", () => {
    expect(isChatFoldId("just-a-uuid")).toBe(false);
    expect(isChatFoldId(`${CHAT_FOLD_PREFIX}x`)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// computeFoldProjection
// ────────────────────────────────────────────────────────────────────

describe("computeFoldProjection — short-circuit", () => {
  it("returns an empty projection when foldedCompactIds is empty", () => {
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b", true, "b"),
    ]);
    const proj = computeFoldProjection(cf, new Set());
    expect(proj.hidden.size).toBe(0);
    expect(proj.foldByHidden.size).toBe(0);
    expect(proj.activeFoldHostIds.size).toBe(0);
  });
});

describe("computeFoldProjection — single fold", () => {
  function flow() {
    // a → b → c → COMPACT(d) → e
    return chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b"),
      chatNode("d", "c", true, "c", 50_000),
      chatNode("e", "d"),
    ]);
  }

  it("hides every range member, host stays visible", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    expect(proj.hidden).toEqual(new Set(["a", "b", "c"]));
    // The host compact 'd' is NOT in hidden — only the range is.
    expect(proj.hidden.has("d")).toBe(false);
    // Sibling 'e' is not on the host's range walk.
    expect(proj.hidden.has("e")).toBe(false);
  });

  it("attributes every hidden member to its host fold", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    for (const id of ["a", "b", "c"]) {
      expect(proj.foldByHidden.get(id)).toBe("d");
    }
  });

  it("count + lastMember reflect the chain tail (= range[-1])", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    expect(proj.countByFold.get("d")).toBe(3);
    expect(proj.lastMemberByFold.get("d")).toBe("c");
  });

  it("surfaces preTokens from compactMetadata when known", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    expect(proj.preTokensByFold.get("d")).toBe(50_000);
  });

  it("activeFoldHostIds includes the host", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    expect(proj.activeFoldHostIds).toEqual(new Set(["d"]));
  });
});

describe("computeFoldProjection — nested compacts on the same chain", () => {
  // a → b → c → COMPACT(d, lpcn=c) → e → f → COMPACT(g, lpcn=f) → h
  // computeCompactRange (M1) walks to root, INCLUDING earlier compacts:
  //   range(d) = [a, b, c]
  //   range(g) = [a, b, c, d, e, f]    ⊃ range(d)
  // Largest-first attribution: 'g' wins everything; 'd' has zero claim
  // → orphan filter drops it from activeFoldHostIds.
  function flow() {
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

  it("outer fold (g) absorbs the inner compact d + its range members", () => {
    const proj = computeFoldProjection(flow(), new Set(["d", "g"]));
    expect(proj.hidden).toEqual(new Set(["a", "b", "c", "d", "e", "f"]));
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      expect(proj.foldByHidden.get(id)).toBe("g");
    }
  });

  it("inner compact d gets zero claimed members (orphan filter drops it from activeFoldHostIds)", () => {
    const proj = computeFoldProjection(flow(), new Set(["d", "g"]));
    expect(proj.activeFoldHostIds).toEqual(new Set(["g"]));
    expect(proj.countByFold.has("d")).toBe(false);
    expect(proj.lastMemberByFold.has("d")).toBe(false);
  });

  it("when user unfolds the OUTER (g), the next projection makes inner (d) the host", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    expect(proj.hidden).toEqual(new Set(["a", "b", "c"]));
    expect(proj.activeFoldHostIds).toEqual(new Set(["d"]));
    expect(proj.countByFold.get("d")).toBe(3);
    expect(proj.lastMemberByFold.get("d")).toBe("c");
  });

  it("host compact (g) and the post-host tail (h) are never hidden", () => {
    const proj = computeFoldProjection(flow(), new Set(["d", "g"]));
    expect(proj.hidden.has("g")).toBe(false);
    expect(proj.hidden.has("h")).toBe(false);
  });

  it("count = (range size) − (members lost to other folds). For strict-containment chains, outer count = range size", () => {
    const proj = computeFoldProjection(flow(), new Set(["d", "g"]));
    expect(proj.countByFold.get("g")).toBe(6);
  });
});

describe("computeFoldProjection — sibling branches off the main chain", () => {
  // Main chain: a → b → c → COMPACT(d, lpcn=c) → e
  // Sibling fork from b: b → b2 → b3 (in-session edit-and-resubmit)
  // d's range walks parentChatNodeId from c back to root: [a, b, c].
  // The sibling chain b → b2 → b3 is NOT on that walk and stays visible.
  function flow() {
    return chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b"),
      chatNode("d", "c", true, "c"),
      chatNode("e", "d"),
      chatNode("b2", "b"), // sibling of c
      chatNode("b3", "b2"),
    ]);
  }

  it("hides the main-chain range only — sibling branch stays visible", () => {
    const proj = computeFoldProjection(flow(), new Set(["d"]));
    expect(proj.hidden).toEqual(new Set(["a", "b", "c"]));
    expect(proj.hidden.has("b2")).toBe(false);
    expect(proj.hidden.has("b3")).toBe(false);
  });
});

describe("computeFoldProjection — stress / scale", () => {
  // Build a 1500-ChatNode chain with 131 compacts at regular intervals.
  // This mirrors the author's 256MB session shape (commit message in
  // v0.6/v0.7 ship notes). Asserts:
  //   - largest-first attribution collapses 131 nested folds into ONE
  //     active host (the rightmost compact)
  //   - exactly one chatFold phantom would render
  //   - hidden count = total chain length minus the outermost compact
  //     and its post-host tail
  // Also exercises the inner loops at scale to surface accidental
  // O(N²) regressions; on a typical dev box this completes in <100ms.
  it("collapses 131 nested compacts into a single active fold host", () => {
    const N = 1500;
    const everyK = Math.floor(N / 131); // ~11 turns between compacts
    const nodes: ChatNode[] = [];
    let lastId: string | null = null;
    let compactCount = 0;
    const compactIds: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const id = `n${i}`;
      const isCompact = i > 0 && compactCount < 131 && i % everyK === 0;
      if (isCompact) {
        compactIds.push(id);
        compactCount += 1;
      }
      nodes.push(
        chatNode(
          id,
          lastId,
          isCompact,
          isCompact ? lastId : undefined,
        ),
      );
      lastId = id;
    }
    expect(compactIds.length).toBe(131);

    const cf = chatFlow(nodes);
    const proj = computeFoldProjection(cf, new Set(compactIds));

    // Outer = last compact wins. Earlier compacts' claims get absorbed.
    expect(proj.activeFoldHostIds.size).toBe(1);
    const winner = [...proj.activeFoldHostIds][0];
    expect(winner).toBe(compactIds[compactIds.length - 1]);

    // Hidden = everything from root up to (but not including) winner.
    const winnerIdx = nodes.findIndex((n) => n.id === winner);
    expect(proj.hidden.size).toBe(winnerIdx); // 0..winnerIdx-1 all hidden

    // Post-host tail (nodes after winner) stays visible.
    for (let i = winnerIdx + 1; i < N; i += 1) {
      expect(proj.hidden.has(`n${i}`)).toBe(false);
    }
  });

  it("256MB-shape scale: projection completes well under 100ms (regression guard)", () => {
    const N = 1500;
    const everyK = Math.floor(N / 131);
    const nodes: ChatNode[] = [];
    let lastId: string | null = null;
    const compactIds: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const id = `n${i}`;
      const isCompact =
        i > 0 && compactIds.length < 131 && i % everyK === 0;
      if (isCompact) compactIds.push(id);
      nodes.push(
        chatNode(id, lastId, isCompact, isCompact ? lastId : undefined),
      );
      lastId = id;
    }
    const cf = chatFlow(nodes);
    const t0 = performance.now();
    computeFoldProjection(cf, new Set(compactIds));
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(100);
  });
});

describe("computeFoldProjection — defensive guards", () => {
  it("ignores folded compacts whose range is empty (missing logicalParentChatNodeId)", () => {
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("d", "a", true, null), // no lpcn
    ]);
    const proj = computeFoldProjection(cf, new Set(["d"]));
    expect(proj.hidden.size).toBe(0);
    expect(proj.activeFoldHostIds.size).toBe(0);
  });

  it("ignores folded compacts whose lpcn is dangling", () => {
    const cf = chatFlow([chatNode("d", null, true, "ghost-id")]);
    const proj = computeFoldProjection(cf, new Set(["d"]));
    expect(proj.hidden.size).toBe(0);
  });

  it("does not absorb the host into its own fold (defensive against self-loop lpcn)", () => {
    // Pathological JSONL: lpcn === host's own id. Walk would loop.
    // computeCompactRange caps at 5000 hops; computeFoldProjection
    // additionally skips cn.id === hostId so even if the loop walks
    // through the host's id, we don't add it to ``hidden``.
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("d", "a", true, "d"),
    ]);
    const proj = computeFoldProjection(cf, new Set(["d"]));
    expect(proj.hidden.has("d")).toBe(false);
  });

  it("ties between same-size ranges resolve deterministically by host id", () => {
    // Two parallel disjoint chains, each with its own compact.
    // Range sizes are equal (1 each). Tiebreaker: host id ascending.
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("d1", "a", true, "a"),
      chatNode("b", null),
      chatNode("d2", "b", true, "b"),
    ]);
    const proj = computeFoldProjection(cf, new Set(["d2", "d1"]));
    // Both hosts should be active (their ranges don't overlap).
    expect(proj.activeFoldHostIds).toEqual(new Set(["d1", "d2"]));
    // And the attribution is exactly to each respective host.
    expect(proj.foldByHidden.get("a")).toBe("d1");
    expect(proj.foldByHidden.get("b")).toBe("d2");
  });
});
