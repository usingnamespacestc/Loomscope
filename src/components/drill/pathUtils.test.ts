// v0.8 M4 — root → focused linear path resolution tests.

import { describe, expect, it } from "vitest";

import {
  findLatestLeafId,
  findLatestLeafInSubtree,
  resolvePath,
} from "@/components/drill/pathUtils";
import type { ChatFlow, ChatNode } from "@/data/types";

function cn(
  id: string,
  parent: string | null,
  ts = `2026-04-10T00:00:${id.padStart(2, "0")}.000Z`,
): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, timestamp: ts, attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function flow(nodes: ChatNode[]): ChatFlow {
  return {
    id: "session-x",
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

describe("resolvePath — linear chain", () => {
  it("walks parentChatNodeId from selected back to root", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b"), cn("d", "c")]);
    const r = resolvePath(cf, "c");
    expect(r.path).toEqual(["a", "b", "c"]);
    expect(r.forks).toEqual([]);
  });

  it("default endpoint = latest leaf when nothing is selected", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    const r = resolvePath(cf, null);
    expect(r.path).toEqual(["a", "b", "c"]);
  });

  it("falls back to latest leaf when selectedId points at a non-existent ChatNode", () => {
    const cf = flow([cn("a", null), cn("b", "a")]);
    const r = resolvePath(cf, "ghost-id");
    expect(r.path).toEqual(["a", "b"]);
  });

  it("returns empty path when ChatFlow is null or has no chatNodes", () => {
    expect(resolvePath(null, null)).toEqual({ path: [], forks: [] });
    expect(resolvePath(flow([]), null)).toEqual({ path: [], forks: [] });
  });
});

describe("resolvePath — fork detection", () => {
  it("emits ForkInfo for fork-mid (path takes one branch, sibling tracked)", () => {
    // a → b (fork) → c1, c2; selected = c1.
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b", "2026-04-10T00:00:03.000Z"),
      cn("c2", "b", "2026-04-10T00:00:04.000Z"),
    ]);
    const r = resolvePath(cf, "c1");
    expect(r.path).toEqual(["a", "b", "c1"]);
    expect(r.forks).toEqual([
      // children sorted by timestamp asc → c1 first, c2 second.
      { nodeId: "b", childIds: ["c1", "c2"], chosenChildId: "c1" },
    ]);
  });

  it("fork-at-end: selected IS the fork node → chosenChildId = null", () => {
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b"),
      cn("c2", "b"),
    ]);
    const r = resolvePath(cf, "b");
    expect(r.path).toEqual(["a", "b"]);
    expect(r.forks).toEqual([
      { nodeId: "b", childIds: expect.arrayContaining(["c1", "c2"]), chosenChildId: null },
    ]);
  });

  it("multiple forks along the path emit one ForkInfo each", () => {
    // a → b (2 children) → c1 → d1 (2 children) → e1 → leaf
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b", "2026-04-10T00:00:03.000Z"),
      cn("c2", "b", "2026-04-10T00:00:04.000Z"),
      cn("d1", "c1", "2026-04-10T00:00:05.000Z"),
      cn("e1", "d1", "2026-04-10T00:00:06.000Z"),
      cn("e2", "d1", "2026-04-10T00:00:07.000Z"),
    ]);
    const r = resolvePath(cf, "e1");
    expect(r.path).toEqual(["a", "b", "c1", "d1", "e1"]);
    expect(r.forks).toEqual([
      { nodeId: "b", childIds: ["c1", "c2"], chosenChildId: "c1" },
      { nodeId: "d1", childIds: ["e1", "e2"], chosenChildId: "e1" },
    ]);
  });

  it("non-fork ChatNodes (1 child) don't emit ForkInfo", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    const r = resolvePath(cf, "c");
    expect(r.forks).toEqual([]);
  });

  it("ChatNodes with timestamp tie sort by id ascending (stable)", () => {
    const same = "2026-04-10T00:00:03.000Z";
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("y-child", "b", same),
      cn("x-child", "b", same),
      cn("z-child", "b", same),
    ]);
    const r = resolvePath(cf, "x-child");
    // Stable order = id ascending (x, y, z).
    expect(r.forks[0].childIds).toEqual(["x-child", "y-child", "z-child"]);
    expect(r.forks[0].chosenChildId).toBe("x-child");
  });
});

describe("findLatestLeafId", () => {
  it("returns the latest leaf walking always-latest-child", () => {
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b", "2026-04-10T00:00:03.000Z"),
      cn("c2", "b", "2026-04-10T00:00:04.000Z"), // later timestamp wins
    ]);
    expect(findLatestLeafId(cf)).toBe("c2");
  });

  it("returns null on empty chatFlow", () => {
    expect(findLatestLeafId(null)).toBeNull();
    expect(findLatestLeafId(flow([]))).toBeNull();
  });
});

describe("findLatestLeafInSubtree", () => {
  it("walks always-latest-child from a specific start node to a leaf", () => {
    const cf = flow([
      cn("root", null),
      cn("a", "root"),
      cn("b1", "a", "2026-04-10T00:00:03.000Z"),
      cn("b2", "a", "2026-04-10T00:00:04.000Z"), // latest
      cn("c", "b2", "2026-04-10T00:00:05.000Z"),
    ]);
    // Start at "a" → latest child is b2 → leaf is c.
    expect(findLatestLeafInSubtree(cf, "a")).toBe("c");
    // Start at "b1" → no children → return self.
    expect(findLatestLeafInSubtree(cf, "b1")).toBe("b1");
  });

  it("returns null when start node not in chatFlow / chatFlow null", () => {
    const cf = flow([cn("a", null)]);
    expect(findLatestLeafInSubtree(cf, "missing-id")).toBeNull();
    expect(findLatestLeafInSubtree(null, "a")).toBeNull();
  });
});
