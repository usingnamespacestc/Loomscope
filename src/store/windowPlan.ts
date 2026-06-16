// Canvas windowing policy (#6). dagre's recursive acyclic DFS overflows
// the stack at ~5k linearly-chained nodes, so the ChatFlow canvas must
// lay out only a bounded WINDOW of ChatNodes. We express the window as a
// knapsack over the existing fold machinery: the "items" are the
// inter-compact segments (a compact's fold range), and the budget caps
// how many ChatNodes are visible (= laid out). When expanding past the
// budget we re-fold the segments farthest from the focus — a sliding
// window that reuses computeFoldProjection / foldedCompactIds wholesale.
import type { ChatFlow, ChatNode } from "@/data/types";
import { computeFoldProjection } from "@/canvas/foldProjection";

/** Max visible (laid-out) ChatNodes. Well under dagre's ~5k overflow
 *  threshold; two ≤500 segments flanking a focus compact fit exactly. */
export const WINDOW_BUDGET = 1000;

// Canonical compact-host test (mirrors sessionSlice.isCompactFoldHost;
// inlined to avoid a windowPlan ↔ sessionSlice import cycle).
function isCompactHost(cn: ChatNode): boolean {
  return cn.isCompactSummary || (cn.hasInnerCompact ?? false);
}

/** Visible (non-hidden) ChatNode count for a given folded set. */
export function visibleCount(
  chatFlow: ChatFlow,
  foldedCompactIds: Set<string>,
): number {
  const proj = computeFoldProjection(chatFlow, foldedCompactIds);
  return chatFlow.chatNodes.length - proj.hidden.size;
}

/**
 * Knapsack window policy. Returns a folded set whose VISIBLE node count
 * (total − hidden) is ≤ `budget`, by re-folding the currently-unfolded
 * compacts FARTHEST (by ChatNode sequence index) from the focus — never
 * folding one whose range would hide the focus node itself. Only ADDS
 * folds (never unfolds), so the caller's explicit unfolds near the focus
 * are preserved. Pure: no store access. Uses computeFoldProjection as
 * the source of truth, so it's correct regardless of range nesting.
 *
 * If even folding every foldable compact can't reach the budget (a
 * single inter-compact segment is itself larger than the budget), it
 * folds what it can and returns — that residual is the 6c sub-chunk case.
 */
export function planWindow(
  chatFlow: ChatFlow,
  foldedCompactIds: Set<string>,
  focusNodeId: string | null,
  budget: number = WINDOW_BUDGET,
): Set<string> {
  const chatNodes = chatFlow.chatNodes;
  const total = chatNodes.length;
  const idxById = new Map<string, number>();
  chatNodes.forEach((c, i) => idxById.set(c.id, i));

  const focusId =
    focusNodeId && idxById.has(focusNodeId)
      ? focusNodeId
      : (chatNodes[total - 1]?.id ?? null);
  const focusIdx = focusId ? (idxById.get(focusId) ?? total - 1) : total - 1;

  let folded = new Set(foldedCompactIds);
  let proj = computeFoldProjection(chatFlow, folded);
  if (total - proj.hidden.size <= budget) return folded;

  // Unfolded compact hosts, farthest-from-focus first.
  const candidates = chatNodes
    .filter((cn) => isCompactHost(cn) && !folded.has(cn.id))
    .sort(
      (a, b) =>
        Math.abs((idxById.get(b.id) ?? 0) - focusIdx) -
        Math.abs((idxById.get(a.id) ?? 0) - focusIdx),
    );

  for (const cn of candidates) {
    if (total - proj.hidden.size <= budget) break;
    const trial = new Set(folded);
    trial.add(cn.id);
    const trialProj = computeFoldProjection(chatFlow, trial);
    if (focusId && trialProj.hidden.has(focusId)) continue; // would hide focus
    folded = trial;
    proj = trialProj;
  }
  return folded;
}
