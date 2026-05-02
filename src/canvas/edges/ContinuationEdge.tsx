// continuation edge — Bezier curve (matches Agentloom; smooth-step was
// too "right-angle"). solid slate-400 stroke + filled arrow head.

import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

export function ContinuationEdge(props: EdgeProps) {
  const [d] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.25,
  });
  return <BaseEdge id={props.id} path={d} style={{ stroke: "#94a3b8", strokeWidth: 1.5 }} markerEnd="url(#arrow-continuation)" />;
}

// Shared marker definition — mounted once near the canvas root.
export function ContinuationArrowDefs() {
  return (
    <defs>
      <marker
        id="arrow-continuation"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
      </marker>
    </defs>
  );
}
