// WorkFlow canvas — drill-down view of one ChatNode's inner WorkFlow.
//
// Mounts when ``sessions[sid].drillStack`` top frame is a ``chatnode``.
// Renders the 5 WorkNode kinds (llm_call / tool_call / delegate /
// compact / attachment) as React Flow nodes with dagre LR layout,
// mirroring the ChatFlow canvas's chrome / handle behavior.
//
// Loomscope is a read-only viewer: nodes are not draggable / not
// connectable, layout is dagre-deterministic. Per-WorkFlow viewport
// state isn't persisted in v0.3 — fitView runs each time we drill in.
//
// v0.5 added ``subworkflow`` drill frames for sub-agent ChatFlows.
// v0.6 redo: subworkflow frames now resolve to a full sub-agent
// ChatFlow rendered by ChatFlowCanvas (recursive), not chatNodes[0]
// here — so the v0.5 amber multiChatNodeNotice banner is gone.

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
import {
  isWorkNodeRunning,
  useIsChatNodeRunning,
} from "@/store/livenessHooks";
import type { WorkNode } from "@/data/types";
import { ContinuationArrowDefs, ContinuationEdge } from "@/canvas/edges/ContinuationEdge";
import { SpawnArrowDefs, SpawnEdge } from "@/canvas/edges/SpawnEdge";
import { LlmCallCard } from "@/canvas/nodes/worknodes/LlmCallCard";
import { ToolCallCard } from "@/canvas/nodes/worknodes/ToolCallCard";
import { DelegateCard } from "@/canvas/nodes/worknodes/DelegateCard";
import { CompactCard } from "@/canvas/nodes/worknodes/CompactCard";
import { AttachmentCard } from "@/canvas/nodes/worknodes/AttachmentCard";
import type { ChatNode } from "@/data/types";
import { useStore } from "@/store/index";
import { useChatNodeWorkflow } from "@/store/workflowHooks";

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

function CanvasInner({ chatNode, sessionId }: WorkFlowCanvasProps) {
  // v0.10 lazy ChatFlow B4: workflow.nodes may be empty for top-level
  // ChatNodes (lite ChatFlow strips them). Hook fires the fetch and
  // gives us a ready WorkFlow once it lands. Sub-agent ChatNodes ship
  // workflow inline, so the hook resolves to ready synchronously.
  const access = useChatNodeWorkflow(sessionId, chatNode);
  // Layout off the ready workflow when present; otherwise use the
  // (possibly empty) inline workflow. layoutWorkFlow on an empty
  // workflow returns empty nodes/edges, which is exactly what we
  // want to render during pending state.
  const layoutChatNode = useMemo(() => {
    if (access.workflow) return { ...chatNode, workflow: access.workflow };
    return chatNode;
  }, [chatNode, access.workflow]);
  const { nodes: rawNodes, edges: rawEdges } = useMemo(
    () => layoutWorkFlow(layoutChatNode),
    [layoutChatNode],
  );
  // EN (v0.9.2 b): per-WorkNode running detection. The DRILLED
  // ChatNode's running state gates everything underneath — when the
  // user opens a static historical ChatNode, no internal node should
  // animate even if some old tool_call lacks a resultBlock (parser
  // edge case / aborted CC run). Each WorkNode then derives its own
  // running flag by data shape (tool_call.resultBlock missing,
  // delegate without status, llm_call without stopReason).
  // Decorate the layout output with `data.isRunning` so cards can
  // pulse without each subscribing to liveness selectors. Edges into
  // running WorkNodes get `data.running` for ContinuationEdge to
  // animate the dashed flow.
  // 中: WorkFlow 内部 per-WorkNode 运行态判定。drill 进的父 ChatNode
  // 是否在跑作为总开关；每个 WorkNode 再按数据形态推（无 resultBlock /
  // 无 status / 无 stopReason）。装饰 layout 结果让卡片读 data.isRunning
  // 跳动，到达运行节点的边读 data.running 显示流动虚线。
  const parentRunning = useIsChatNodeRunning(sessionId, chatNode.id);
  const nodes = useMemo(
    () =>
      rawNodes.map((rfn) => {
        const wn = (rfn.data as { workNode?: WorkNode } | undefined)?.workNode;
        if (!wn) return rfn;
        const running = isWorkNodeRunning(wn, parentRunning);
        if (!running && !(rfn.data as { isRunning?: boolean }).isRunning) {
          return rfn;
        }
        return { ...rfn, data: { ...rfn.data, isRunning: running } };
      }),
    [rawNodes, parentRunning],
  );
  const runningWorkNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const rfn of nodes) {
      if ((rfn.data as { isRunning?: boolean }).isRunning) set.add(rfn.id);
    }
    return set;
  }, [nodes]);
  const edges = useMemo(
    () =>
      rawEdges.map((e) =>
        runningWorkNodeIds.has(e.target)
          ? { ...e, data: { ...(e.data ?? {}), running: true } }
          : e,
      ),
    [rawEdges, runningWorkNodeIds],
  );
  const setSelected = useStore((s) => s.setWorkflowSelected);

  const onNodeClick = useCallback(
    (_e: unknown, node: { id: string }) => {
      setSelected(sessionId, node.id);
    },
    [setSelected, sessionId],
  );

  // v0.9.1: delegate sub-agent drill-in moved to an explicit button on
  // DelegateCard (SubAgentDrillButton) — both double-click (RF zoom)
  // and right-click (browser context menu intercepted before our
  // handler) failed in real browsers. Button is the only reliable
  // gesture. No canvas-level handler needed here.

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

  // v0.10 lazy ChatFlow B4: pending → loading overlay; error → error
  // hint. Distinguish from "genuinely empty WorkFlow" via `access.status`.
  if (access.status === "pending") {
    return (
      <div
        data-testid="workflow-canvas-loading"
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-400"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-teal-500" />
        <div className="text-sm">加载 WorkFlow…</div>
      </div>
    );
  }
  if (access.status === "error") {
    return (
      <div
        data-testid="workflow-canvas-error"
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-rose-600"
      >
        <span className="text-3xl">✗</span>
        <div className="text-sm">WorkFlow 加载失败</div>
        <code className="text-[11px] bg-rose-50 border border-rose-200 px-2 py-1 rounded font-mono max-w-[480px] break-words">
          {access.error}
        </code>
      </div>
    );
  }
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
    <ReactFlow
      data-testid="workflow-canvas"
      nodes={nodes}
      edges={decoratedEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
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
  );
}

// Re-export sizing constants for tests / consumers needing card widths.
export { WF_NODE_SIZE };
