// Main canvas — renders one ChatFlow as a horizontal DAG.
//
// React Flow handles viewport culling for us as long as nodes stay outside
// the visible rect; we don't add extra fold logic in v0.2 (planned for the
// "default-fold old ChatNodes" optimization once we hit perf walls per
// `requirements.md`).

import { useCallback, useMemo } from "react";

import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { layoutChatFlow } from "@/canvas/layoutDag";
import { ChatNodeCard } from "@/canvas/nodes/ChatNodeCard";
import { ContinuationArrowDefs, ContinuationEdge } from "@/canvas/edges/ContinuationEdge";
import type { ChatFlow } from "@/data/types";
import { useStore } from "@/store/index";

const nodeTypes: NodeTypes = { chatNode: ChatNodeCard };
const edgeTypes: EdgeTypes = { continuation: ContinuationEdge };

export interface ChatFlowCanvasProps {
  chatFlow: ChatFlow;
  sessionId: string;
}

export function ChatFlowCanvas({ chatFlow, sessionId }: ChatFlowCanvasProps) {
  const { nodes, edges } = useMemo(() => layoutChatFlow(chatFlow), [chatFlow]);
  const setSelected = useStore((s) => s.setSelected);
  const selectedNodeId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );

  const onNodeClick = useCallback(
    (_e: unknown, node: { id: string }) => {
      setSelected(sessionId, node.id);
    },
    [setSelected, sessionId],
  );

  // Drive selected via the `selected` flag passed to node renderers.
  const decoratedNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [nodes, selectedNodeId],
  );

  return (
    <div className="w-full h-full relative">
      <ReactFlowProvider>
        <svg width={0} height={0} style={{ position: "absolute" }}>
          <ContinuationArrowDefs />
        </svg>
        <ReactFlow
          nodes={decoratedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.0 }}
          minZoom={0.05}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="#e5e7eb" />
          <Controls position="bottom-right" />
          <MiniMap pannable zoomable className="!bg-white" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
