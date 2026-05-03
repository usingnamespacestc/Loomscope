// SVG overlay drawn on top of the React Flow canvas when ANY edge is
// hovered. Visualizes the model usage range: groups all ChatNodes by
// model, draws one smooth Catmull-Rom spline per group through the
// centers of those ChatNodes (in chronological order). Different
// models show as different colored ribbons simultaneously.
//
// Why "hover any edge triggers all ribbons" not "hover edge highlights
// only that family":
//   - User asked for "different models, different colors". Showing
//     only one family at a time hides the comparative info.
//   - Always-on coloring is too noisy.
//   - Hover any edge → show full picture for the chain → off when not
//     hovering. Cheap, focused.
//
// Why "through centers" not "card-edge to card-edge + horizontal
// pass-through": the segmented approach broke at every card boundary
// and pass-through lines were obscured by card bg. A single smooth
// curve through centers reads as "this whole stretch ran on X" at a
// glance.

import { useMemo } from "react";

import { useStore, type ReactFlowState } from "@xyflow/react";

import type { ChatFlow, ChatNode } from "@/data/types";

import { colorForModel } from "./modelColor";

const CARD_FALLBACK_W = 208; // matches w-52 ChatNodeCard
const CARD_FALLBACK_H = 140;

const rfNodesSelector = (s: ReactFlowState) => s.nodes;
const rfTransformSelector = (s: ReactFlowState) => s.transform;

interface NodePoint {
  id: string;
  x: number; // center x
  y: number; // center y
}

interface ModelGroup {
  model: string | undefined; // undefined when target had no llm_call
  color: string;
  centers: NodePoint[]; // chatnode centers, ordered by source list order
}

function lastModelOf(cn: ChatNode): string | undefined {
  const llms = cn.workflow.nodes.filter((n) => n.kind === "llm_call");
  if (llms.length === 0) return undefined;
  const last = llms[llms.length - 1];
  return last.kind === "llm_call" ? last.model : undefined;
}

export function ModelRibbonLayer({
  chatFlow,
  hoveredEdgeId,
}: {
  chatFlow: ChatFlow;
  hoveredEdgeId: string | null;
}) {
  const rfNodes = useStore(rfNodesSelector);
  const transform = useStore(rfTransformSelector);

  // Build chatNodeId → center point map from React Flow's measured boxes.
  const centerById = useMemo(() => {
    const m = new Map<string, NodePoint>();
    for (const n of rfNodes) {
      const w = n.width ?? n.measured?.width ?? CARD_FALLBACK_W;
      const h = n.height ?? n.measured?.height ?? CARD_FALLBACK_H;
      m.set(n.id, { id: n.id, x: n.position.x + w / 2, y: n.position.y + h / 2 });
    }
    return m;
  }, [rfNodes]);

  const groups = useMemo<ModelGroup[]>(() => {
    if (!hoveredEdgeId) return [];
    // Group chatNodes by their model (last llm_call.model). Order
    // within each group preserves chatFlow.chatNodes order (which is
    // timestamp-ascending — buildChatFlow sorts).
    const byModel = new Map<string | undefined, ModelGroup>();
    for (const cn of chatFlow.chatNodes) {
      const center = centerById.get(cn.id);
      if (!center) continue; // not yet measured
      const model = lastModelOf(cn);
      let g = byModel.get(model);
      if (!g) {
        g = { model, color: colorForModel(model), centers: [] };
        byModel.set(model, g);
      }
      g.centers.push(center);
    }
    return Array.from(byModel.values()).filter((g) => g.centers.length >= 2);
    // Filter < 2: a single-node "group" has no ribbon to draw.
  }, [hoveredEdgeId, chatFlow, centerById]);

  if (!hoveredEdgeId || groups.length === 0) return null;

  const [tx, ty, tz] = transform;

  return (
    <svg
      data-testid="model-ribbon-layer"
      className="pointer-events-none absolute inset-0 h-full w-full"
      // z-index above xyflow's stacking (renderer=4, selection=6,
      // connection-line=1001) so the ribbon is visibly drawn ON TOP
      // of cards as it passes through their centers. With a lower
      // z-index the curve is hidden behind cards and the visible
      // gap-segments collapse to the same look as the old "side-to-
      // side" approach — which is what we're trying to leave behind.
      style={{ zIndex: 1100, overflow: "visible" }}
    >
      <g transform={`translate(${tx}, ${ty}) scale(${tz})`}>
        {groups.map((g, i) => (
          <RibbonPath key={g.model ?? `none-${i}`} group={g} />
        ))}
      </g>
    </svg>
  );
}

function RibbonPath({ group }: { group: ModelGroup }) {
  const d = catmullRomPath(group.centers);
  if (!d) return null;
  return (
    <path
      d={d}
      stroke={group.color}
      strokeWidth={5}
      strokeOpacity={0.55}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

/**
 * Catmull-Rom spline through `points` rendered as a sequence of cubic
 * Bezier segments. Tension = 0.5 (standard).
 *
 * Each interior segment Pi → Pi+1 uses control points derived from the
 * neighbors Pi-1 and Pi+2:
 *   c1 = Pi + (Pi+1 - Pi-1) / 6
 *   c2 = Pi+1 - (Pi+2 - Pi) / 6
 * For the endpoints we duplicate Pi/Pi+1 so the formula stays valid.
 */
function catmullRomPath(points: NodePoint[]): string | null {
  if (points.length < 2) return null;
  const parts: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    parts.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`);
  }
  return parts.join(" ");
}
