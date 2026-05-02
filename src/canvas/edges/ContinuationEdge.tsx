// continuation edge — solid gray with a filled arrow. Per
// `design-visual-language.md` "v0 实现 (3 类)" table.
//
// We render with the React Flow default arrow marker since our colors
// already disambiguate from `spawn` (orange/triangle, v0.3+ when WorkFlow
// shows up).

import { BaseEdge, getSmoothStepPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

export function ContinuationEdge(props: EdgeProps) {
  const [d] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
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
