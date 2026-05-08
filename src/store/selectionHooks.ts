// Per-node selection subscriptions.
//
// Why this exists: ChatNodeCard / WorkNode cards used to read `selected`
// from React Flow's NodeProps, with the canvas wrapper computing
// `decoratedNodes = nodes.map((n) => ({ ...n, selected: ... }))` on
// every selection change. That gave every node a fresh object identity
// per click, so React Flow reconciled the entire 1500-card graph each
// time — measured 458 ms round-trip on a 256MB session in v0.4.
//
// These hooks let each card subscribe directly to "is this id the
// selected one?" through a Zustand selector that returns a boolean.
// Default Object.is equality means 1498 cards see `false → false` and
// don't re-render; only the deselect + new-select pair flips state and
// re-renders. That cuts the worst-case re-render count from N to 2.

import { useStore } from "@/store/index";

/** True iff `id` is the currently selected ChatNode in the active session. */
export function useIsChatNodeSelected(id: string): boolean {
  return useStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return false;
    return s.sessions.get(sid)?.selectedNodeId === id;
  });
}

/** True iff `id` is the currently selected WorkNode in the active session. */
export function useIsWorkNodeSelected(id: string): boolean {
  return useStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return false;
    return s.sessions.get(sid)?.workflowSelectedNodeId === id;
  });
}

/** True iff `id` is the ChatNode currently being hovered in the
 * Conversation tab (after the dwell threshold). Same per-card pattern
 * as `useIsChatNodeSelected` so 1499 cards skip re-render and only the
 * enter / leave pair flips. */
export function useIsConversationHovered(id: string): boolean {
  return useStore((s) => s.conversationHoveredChatNodeId === id);
}

/** True iff this ChatNode does NOT belong to the active session's own
 * jsonl. CC's forkSession copies records with new uuids but preserves
 * promptId, so the parser merges shared prefix into one ChatNode whose
 * `contributingSessions` lists every jsonl that contributed records.
 *
 * When the active session id is NOT in that list, the ChatNode lives
 * exclusively on a sibling fork — read-only from this view. Cards
 * render with reduced opacity; composing from such a node is blocked
 * at the composer (PR 2 adds right-click "jump to source session").
 *
 * Caller passes the contributingSessions snapshot from its ChatNode
 * (already in scope on every card) — the selector only depends on
 * activeSessionId so re-render frequency matches activeSessionId
 * changes (= rare), not arbitrary store churn. Object.is on the
 * boolean output keeps card re-renders to enter/leave pairs. */
export function useIsOffActiveChain(
  contributingSessions: string[] | undefined,
): boolean {
  return useStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return false;
    // Empty or missing contributingSessions = legacy / unknown
    // provenance (hand-built fixtures, pre-PR-1 cached payloads).
    // Be permissive — treat as on-chain.
    if (!contributingSessions || contributingSessions.length === 0) {
      return false;
    }
    return !contributingSessions.includes(sid);
  });
}
