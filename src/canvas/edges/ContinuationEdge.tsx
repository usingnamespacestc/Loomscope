// EN: continuation edge — neutral slate-400 Bezier curve. Per-model
// colored ribbon overlay (ModelRibbonLayer) shows only on edge hover.
// v0.9.1 Task 3: when `data.running === true`, edge becomes animated
// dashed (running keyframe in index.css `.loomscope-running-edge`)
// + emerald color so the eye is drawn to the in-flight tail.
// 中: continuation 边——slate-400 贝塞尔曲线。data.running=true 时
// 切换成流动虚线（emerald）作为"正在跑"提示。

import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

const ARROW_COLOR = "#94a3b8"; // slate-400
const RUNNING_COLOR = "#10b981"; // emerald-500

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
  const running = (props.data as { running?: boolean } | undefined)?.running;
  return (
    <BaseEdge
      id={props.id}
      path={d}
      className={running ? "loomscope-running-edge" : undefined}
      style={{
        stroke: running ? RUNNING_COLOR : ARROW_COLOR,
        strokeWidth: running ? 2 : 1.5,
      }}
      markerEnd="url(#arrow-continuation)"
    />
  );
}

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
        <path d="M 0 0 L 10 5 L 0 10 z" fill={ARROW_COLOR} />
      </marker>
    </defs>
  );
}
