// spawn edge — orange Bezier with hollow-triangle arrow head. Used in
// the WorkFlow layer when an llm_call's tool_use block "spawns" a
// tool_call / delegate child. Distinguished from continuation
// (gray, solid arrow) by hue + arrow shape per design-visual-language.md.

import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

const SPAWN_COLOR = "#f59e0b"; // amber-500
const RUNNING_COLOR = "#10b981"; // emerald-500

export function SpawnEdge(props: EdgeProps) {
  const [d] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.25,
  });
  // EN (v0.9.2): edge into a running tool_call → emerald + animated
  // dashed flow. Same convention as ContinuationEdge.
  // 中: 流向运行中工具节点的边 → emerald 流动虚线，跟 ContinuationEdge
  // 一致风格。
  const running = (props.data as { running?: boolean } | undefined)?.running;
  return (
    <BaseEdge
      id={props.id}
      path={d}
      className={running ? "loomscope-running-edge" : undefined}
      style={{
        stroke: running ? RUNNING_COLOR : SPAWN_COLOR,
        strokeWidth: running ? 2 : 1.5,
      }}
      markerEnd="url(#arrow-spawn)"
    />
  );
}

export function SpawnArrowDefs() {
  return (
    <defs>
      <marker
        id="arrow-spawn"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        {/* Hollow triangle — outline only — distinguishes spawn from
            continuation's solid filled arrow. */}
        <path
          d="M 0 0 L 10 5 L 0 10 z"
          fill="none"
          stroke={SPAWN_COLOR}
          strokeWidth="1.5"
        />
      </marker>
    </defs>
  );
}
