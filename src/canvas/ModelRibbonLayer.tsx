// SVG overlay drawn on top of the React Flow canvas when an edge is
// hovered. Replicates Agentloom's ribbon visual: per-edge sidewaysArc
// from parent's right side to child's left side at center y, plus a
// horizontal pass-through line through middle nodes so the ribbon
// visually "贯穿" the card without breaking at every boundary.
//
// Why "BFS family from hovered edge" instead of "all groups always":
//   - Mirrors Agentloom semantics. Hovering points at one model run;
//     the BFS expands that run to all contiguous same-model edges,
//     stopping at model-switch boundaries.
//   - Loomscope today exposes only one ModelKind ("llm"). The
//     `ribbonFamilies` function returns RibbonFamily[] anyway so adding
//     judge / tool_call kinds later is mechanical.
//
// Mounted as a child of <ReactFlow> (alongside <Background>, <Controls>)
// so the SVG lives inside the .react-flow container. That puts its
// stacking context next to xyflow internals — z-index 10 is above
// .react-flow__viewport (z-index 2), so the ribbon visibly crosses the
// card faces, matching Agentloom.

import { useMemo } from "react";

import { useStore, type ReactFlowState } from "@xyflow/react";

import type { ChatFlow } from "@/data/types";
import { ribbonFamilies, type RibbonFamily } from "@/canvas/modelFamilies";

const CARD_FALLBACK_W = 208; // matches w-52 ChatNodeCard
const CARD_FALLBACK_H = 140;

// `nodeLookup` (InternalNode map) is the only store entry where
// `measured.{width,height}` is reliably populated after layout. The
// user-facing `s.nodes` array doesn't pick up measurements on its own,
// so reading sizes from there falls back to CARD_FALLBACK and shifts
// the ribbon's center y away from the rendered card center.
const rfNodeLookupSelector = (s: ReactFlowState) => s.nodeLookup;
const rfTransformSelector = (s: ReactFlowState) => s.transform;

interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HoveredEdge {
  parent: string;
  child: string;
}

export function ModelRibbonLayer({
  chatFlow,
  hoveredEdge,
}: {
  chatFlow: ChatFlow;
  hoveredEdge: HoveredEdge | null;
}) {
  const families = useMemo<RibbonFamily[]>(() => {
    if (!hoveredEdge) return [];
    return ribbonFamilies(chatFlow, hoveredEdge.parent, hoveredEdge.child);
  }, [chatFlow, hoveredEdge]);

  // Gate BEFORE touching React Flow's store. The actual ribbon SVG lives
  // in <RibbonContent>, which is the only thing that subscribes to
  // `transform` (fires every pan/zoom frame) and `nodeLookup` (drives the
  // per-node box loop over ~1500 entries). Mounting it only while a
  // ribbon is shown means pan/zoom no longer re-renders this layer, and
  // the box loop no longer runs, when nothing is hovered.
  if (!hoveredEdge || families.length === 0) return null;

  return <RibbonContent families={families} />;
}

function RibbonContent({ families }: { families: RibbonFamily[] }) {
  const rfNodeLookup = useStore(rfNodeLookupSelector);
  const transform = useStore(rfTransformSelector);

  // Build the box map fresh every render rather than `useMemo`-ing on
  // `rfNodeLookup` identity. React Flow mutates the InternalNode Map
  // in place when measurements settle (so the reference stays the
  // same), which would let useMemo cache the pre-measurement state
  // forever and pin every center y to (CARD_FALLBACK_H / 2). Re-
  // building per render is cheap and only happens while hovering.
  const boxes = new Map<string, NodeBox>();
  for (const n of rfNodeLookup.values()) {
    boxes.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      w: n.measured.width ?? CARD_FALLBACK_W,
      h: n.measured.height ?? CARD_FALLBACK_H,
    });
  }

  const [tx, ty, tz] = transform;

  return (
    <svg
      data-testid="model-ribbon-layer"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 10, overflow: "visible" }}
    >
      <g transform={`translate(${tx}, ${ty}) scale(${tz})`}>
        {families.map((family, idx) => (
          <FamilyRibbon
            key={family.kind}
            family={family}
            boxes={boxes}
            stackIndex={idx}
            stackTotal={families.length}
          />
        ))}
      </g>
    </svg>
  );
}

function FamilyRibbon({
  family,
  boxes,
  stackIndex,
  stackTotal,
}: {
  family: RibbonFamily;
  boxes: Map<string, NodeBox>;
  stackIndex: number;
  stackTotal: number;
}) {
  // When multiple kinds coexist the channels nudge up/down so they
  // don't perfectly overlap. Centered stack: with one kind the offset
  // is 0, which is the Loomscope case today.
  const yNudge = 8 * (stackIndex - (stackTotal - 1) / 2);

  const paths: string[] = [];

  // Inter-node arcs: parent right edge → child left edge at center y.
  // Side-to-side endpoints (not centers) match React Flow's edge
  // handles so the ribbon visually replaces / overlays the actual
  // continuation arrow.
  for (const [parentId, childId] of family.edges) {
    const a = boxes.get(parentId);
    const b = boxes.get(childId);
    if (!a || !b) continue;
    const p1 = { x: a.x + a.w, y: a.y + a.h / 2 + yNudge };
    const p2 = { x: b.x, y: b.y + b.h / 2 + yNudge };
    paths.push(sidewaysArc(p1, p2));
  }

  // Pass-through: when a node has BOTH incoming and outgoing edges in
  // this family, draw a straight horizontal line across the card at
  // center y. Without it the ribbon terminates at each card edge and
  // visually breaks at every node, losing the "this whole stretch ran
  // on the same model" affordance.
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const [p, c] of family.edges) {
    outgoing.add(p);
    incoming.add(c);
  }
  for (const nid of family.nodeIds) {
    if (!incoming.has(nid) || !outgoing.has(nid)) continue;
    const box = boxes.get(nid);
    if (!box) continue;
    const y = box.y + box.h / 2 + yNudge;
    paths.push(`M ${box.x} ${y} L ${box.x + box.w} ${y}`);
  }

  return (
    <g
      stroke={family.color}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {paths.map((d, i) => (
        <path key={i} d={d} strokeWidth={4} strokeOpacity={0.9} />
      ))}
    </g>
  );
}

/**
 * Cubic Bezier from (from) to (to) with horizontal control-point
 * tangents — same shape as React Flow's default Bezier edge. When
 * source and target share a y the curve degenerates to a horizontal
 * line, which is the desired result for linear LR-laid-out chains.
 */
function sidewaysArc(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  const cp1 = { x: from.x + dx * 0.5, y: from.y };
  const cp2 = { x: to.x - dx * 0.5, y: to.y };
  return `M ${from.x} ${from.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${to.x} ${to.y}`;
}
