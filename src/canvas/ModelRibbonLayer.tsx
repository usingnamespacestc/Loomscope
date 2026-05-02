// SVG overlay drawn on top of the React Flow canvas when an edge is
// hovered. Highlights every edge that uses the same model as the
// hovered edge — gives a "this whole stretch ran on Opus / Sonnet"
// glance without forcing the user to drill into individual cards.
//
// Ported from Agentloom ModelRibbonLayer.tsx; simplified: Loomscope
// has only one model kind per ChatNode (no draft/judge/tool split),
// so we draw one family / one color.

import { useMemo } from "react";

import { useStore, type ReactFlowState } from "@xyflow/react";

import type { ChatFlow } from "@/data/types";

import { computeModelFamily, type ModelFamily } from "./modelFamilies";

const CARD_FALLBACK_W = 208; // matches w-52 ChatNodeCard
const CARD_FALLBACK_H = 140;

interface NodeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rfNodesSelector = (s: ReactFlowState) => s.nodes;
const rfTransformSelector = (s: ReactFlowState) => s.transform;

export interface HoveredEdge {
  source: string;
  target: string;
}

export function ModelRibbonLayer({
  chatFlow,
  hoveredEdge,
}: {
  chatFlow: ChatFlow;
  hoveredEdge: HoveredEdge | null;
}) {
  const rfNodes = useStore(rfNodesSelector);
  const transform = useStore(rfTransformSelector);

  const boxes = useMemo(() => {
    const m = new Map<string, NodeBox>();
    for (const n of rfNodes) {
      m.set(n.id, {
        x: n.position.x,
        y: n.position.y,
        w: n.width ?? n.measured?.width ?? CARD_FALLBACK_W,
        h: n.height ?? n.measured?.height ?? CARD_FALLBACK_H,
      });
    }
    return m;
  }, [rfNodes]);

  const family = useMemo<ModelFamily | null>(() => {
    if (!hoveredEdge) return null;
    return computeModelFamily(chatFlow, hoveredEdge.source, hoveredEdge.target);
  }, [chatFlow, hoveredEdge]);

  if (!hoveredEdge || !family) return null;

  const [tx, ty, tz] = transform;

  return (
    <svg
      data-testid="model-ribbon-layer"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 10, overflow: "visible" }}
    >
      <g transform={`translate(${tx}, ${ty}) scale(${tz})`}>
        <FamilyRibbon family={family} boxes={boxes} />
      </g>
    </svg>
  );
}

function FamilyRibbon({
  family,
  boxes,
}: {
  family: ModelFamily;
  boxes: Map<string, NodeBox>;
}) {
  const paths: string[] = [];

  // Inter-node arcs (parent right edge → child left edge).
  for (const [parentId, childId] of family.edges) {
    const a = boxes.get(parentId);
    const b = boxes.get(childId);
    if (!a || !b) continue;
    const p1 = { x: a.x + a.w, y: a.y + a.h / 2 };
    const p2 = { x: b.x, y: b.y + b.h / 2 };
    paths.push(sidewaysArc(p1, p2));
  }

  // Pass-through: nodes with both incoming + outgoing edges in this
  // family get a horizontal line through them, so the ribbon visually
  // "贯穿" the card without breaking at every node.
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
    const y = box.y + box.h / 2;
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
        <path key={i} d={d} strokeWidth={4} strokeOpacity={0.85} />
      ))}
    </g>
  );
}

/** Cubic Bezier from a point to another with horizontal control-point
 * tangents. Same shape as React Flow's default bezier edge so the
 * ribbon overlays the actual edge cleanly. */
function sidewaysArc(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = to.x - from.x;
  const cp1 = { x: from.x + dx * 0.5, y: from.y };
  const cp2 = { x: to.x - dx * 0.5, y: to.y };
  return `M ${from.x} ${from.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${to.x} ${to.y}`;
}
