// Builds the "effective context" segment list for a ChatNode — the
// pre-LLM-call context the node *actually receives*, after CC's
// auto-compact has truncated history.
//
// CC inserts compact ChatNodes (`isCompactSummary === true`) and
// hybrid ChatNodes (`hasInnerCompact === true`, real prompt + inline
// compact mid-turn) into the chain; both replace upstream content
// with their `compactMetadata.summaryText` for everything downstream.
//
// Algorithm (per user spec — hybrid treated identically to compact):
//   1. Walk parentChatNodeId chain from target backward (target NOT
//      in chain). Stop at chain root.
//   2. cutoff = the LATEST node in chain whose summary effect kicks
//      in for downstream — pure compact OR hybrid.
//   3. If cutoff exists:
//        emit `compact_summary` (cutoff's summaryText)
//        if cutoff is hybrid: emit `ancestor` for cutoff's own
//          user/assistant pair (its post-compact tail is verbatim
//          context for downstream)
//        emit `ancestor` for each chain node BETWEEN cutoff and
//          target (exclusive on both ends)
//      Else:
//        emit `ancestor` for the entire chain
//   4. Emit `current_turn` for target.
//
// Special case — compact target: a pure compact ChatNode is a
// synthetic boundary marker, not a real turn. Returning a single
// `compact_summary_only` segment with its summaryText is the most
// useful view (downstream's POV of what this boundary contributes).

import type { ChatFlow, ChatNode } from "@/data/types";

export type EffectiveSegmentKind =
  | "compact_summary"
  | "ancestor"
  | "current_turn"
  | "compact_summary_only";

export interface EffectiveContextSegment {
  kind: EffectiveSegmentKind;
  // The ChatNode this segment maps to. For `compact_summary` the
  // segment carries the cutoff's summaryText — the source ChatNode
  // is the cutoff itself. For `ancestor` and `current_turn` the
  // source ChatNode is the one whose user/assistant pair is rendered.
  sourceChatNodeId: string;
  // Pre-resolved summary text for `compact_summary` /
  // `compact_summary_only` segments. Empty string for ancestor /
  // current_turn (the renderer reads userMessage / assistantPreview
  // off the source ChatNode directly).
  summaryText: string;
  // True when this ancestor is itself a hybrid (`hasInnerCompact`).
  // Currently unused by the renderer per user spec (hybrid renders
  // identically to non-hybrid ancestors), but exposed so a future
  // diagnostic mode can light up the inner-compact boundary without
  // re-deriving it.
  isHybridAncestor?: boolean;
}

export function buildEffectiveContext(
  chatFlow: ChatFlow,
  targetChatNodeId: string,
): EffectiveContextSegment[] {
  const byId = new Map<string, ChatNode>();
  for (const cn of chatFlow.chatNodes) byId.set(cn.id, cn);
  const target = byId.get(targetChatNodeId);
  if (!target) return [];

  // Pure compact target: render as a single labeled summary block.
  // Hybrid target falls through to the regular path — its own user/
  // assistant pair is the current_turn; the inner compact happens
  // mid-execution, AFTER context entry.
  if (target.isCompactSummary && !target.hasInnerCompact) {
    return [
      {
        kind: "compact_summary_only",
        sourceChatNodeId: target.id,
        summaryText: target.compactMetadata?.summaryText ?? "",
      },
    ];
  }

  // Walk parent chain from target backward. Push from leaf to root,
  // then reverse so chain[0] = oldest, chain[N-1] = newest (= target's
  // direct parent).
  const chain: ChatNode[] = [];
  let curId: string | null = target.parentChatNodeId;
  // Defense against pathological cycles (shouldn't happen in real
  // CC data — parent links are append-only on disk — but the parser
  // doesn't enforce it). Cap at chatNodes.length so a cycle exits
  // instead of looping forever.
  let safety = chatFlow.chatNodes.length + 1;
  while (curId !== null && safety-- > 0) {
    const node = byId.get(curId);
    if (!node) break;
    chain.push(node);
    curId = node.parentChatNodeId;
  }
  chain.reverse();

  // Find the latest cutoff (compact-effective node).
  let cutoffIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i];
    if (n.isCompactSummary || n.hasInnerCompact) {
      cutoffIdx = i;
      break;
    }
  }

  const segments: EffectiveContextSegment[] = [];

  if (cutoffIdx >= 0) {
    const cutoff = chain[cutoffIdx];
    segments.push({
      kind: "compact_summary",
      sourceChatNodeId: cutoff.id,
      summaryText: cutoff.compactMetadata?.summaryText ?? "",
      isHybridAncestor: cutoff.hasInnerCompact === true,
    });
    if (cutoff.hasInnerCompact) {
      segments.push({
        kind: "ancestor",
        sourceChatNodeId: cutoff.id,
        summaryText: "",
        isHybridAncestor: true,
      });
    }
    for (let i = cutoffIdx + 1; i < chain.length; i++) {
      segments.push({
        kind: "ancestor",
        sourceChatNodeId: chain[i].id,
        summaryText: "",
        isHybridAncestor: chain[i].hasInnerCompact === true,
      });
    }
  } else {
    for (const n of chain) {
      segments.push({
        kind: "ancestor",
        sourceChatNodeId: n.id,
        summaryText: "",
        isHybridAncestor: n.hasInnerCompact === true,
      });
    }
  }

  segments.push({
    kind: "current_turn",
    sourceChatNodeId: target.id,
    summaryText: "",
  });

  return segments;
}
