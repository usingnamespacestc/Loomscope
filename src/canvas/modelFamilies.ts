// BFS over the line graph of ChatFlow edges to find every edge using
// the same model as a hovered edge.
//
// Loomscope simplification: each ChatNode has only ONE model (last
// llm_call.model), so there's only one kind of family — no draft /
// judge / tool split like Agentloom. Returns a single family or null.

import type { ChatFlow, ChatNode } from "@/data/types";

import { colorForModel } from "@/canvas/modelColor";

export interface ModelFamily {
  /** model id, e.g. "claude-opus-4-7"; undefined when target had no
   * llm_call (slash command, compact-only) — family still valid for
   * "edges with no model" highlight. */
  model: string | undefined;
  /** Hashed color from colorForModel(model). */
  color: string;
  /** ChatNodes that this family touches (any node touched by a family
   * edge). Used for "pass-through" segments that visually penetrate
   * the card when the same model continues across it. */
  nodeIds: Set<string>;
  /** parent → child id pairs. */
  edges: Array<[string, string]>;
}

function lastModelOf(cn: ChatNode): string | undefined {
  const llms = cn.workflow.nodes.filter((n) => n.kind === "llm_call");
  if (llms.length === 0) return undefined;
  const last = llms[llms.length - 1];
  return last.kind === "llm_call" ? last.model : undefined;
}

/**
 * BFS from a hovered edge through edges that share the same model
 * (model is keyed on the EDGE's child ChatNode — the one that ran
 * with that model after the edge).
 */
export function computeModelFamily(
  chatFlow: ChatFlow,
  hoveredParentId: string,
  hoveredChildId: string,
): ModelFamily | null {
  // Build node lookup + edge index by node.
  const nodeById = new Map<string, ChatNode>();
  for (const cn of chatFlow.chatNodes) nodeById.set(cn.id, cn);

  const allEdges: Array<[string, string]> = [];
  const edgesByNode = new Map<string, Array<[string, string]>>();
  for (const cn of chatFlow.chatNodes) {
    if (!cn.parentChatNodeId) continue;
    const e: [string, string] = [cn.parentChatNodeId, cn.id];
    allEdges.push(e);
    for (const endpoint of e) {
      const arr = edgesByNode.get(endpoint);
      if (arr) arr.push(e);
      else edgesByNode.set(endpoint, [e]);
    }
  }

  const child = nodeById.get(hoveredChildId);
  if (!child) return null;
  const seedModel = lastModelOf(child);

  // Edge "key" for the visited set
  const edgeKey = (e: [string, string]) => `${e[0]}->${e[1]}`;
  const sameModel = (e: [string, string]) => {
    const c = nodeById.get(e[1]);
    return c ? lastModelOf(c) === seedModel : false;
  };

  const seed: [string, string] = [hoveredParentId, hoveredChildId];
  const visited = new Set<string>([edgeKey(seed)]);
  const familyEdges: Array<[string, string]> = [seed];
  const queue: Array<[string, string]> = [seed];
  while (queue.length > 0) {
    const [p, c] = queue.shift()!;
    // Walk every edge adjacent to either endpoint.
    for (const adj of [...(edgesByNode.get(p) ?? []), ...(edgesByNode.get(c) ?? [])]) {
      const k = edgeKey(adj);
      if (visited.has(k)) continue;
      if (!sameModel(adj)) continue;
      visited.add(k);
      familyEdges.push(adj);
      queue.push(adj);
    }
  }

  const nodeIds = new Set<string>();
  for (const [p, c] of familyEdges) {
    nodeIds.add(p);
    nodeIds.add(c);
  }

  return {
    model: seedModel,
    color: colorForModel(seedModel),
    nodeIds,
    edges: familyEdges,
  };
}
