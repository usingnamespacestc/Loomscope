// WorkFlow canvas — drill-down view of one ChatNode's inner WorkFlow.
//
// Mounts when ``sessions[sid].drillStack`` is non-empty. Renders the
// 5 WorkNode kinds (llm_call / tool_call / delegate / compact /
// attachment) as React Flow nodes with dagre LR layout, mirroring the
// ChatFlow canvas's chrome / handle behavior.
//
// Loomscope is a read-only viewer: nodes are not draggable / not
// connectable, layout is dagre-deterministic. Per-WorkFlow viewport
// state isn't persisted in v0.3 — fitView runs each time we drill in.
// (v0.5 sub-agent真嵌套 will add ``subworkflow`` drill frames; this
// component already keys its layout memo on the resolved WorkFlow so
// nesting is a free upgrade.)

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useReactFlowStore,
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { layoutWorkFlow, WF_NODE_SIZE } from "@/canvas/layoutWorkflow";
import { ContinuationArrowDefs, ContinuationEdge } from "@/canvas/edges/ContinuationEdge";
import { SpawnArrowDefs, SpawnEdge } from "@/canvas/edges/SpawnEdge";
import { LlmCallCard } from "@/canvas/nodes/worknodes/LlmCallCard";
import { ToolCallCard } from "@/canvas/nodes/worknodes/ToolCallCard";
import { DelegateCard } from "@/canvas/nodes/worknodes/DelegateCard";
import { CompactCard } from "@/canvas/nodes/worknodes/CompactCard";
import { AttachmentCard } from "@/canvas/nodes/worknodes/AttachmentCard";
import type { ChatNode } from "@/data/types";
import { useStore } from "@/store/index";

const nodeTypes: NodeTypes = {
  llm_call: LlmCallCard,
  tool_call: ToolCallCard,
  delegate: DelegateCard,
  compact: CompactCard,
  attachment: AttachmentCard,
};

const edgeTypes: EdgeTypes = {
  continuation: ContinuationEdge,
  spawn: SpawnEdge,
};

export interface WorkFlowCanvasProps {
  chatNode: ChatNode;
  sessionId: string;
  // v0.5: when the active drill frame is a sub-agent whose ChatFlow
  // has more than one ChatNode, surface a banner explaining we're
  // showing only the first. Multi-ChatNode rendering is v0.5.1 backlog.
  multiChatNodeNotice?: { totalChatNodes: number } | null;
}

export function WorkFlowCanvas(props: WorkFlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <ContinuationArrowDefs />
        <SpawnArrowDefs />
      </svg>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ chatNode, sessionId, multiChatNodeNotice }: WorkFlowCanvasProps) {
  const { nodes, edges } = useMemo(() => layoutWorkFlow(chatNode), [chatNode]);
  const setSelected = useStore((s) => s.setWorkflowSelected);
  const enterSubWorkflow = useStore((s) => s.enterSubWorkflow);

  const onNodeClick = useCallback(
    (_e: unknown, node: { id: string }) => {
      setSelected(sessionId, node.id);
    },
    [setSelected, sessionId],
  );

  // Double-click on a delegate WorkNode → drill into its sub-WorkFlow.
  // Other kinds ignore double-click (no behavior change). The store
  // action handles the agentId resolution + lazy load + dedupe.
  const onNodeDoubleClick = useCallback(
    (_e: unknown, node: { id: string; type?: string }) => {
      if (node.type !== "delegate") return;
      enterSubWorkflow(sessionId, node.id);
    },
    [enterSubWorkflow, sessionId],
  );

  // No `decoratedNodes` indirection: each WorkNode card subscribes to
  // its own selected boolean via `useIsWorkNodeSelected(id)`. See the
  // ChatFlowCanvas counterpart for the perf rationale.

  // Edges carry their own markers via the per-kind components
  // (ContinuationEdge → `arrow-continuation` filled, SpawnEdge →
  // `arrow-spawn` hollow triangle). Don't override `markerEnd` here:
  // doing so via MarkerType.ArrowClosed forces every arrow to be
  // filled, which violates the spawn = hollow-triangle rule in
  // design-visual-language.md (`A ──▷ B` for spawn vs `A ──▶ B` for
  // continuation). Custom SVG markers scale with the viewport
  // transform just fine — we get filled / hollow distinction without
  // sacrificing zoom rescaling.
  const decoratedEdges = edges;

  // Auto fitView on drill-in. Sized so the largest WorkFlow renders
  // visibly; React Flow's fitView rescales to fit all measured nodes.
  // We re-fit only when the ChatNode id changes (= a different drill);
  // viewport state across drill-out/in isn't persisted in v0.3.
  const rf = useReactFlow();
  const firstNodeId = nodes.length > 0 ? nodes[0].id : null;
  const firstNodeMeasured = useReactFlowStore((s: ReactFlowState) => {
    if (!firstNodeId) return false;
    const n = s.nodeLookup.get(firstNodeId);
    return n?.measured.width !== undefined && n?.measured.height !== undefined;
  });
  const fittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!firstNodeMeasured) return;
    if (fittedRef.current === chatNode.id) return;
    rf.fitView({ padding: 0.2, maxZoom: 1.1, minZoom: 0.3, duration: 0 });
    fittedRef.current = chatNode.id;
  }, [chatNode.id, firstNodeMeasured, rf]);

  if (nodes.length === 0) {
    return (
      <div
        data-testid="workflow-canvas-empty"
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-400"
      >
        <span className="text-3xl opacity-40">⌬</span>
        <div className="text-sm">该 ChatNode 没有 WorkFlow 节点</div>
        <div className="text-[11px] text-gray-300">
          (slash command / compact summary / 空 turn)
        </div>
      </div>
    );
  }

  return (
    <>
      <ReactFlow
        data-testid="workflow-canvas"
        nodes={nodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={true}
        deleteKeyCode={null}
        panOnDrag={true}
      >
        <Background gap={24} size={1} color="#d1d5db" />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!shadow-md !border !border-gray-200"
        />
      </ReactFlow>
      {multiChatNodeNotice && (
        <div
          data-testid="multi-chatnode-notice"
          className="absolute right-3 top-3 z-20 rounded border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 shadow-sm max-w-[280px]"
          title="Multi-ChatNode sub-agent rendering is deferred to v0.5.1"
        >
          ⚠ Sub-agent has {multiChatNodeNotice.totalChatNodes} ChatNodes; showing the first
        </div>
      )}
    </>
  );
}

// Re-export sizing constants for tests / consumers needing card widths.
export { WF_NODE_SIZE };
