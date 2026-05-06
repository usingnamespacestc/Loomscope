// Compact-fold projection. Given a ChatFlow + the set of compact
// ChatNode ids whose pre-compact range is folded, decide:
//
//   1. which ChatNodes are hidden (= absorbed into some fold host),
//   2. which fold each hidden ChatNode is absorbed into,
//   3. each fold's tail-member id (used by M3's edge reroute to pick
//      the "boundary" handle on the synthetic chatFold rfNode),
//   4. the count of hidden ChatNodes per fold (drives the chatFold
//      card's "📦 N folded" badge).
//
// The algorithm is largest-range attribution: when a ChatNode lies on
// the parentChatNodeId chain of multiple folded compacts, it's attributed
// to the LARGEST range. For sequential auto-compact on the same chain
// (which is how CC actually emits them — every new compact's summary
// distills the entire context window including any earlier compact's
// summary plus everything since), ranges are strictly nested:
// ``range(compact_N) ⊃ range(compact_N-1) ⊃ ... ⊃ range(compact_1)``.
// Largest-first picks the LATEST compact, which absorbs every earlier
// compact + every chain member. After the user unfolds the latest
// compact, the next-largest-still-folded compact becomes the new outer
// host — peel-the-onion behaviour.
//
// **Convexity guard**: when two fold ranges overlap but neither
// contains the other (= parallel forks where each branch has its own
// compact tail), DAG quotient-projection by non-convex equivalence
// classes can introduce cycles in the rendered graph. We follow
// Agentloom's `feedback_dag_projection_cycles.md` guidance: largest
// claims first, the smaller fold's claim shrinks to whatever's left,
// and an empty claim drops the fold from the projection (orphan
// filter). The dropped fold's host compact stays visible as a normal
// compact card — the user can still toggle it; if they do, it becomes
// the largest folded, takes the spot, and the previous outer flips.
//
// Sibling branches off the main chain (in-session edit-and-resubmit
// siblings, cross-session ``/branch`` forks) are not on any folded
// compact's parentChatNodeId walk, so they never appear in any range
// and are never hidden — they stay visible alongside the fold host.
// This matches the user's mental model: the compact summarised the
// chain it ran on, not the parallel branch.
//
// This module is pure: no React, no store reads. M3 will plug it
// into ``layoutChatFlow`` (so dagre lays out the chatFold phantom
// instead of the absorbed members) and wire ``ChatFoldNodeCard``
// into nodeTypes.

import type { ChatFlow, ChatNode } from "@/data/types";
import { computeCompactRange } from "@/store/sessionSlice";

export interface FoldProjection {
  // ChatNode ids hidden from the projected canvas. `host = foldByHidden.get(id)`
  // names the compact whose chatFold phantom absorbs it.
  hidden: Set<string>;
  // hidden id → host compact id (= chatFold phantom owner).
  foldByHidden: Map<string, string>;
  // host compact id → number of hidden ChatNodes attributed to that fold.
  // Equivalent to the chatFold card's "📦 N folded" badge.
  countByFold: Map<string, number>;
  // host compact id → the ChatNode id that lies furthest from root in
  // the host's claim (= the "tail" the fold visually replaces). Used
  // by M3 to decide which handle the fold's outgoing edge to the
  // host attaches to. Matches Agentloom's `lastMemberByFold`.
  lastMemberByFold: Map<string, string>;
  // host compact id → preTokens (when known) of the host's compactMetadata.
  // Convenient surface for the chatFold card so it doesn't have to
  // re-cross-reference the chatFlow.
  preTokensByFold: Map<string, number>;
  // host compact ids that contributed at least one hidden ChatNode
  // and therefore have an active chatFold phantom in the projection.
  // Differs from ``foldedCompactIds`` because compacts that lost
  // attribution (orphan filter, or no resolvable range) are NOT in
  // this set — their compact card renders normally without a fold.
  activeFoldHostIds: Set<string>;
}

// Stable phantom-id prefix. Chosen so the id space is disjoint from
// ChatNode ids (which are uuids) — defensive against any stray code
// path that does `.find((c) => c.id === ...)` against a chatFlow.
export const CHAT_FOLD_PREFIX = "chatfold:";

export function chatFoldIdFor(hostCompactId: string): string {
  return `${CHAT_FOLD_PREFIX}${hostCompactId}`;
}

export function isChatFoldId(id: string): boolean {
  return id.startsWith(CHAT_FOLD_PREFIX);
}

export function compactIdFromFoldId(foldId: string): string {
  return foldId.slice(CHAT_FOLD_PREFIX.length);
}

// v0.8.1 #5: derive the chain of fold-host compact ids that hide
// `targetId`, in unfold order (outer-most first). Returns an empty
// array when the target is already visible. Pure: callers apply the
// unfolds via the regular store action.
export function computeUnfoldChainTo(
  chatFlow: ChatFlow,
  foldedCompactIds: Set<string>,
  targetId: string,
): string[] {
  let working = foldedCompactIds;
  let proj = computeFoldProjection(chatFlow, working);
  const chain: string[] = [];
  // Cap iterations defensively — a malformed projection that fails
  // to peel a host on each step would otherwise loop forever.
  const cap = working.size + 1;
  while (proj.hidden.has(targetId) && chain.length < cap) {
    const host = proj.foldByHidden.get(targetId);
    if (!host) break;
    chain.push(host);
    const next = new Set(working);
    next.delete(host);
    working = next;
    proj = computeFoldProjection(chatFlow, working);
  }
  return chain;
}

// Compute the projection. Returns an empty projection (all maps empty)
// when ``foldedCompactIds`` is empty — callers should short-circuit
// in that common case before iterating. Stable wrt input ordering:
// the ChatFlow's ``chatNodes`` order is preserved through derived
// outputs; sorting we do internally (range size desc) is by tuple
// (range size desc, host id asc) so ties resolve deterministically.
export function computeFoldProjection(
  chatFlow: ChatFlow,
  foldedCompactIds: Set<string>,
): FoldProjection {
  const empty: FoldProjection = {
    hidden: new Set(),
    foldByHidden: new Map(),
    countByFold: new Map(),
    lastMemberByFold: new Map(),
    preTokensByFold: new Map(),
    activeFoldHostIds: new Set(),
  };
  if (foldedCompactIds.size === 0) return empty;

  // Phase 1: realise each folded compact's range as ordered ChatNode[].
  // Skip compacts that are folded but no longer in the live flow (the
  // session-load reconciliation should have dropped these — defensive
  // double-check), or whose range is empty (logicalParentChatNodeId
  // missing / dangling).
  type Candidate = {
    hostId: string;
    range: ChatNode[];
    rangeIds: Set<string>;
  };
  const candidates: Candidate[] = [];
  for (const hostId of foldedCompactIds) {
    const range = computeCompactRange(chatFlow, hostId);
    if (range.length === 0) continue;
    candidates.push({
      hostId,
      range,
      rangeIds: new Set(range.map((c) => c.id)),
    });
  }

  // Phase 2: largest-first attribution. ChatNodes are claimed by the
  // first candidate (= largest range) that contains them; remaining
  // candidates only see what's left.
  candidates.sort((a, b) => {
    if (b.range.length !== a.range.length) return b.range.length - a.range.length;
    return a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0;
  });

  const hidden = new Set<string>();
  const foldByHidden = new Map<string, string>();
  const claimByFold = new Map<string, ChatNode[]>();

  for (const c of candidates) {
    const claimed: ChatNode[] = [];
    for (const cn of c.range) {
      if (hidden.has(cn.id)) continue;
      // Defensive: don't absorb the host into its own fold. The host's
      // range is the chain BEFORE it; including the host itself can
      // only happen if compactMetadata.logicalParentChatNodeId points
      // at the compact ChatNode itself (corrupt JSONL) — in that case
      // skip silently rather than producing a self-loop edge.
      if (cn.id === c.hostId) continue;
      hidden.add(cn.id);
      foldByHidden.set(cn.id, c.hostId);
      claimed.push(cn);
    }
    if (claimed.length > 0) claimByFold.set(c.hostId, claimed);
  }

  // Phase 3: assemble derived per-fold outputs. The "last member" is
  // the claim member furthest from root — i.e. the one whose chain
  // position is just before the host. In the ordered range the last
  // entry is the tail by construction (`computeCompactRange` returns
  // time-ascending), but after attribution the LAST claimed entry is
  // the right pick (an outer fold may have stripped tail entries that
  // were stolen by some other fold — though for strict-containment
  // chains this won't happen).
  const countByFold = new Map<string, number>();
  const lastMemberByFold = new Map<string, string>();
  const preTokensByFold = new Map<string, number>();
  const activeFoldHostIds = new Set<string>();

  // PR 2.4-B: include both pure compact ChatNodes and hybrid
  // ChatNodes (real prompt + inline compact). Both carry
  // compactMetadata.preTokens used by the chatFold phantom badge.
  const compactMetaById = new Map<string, ChatNode>();
  for (const cn of chatFlow.chatNodes) {
    if (cn.isCompactSummary || cn.hasInnerCompact) {
      compactMetaById.set(cn.id, cn);
    }
  }

  for (const [hostId, claimed] of claimByFold) {
    countByFold.set(hostId, claimed.length);
    lastMemberByFold.set(hostId, claimed[claimed.length - 1].id);
    activeFoldHostIds.add(hostId);
    const hostCn = compactMetaById.get(hostId);
    const pre = hostCn?.compactMetadata?.preTokens;
    if (typeof pre === "number") preTokensByFold.set(hostId, pre);
  }

  return {
    hidden,
    foldByHidden,
    countByFold,
    lastMemberByFold,
    preTokensByFold,
    activeFoldHostIds,
  };
}
