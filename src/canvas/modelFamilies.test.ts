import { describe, expect, it } from "vitest";

import { ribbonFamilies } from "@/canvas/modelFamilies";
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

function withModel(id: string, parent: string | null, model: string | undefined): ChatNode {
  const workflow =
    model === undefined
      ? { nodes: [], edges: [] }
      : {
          nodes: [
            {
              id: `${id}-l`,
              kind: "llm_call" as const,
              parentUuid: null,
              text: "",
              thinking: [],
              model,
            },
          ],
          edges: [],
        };
  return makeChatNode({ id, parentChatNodeId: parent, workflow });
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

describe("ribbonFamilies", () => {
  it("returns one family per ModelKind (today: llm only)", () => {
    const cf = makeChatFlow([
      withModel("a", null, "claude-opus-4-7"),
      withModel("b", "a", "claude-opus-4-7"),
    ]);
    const fams = ribbonFamilies(cf, "a", "b");
    expect(fams).toHaveLength(1);
    expect(fams[0].kind).toBe("llm");
  });

  it("BFS gathers every edge with the same model in a linear chain", () => {
    const cf = makeChatFlow([
      withModel("a", null, "claude-opus-4-7"),
      withModel("b", "a", "claude-opus-4-7"),
      withModel("c", "b", "claude-opus-4-7"),
      withModel("d", "c", "claude-opus-4-7"),
    ]);
    const fams = ribbonFamilies(cf, "b", "c");
    const fam = fams[0];
    expect(fam.model).toBe("claude-opus-4-7");
    expect(fam.edges.length).toBe(3); // a→b, b→c, c→d
    expect(fam.nodeIds).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("BFS stops at edges that switch model", () => {
    const cf = makeChatFlow([
      withModel("a", null, "claude-opus-4-7"),
      withModel("b", "a", "claude-opus-4-7"),
      withModel("c", "b", "claude-sonnet-4-6"), // switch
      withModel("d", "c", "claude-sonnet-4-6"),
    ]);
    // Hover the early opus segment.
    const opusFam = ribbonFamilies(cf, "a", "b")[0];
    expect(opusFam.model).toBe("claude-opus-4-7");
    expect(opusFam.edges).toEqual([["a", "b"]]);
    expect(opusFam.nodeIds).toEqual(new Set(["a", "b"]));

    // Hover the late sonnet segment.
    const sonnetFam = ribbonFamilies(cf, "c", "d")[0];
    expect(sonnetFam.model).toBe("claude-sonnet-4-6");
    // The sonnet family includes b→c (child c is sonnet) and c→d.
    expect(new Set(sonnetFam.edges.map((e) => e.join("→")))).toEqual(
      new Set(["b→c", "c→d"]),
    );
  });

  it("hovered edge is always in the family even if seed model has no other matches", () => {
    const cf = makeChatFlow([
      withModel("a", null, "claude-opus-4-7"),
      withModel("b", "a", "claude-sonnet-4-6"),
      withModel("c", "b", "claude-opus-4-7"),
    ]);
    // a→b is sonnet-only (child b is sonnet); BFS should at least
    // include the seed edge.
    const fam = ribbonFamilies(cf, "a", "b")[0];
    expect(fam.model).toBe("claude-sonnet-4-6");
    expect(fam.edges).toContainEqual(["a", "b"]);
  });

  it("treats undefined model as its own family (slash-command chains)", () => {
    const cf = makeChatFlow([
      withModel("a", null, undefined),
      withModel("b", "a", undefined),
      withModel("c", "b", "claude-opus-4-7"),
    ]);
    const fam = ribbonFamilies(cf, "a", "b")[0];
    expect(fam.model).toBeUndefined();
    expect(fam.edges).toEqual([["a", "b"]]);
    expect(fam.nodeIds).toEqual(new Set(["a", "b"]));
  });

  it("a node that's a middle of the family appears in nodeIds for pass-through rendering", () => {
    const cf = makeChatFlow([
      withModel("a", null, "claude-opus-4-7"),
      withModel("b", "a", "claude-opus-4-7"),
      withModel("c", "b", "claude-opus-4-7"),
    ]);
    const fam = ribbonFamilies(cf, "a", "b")[0];
    // b is both incoming (a→b) and outgoing (b→c); pass-through renderer
    // relies on b being in nodeIds and on the edge index it derives.
    expect(fam.nodeIds.has("b")).toBe(true);
  });
});
