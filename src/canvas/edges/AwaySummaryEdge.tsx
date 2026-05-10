// EN (v1.2 R5): dashed amber edge linking a synthetic awaySummary
// node to its host ChatNode. Visually it's an *anchor*, not a data
// flow — no arrowhead, lightweight stroke, dashed pattern. The
// existence of the edge tells the user "this summary belongs to
// that turn"; direction isn't meaningful.
//
// 中: awaySummary 合成节点跟 host ChatNode 之间的虚线锚边——只是
// "这个 summary 属于下面那个 turn" 的视觉关联，不带箭头。

import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

const STROKE = "#f59e0b"; // amber-500 — matches AwaySummaryNodeCard chrome.

export function AwaySummaryEdge(props: EdgeProps) {
  const [d] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.2,
  });
  return (
    <BaseEdge
      id={props.id}
      path={d}
      style={{
        stroke: STROKE,
        strokeWidth: 1.25,
        strokeDasharray: "3 3",
        opacity: 0.6,
      }}
    />
  );
}
