// M1 — compact-fold slice. Replaces v0.7 M3's `compact-original` drill
// mode with inline fold state. Three things under test:
//
//   1. ``computeCompactRange`` walks parentChatNodeId all the way to
//      ROOT, **including any earlier compact ChatNodes** on the chain.
//      The v0.7 behaviour (break at previous compact) was a UI choice;
//      semantically every compact distills the entire conversation that
//      was in context when CC ran auto-compact, so its range strictly
//      contains all earlier compacts on the same chain. Strict
//      containment is what makes M2's largest-range attribution
//      collapse a 131-deep nested sequence into a single visible
//      fold-host on first render.
//   2. ``hydrateFoldedCompactIds`` default-folds every compact in the
//      live flow on first session load (no localStorage entry); reads
//      and reconciles the persisted set on subsequent loads.
//   3. ``foldCompact`` / ``unfoldCompact`` / ``toggleCompactFold``
//      mutate the in-memory set AND persist to localStorage on every
//      change. Stale ids (no longer compact ChatNodes in the live flow)
//      are silently rejected so they don't pollute the persisted set.
//
// We do NOT test the canvas projection / edge reroute here — that's
// M2's responsibility. Likewise the chatFold rfNode + UX wiring is
// M2/M4 territory.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatFlow, ChatNode } from "@/data/types";
import { useStore } from "@/store/index";
import {
  computeCompactRange,
  hydrateFoldedCompactIds,
} from "@/store/sessionSlice";

const SID = "00000000-0000-4000-8000-0000000000aa";

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

function seed(cf: ChatFlow, foldedCompactIds: Set<string> = new Set()): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow: cf,
      foldedNodeIds: new Set(),
      foldedCompactIds,
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      workflowCache: new Map(),
      isLoading: false,
      error: null,
      lastUpdated: Date.now(),
    });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
  // happy-dom provides localStorage; clear between tests so persisted
  // sets from one test don't leak into another's hydrate path.
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
});

// ────────────────────────────────────────────────────────────────────
// computeCompactRange — walk to ROOT (incl. previous compacts)
// ────────────────────────────────────────────────────────────────────

describe("computeCompactRange", () => {
  // Chain: a → b → c → COMPACT(d, lpcn=c) → e → f → COMPACT(g, lpcn=f) → h
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
    expect(computeCompactRange(rangedFlow(), "d").map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does NOT break at a previous compact ChatNode — range INCLUDES it", () => {
    // compact_2's distillation includes everything CC's context window
    // held when auto-compact ran, which already had compact_1 at its
    // head plus the post-compact_1 turns. So compact_2's range strictly
    // contains compact_1 on the chain.
    expect(computeCompactRange(rangedFlow(), "g").map((c) => c.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("strict-containment invariant: range(later compact) ⊇ range(earlier compact)", () => {
    const cf = rangedFlow();
    const r1 = new Set(computeCompactRange(cf, "d").map((c) => c.id));
    const r2 = new Set(computeCompactRange(cf, "g").map((c) => c.id));
    for (const id of r1) {
      expect(r2.has(id)).toBe(true);
    }
    expect(r2.size).toBeGreaterThan(r1.size);
  });

  it("returns [] when the anchor isn't a compact ChatNode", () => {
    expect(computeCompactRange(rangedFlow(), "a")).toEqual([]);
  });

  it("returns [] when compactMetadata.logicalParentChatNodeId is missing", () => {
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("d", "a", true, null),
    ]);
    expect(computeCompactRange(cf, "d")).toEqual([]);
  });

  it("returns [] when the resolved logicalParentChatNodeId is dangling", () => {
    const cf = chatFlow([chatNode("d", null, true, "ghost-id")]);
    expect(computeCompactRange(cf, "d")).toEqual([]);
  });

  it("returns time-ascending order", () => {
    const cf = chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b"),
      chatNode("d", "c", true, "c"),
    ]);
    expect(computeCompactRange(cf, "d").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// hydrateFoldedCompactIds — default-fold + localStorage round-trip
// ────────────────────────────────────────────────────────────────────

describe("hydrateFoldedCompactIds", () => {
  function flowWithTwoCompacts() {
    return chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b", true, "b"), // compact 1
      chatNode("d", "c"),
      chatNode("e", "d", true, "d"), // compact 2
    ]);
  }

  it("defaults to ALL compact ids folded when no localStorage entry exists", () => {
    const set = hydrateFoldedCompactIds(SID, flowWithTwoCompacts());
    expect(set).toEqual(new Set(["c", "e"]));
  });

  it("returns an empty set when the flow has no compacts", () => {
    const cf = chatFlow([chatNode("a", null), chatNode("b", "a")]);
    expect(hydrateFoldedCompactIds(SID, cf)).toEqual(new Set());
  });

  it("subtracts the unfolded set from live compacts (storage = explicitly-unfolded ids)", () => {
    // v0.9.1 storage flip: localStorage now stores the EXPLICITLY-
    // UNFOLDED ids. With unfolded=['c'], expected folded = {e} since
    // {c, e} \ {c} = {e}. New compacts not in storage default-fold
    // for free, which is the whole point of the flip.
    localStorage.setItem(`loomscope:unfold:${SID}`, JSON.stringify(["c"]));
    expect(hydrateFoldedCompactIds(SID, flowWithTwoCompacts())).toEqual(
      new Set(["e"]),
    );
  });

  it("ignores stale unfolded ids that aren't in the live compact set", () => {
    // 'zzz' / 'a' aren't compacts; effectively the unfold set has
    // nothing applicable, so all live compacts default-fold.
    localStorage.setItem(
      `loomscope:unfold:${SID}`,
      JSON.stringify(["zzz", "a"]),
    );
    expect(hydrateFoldedCompactIds(SID, flowWithTwoCompacts())).toEqual(
      new Set(["c", "e"]),
    );
  });

  it("falls back to default-fold when localStorage payload is malformed", () => {
    localStorage.setItem(`loomscope:unfold:${SID}`, "not-json{");
    expect(hydrateFoldedCompactIds(SID, flowWithTwoCompacts())).toEqual(
      new Set(["c", "e"]),
    );
  });

  it("falls back to default-fold when localStorage payload isn't an array", () => {
    localStorage.setItem(
      `loomscope:unfold:${SID}`,
      JSON.stringify({ c: true }),
    );
    expect(hydrateFoldedCompactIds(SID, flowWithTwoCompacts())).toEqual(
      new Set(["c", "e"]),
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// fold mutators
// ────────────────────────────────────────────────────────────────────

describe("foldCompact / unfoldCompact / toggleCompactFold", () => {
  function flow() {
    return chatFlow([
      chatNode("a", null),
      chatNode("b", "a"),
      chatNode("c", "b", true, "b"),
      chatNode("d", "c"),
      chatNode("e", "d", true, "d"),
    ]);
  }

  it("foldCompact adds the id and persists complement to localStorage (unfolded set)", () => {
    // Seed: empty folded set means BOTH compacts (c, e) are unfolded.
    // After foldCompact('c'), folded={c}, unfolded={e}; storage = ['e'].
    seed(flow(), new Set());
    useStore.getState().foldCompact(SID, "c");
    const sess = useStore.getState().sessions.get(SID)!;
    expect(sess.foldedCompactIds.has("c")).toBe(true);
    expect(
      new Set(JSON.parse(localStorage.getItem(`loomscope:unfold:${SID}`)!)),
    ).toEqual(new Set(["e"]));
  });

  it("unfoldCompact removes the id and persists complement to localStorage", () => {
    // Seed: both compacts folded; storage initially empty / null.
    // After unfoldCompact('c'), folded={e}, unfolded={c}; storage=['c'].
    seed(flow(), new Set(["c", "e"]));
    useStore.getState().unfoldCompact(SID, "c");
    const sess = useStore.getState().sessions.get(SID)!;
    expect(sess.foldedCompactIds.has("c")).toBe(false);
    expect(sess.foldedCompactIds.has("e")).toBe(true);
    expect(
      new Set(JSON.parse(localStorage.getItem(`loomscope:unfold:${SID}`)!)),
    ).toEqual(new Set(["c"]));
  });

  it("toggleCompactFold flips state (folded → unfolded → folded)", () => {
    seed(flow(), new Set(["c"]));
    useStore.getState().toggleCompactFold(SID, "c");
    expect(useStore.getState().sessions.get(SID)!.foldedCompactIds.has("c")).toBe(
      false,
    );
    useStore.getState().toggleCompactFold(SID, "c");
    expect(useStore.getState().sessions.get(SID)!.foldedCompactIds.has("c")).toBe(
      true,
    );
  });

  it("ignores non-compact ChatNode ids (defensive — won't pollute the set)", () => {
    seed(flow(), new Set());
    useStore.getState().foldCompact(SID, "a"); // a is a normal turn, not compact
    expect(useStore.getState().sessions.get(SID)!.foldedCompactIds.size).toBe(0);
    expect(localStorage.getItem(`loomscope:unfold:${SID}`)).toBeNull();
  });

  it("ignores ids that don't exist in the flow", () => {
    seed(flow(), new Set());
    useStore.getState().foldCompact(SID, "ghost");
    expect(useStore.getState().sessions.get(SID)!.foldedCompactIds.size).toBe(0);
  });

  it("no-op on missing session", () => {
    // Don't seed — but call anyway.
    useStore.getState().foldCompact(SID, "c");
    expect(useStore.getState().sessions.size).toBe(0);
  });
});
