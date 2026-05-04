// v0.8 M4 — root → focused linear path resolution for the
// Conversation tab.
//
// Algorithm port of Agentloom's `frontend/src/canvas/pathUtils.ts`,
// adapted to Loomscope's ChatFlow / ChatNode shape:
//   - Loomscope ChatNodes have a single `parentChatNodeId: string |
//     null` (Agentloom uses `parent_ids: string[]` because its DAG
//     allows merge nodes; Loomscope's ChatFlow is strictly a tree
//     until v∞ adds merge writeback).
//   - "Latest leaf" walking takes the highest timestamp child; ties
//     break by id ascending (matches the dagre LR layout's stable
//     sibling order).
//   - ForkInfo is emitted for every node on the path with >1
//     children, regardless of fork origin (in-session sibling vs
//     cross-session /branch fork). Per design micro-decision 4A.

import type { ChatFlow, ChatNode } from "@/data/types";

export interface ForkInfo {
  /** ChatNode id whose children are the branches. */
  nodeId: string;
  /** All child ChatNode ids in stable order (timestamp asc, id asc). */
  childIds: string[];
  /** The child the path currently takes, or null when the path
   * terminates AT the fork (user clicked the fork node itself). */
  chosenChildId: string | null;
}

export interface ResolvedPath {
  /** ChatNode ids root → endpoint inclusive both ends. Empty when
   * the ChatFlow has no chatNodes. */
  path: string[];
  /** One ForkInfo per fork point traversed, in path order. */
  forks: ForkInfo[];
}

/**
 * Resolve the root → endpoint path through `chatFlow`.
 *
 * - When `selectedChatNodeId` matches a ChatNode, walk parentChatNodeId
 *   back to a root from there.
 * - Otherwise, default to the latest leaf (start at the first root by
 *   timestamp, then always take the latest child until a leaf).
 *
 * The function is pure: same input → same output. Branch *memory*
 * (the "go back to where I was" UX layer) lives in the store, not
 * here — see sessionSlice.branchMemory + pickBranch action.
 */
export function resolvePath(
  chatFlow: ChatFlow | null,
  selectedChatNodeId: string | null,
): ResolvedPath {
  if (!chatFlow || chatFlow.chatNodes.length === 0) {
    return { path: [], forks: [] };
  }
  const byId = new Map(chatFlow.chatNodes.map((c) => [c.id, c]));
  const childrenOf = buildChildrenMap(chatFlow.chatNodes);

  // Endpoint resolution.
  let endpoint: ChatNode | undefined;
  if (selectedChatNodeId && byId.has(selectedChatNodeId)) {
    endpoint = byId.get(selectedChatNodeId);
  } else {
    endpoint = defaultLatestLeaf(chatFlow.chatNodes, childrenOf);
  }
  if (!endpoint) return { path: [], forks: [] };

  // Walk parentChatNodeId from endpoint back to a root.
  const path: string[] = [];
  const guard = new Set<string>();
  let cursor: ChatNode | undefined = endpoint;
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    path.unshift(cursor.id);
    if (!cursor.parentChatNodeId) break;
    cursor = byId.get(cursor.parentChatNodeId);
  }

  // Emit fork info for any node on the path with >1 children.
  const forks: ForkInfo[] = [];
  for (let i = 0; i < path.length; i++) {
    const nid = path[i];
    const children = childrenOf.get(nid) ?? [];
    if (children.length > 1) {
      const chosen: string | null = i + 1 < path.length ? path[i + 1] : null;
      forks.push({ nodeId: nid, childIds: children, chosenChildId: chosen });
    }
  }
  return { path, forks };
}

/** Default-walk leaf id (no selection, always-latest-child). Used to
 * auto-populate the Conversation tab on first load. */
export function findLatestLeafId(chatFlow: ChatFlow | null): string | null {
  if (!chatFlow || chatFlow.chatNodes.length === 0) return null;
  const childrenOf = buildChildrenMap(chatFlow.chatNodes);
  const leaf = defaultLatestLeaf(chatFlow.chatNodes, childrenOf);
  return leaf?.id ?? null;
}

/**
 * Walk from a specific ChatNode id always-latest-child to a leaf.
 * Used by ConversationView's BranchSelector: picking branch X jumps
 * the user to the leaf of X's subtree (so they see the full path
 * along that branch, not just the immediate child).
 */
export function findLatestLeafInSubtree(
  chatFlow: ChatFlow | null,
  startChatNodeId: string,
): string | null {
  if (!chatFlow) return null;
  const byId = new Map(chatFlow.chatNodes.map((c) => [c.id, c]));
  if (!byId.has(startChatNodeId)) return null;
  const childrenOf = buildChildrenMap(chatFlow.chatNodes);
  const visited = new Set<string>();
  let cursor: ChatNode | undefined = byId.get(startChatNodeId);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const children = childrenOf.get(cursor.id) ?? [];
    if (children.length === 0) return cursor.id;
    const latestId = children[children.length - 1];
    cursor = byId.get(latestId);
  }
  return cursor?.id ?? startChatNodeId;
}

/** Build parentChatNodeId → [childId] map with stable sort: ChatNodes
 * with earlier timestamp come first; equal timestamps fall back to
 * id-ascending order (matches the dagre LR layout's sibling order). */
function buildChildrenMap(chatNodes: ChatNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const cn of chatNodes) {
    if (cn.parentChatNodeId) {
      const list = out.get(cn.parentChatNodeId) ?? [];
      list.push(cn.id);
      out.set(cn.parentChatNodeId, list);
    }
  }
  const tsOf = new Map<string, string>();
  for (const cn of chatNodes) tsOf.set(cn.id, cn.userMessage.timestamp ?? "");
  for (const arr of out.values()) {
    arr.sort((a, b) => {
      const ta = tsOf.get(a) ?? "";
      const tb = tsOf.get(b) ?? "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return out;
}

function defaultLatestLeaf(
  chatNodes: ChatNode[],
  childrenOf: Map<string, string[]>,
): ChatNode | undefined {
  // Pick the earliest root by timestamp (mirrors session start).
  // Then always-latest-child walk to a leaf.
  const roots = chatNodes
    .filter((c) => c.parentChatNodeId === null)
    .sort((a, b) => {
      const ta = a.userMessage.timestamp ?? "";
      const tb = b.userMessage.timestamp ?? "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const root = roots[0];
  if (!root) return undefined;
  const byId = new Map(chatNodes.map((c) => [c.id, c]));
  const visited = new Set<string>();
  let cursor: ChatNode = root;
  while (!visited.has(cursor.id)) {
    visited.add(cursor.id);
    const children = childrenOf.get(cursor.id) ?? [];
    if (children.length === 0) return cursor;
    const latestId = children[children.length - 1];
    const next = byId.get(latestId);
    if (!next) return cursor;
    cursor = next;
  }
  return cursor;
}
