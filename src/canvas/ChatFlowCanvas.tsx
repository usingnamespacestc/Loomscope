// Main canvas — renders one ChatFlow as a horizontal DAG.
//
// On session open, we focus on the *latest* ChatNode (rightmost in LR
// layout, last by timestamp) at zoom=1, instead of fitView's "show all
// at once" behavior. fitView for a 1500-node session shrinks each card
// to a few pixels — useless. The latest turn is what users want to see
// when opening the canvas; older turns can be reached via pan/zoom or
// keyboard navigation.
//
// React Flow handles viewport culling for us as long as nodes stay outside
// the visible rect; we don't add extra fold logic in v0.2 (planned for the
// "default-fold old ChatNodes" optimization once we hit perf walls per
// `requirements.md`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { layoutChatFlow } from "@/canvas/layoutDag";
import { ModelRibbonLayer } from "@/canvas/ModelRibbonLayer";
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
  // Edge hover tooltip state — lives at the wrapper level so the tooltip
  // can render outside ReactFlow as a fixed-position overlay.
  const [hoveredEdge, setHoveredEdge] = useState<{
    source: string;
    target: string;
    targetModel?: string;
  } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  // Track cursor position only while an edge is hovered — avoids paying
  // for global mousemove the rest of the time. (Pattern lifted from
  // Agentloom ChatFlowCanvas.)
  useEffect(() => {
    if (!hoveredEdge) {
      setCursorPos(null);
      return;
    }
    const onMove = (e: MouseEvent) => setCursorPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [hoveredEdge]);

  return (
    <div className="w-full h-full relative">
      <ReactFlowProvider>
        <svg width={0} height={0} style={{ position: "absolute" }}>
          <ContinuationArrowDefs />
        </svg>
        <CanvasInner
          chatFlow={chatFlow}
          sessionId={sessionId}
          onEdgeHover={setHoveredEdge}
        />
        <ModelRibbonLayer
          chatFlow={chatFlow}
          hoveredEdge={
            hoveredEdge
              ? { source: hoveredEdge.source, target: hoveredEdge.target }
              : null
          }
        />
      </ReactFlowProvider>

      {hoveredEdge && cursorPos && (
        <EdgeModelTooltip
          targetModel={hoveredEdge.targetModel}
          x={cursorPos.x}
          y={cursorPos.y}
        />
      )}
    </div>
  );
}

function EdgeModelTooltip({
  targetModel,
  x,
  y,
}: {
  targetModel?: string;
  x: number;
  y: number;
}) {
  return (
    <div
      data-testid="edge-model-tooltip"
      className="pointer-events-none fixed z-50 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] shadow-lg whitespace-nowrap"
      style={{ left: x + 12, top: y + 12 }}
    >
      <span className="text-gray-500 mr-1">model</span>
      <span className="font-mono text-gray-900">{targetModel ?? "—"}</span>
    </div>
  );
}

interface CanvasInnerProps extends ChatFlowCanvasProps {
  onEdgeHover: (
    e: { source: string; target: string; targetModel?: string } | null,
  ) => void;
}

function CanvasInner({ chatFlow, sessionId, onEdgeHover }: CanvasInnerProps) {
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

  const rf = useReactFlow();
  // Focus on the latest ChatNode when the user opens a different session.
  // Re-running on every chatFlow change is intentional — for v0.2 a
  // chatFlow change == "user picked a different session". When v0.7
  // file-tail lands, this dependency should narrow to chatFlow.id so
  // incremental updates don't yank the viewport away from the user.
  const focusedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (nodes.length === 0) return;
    if (focusedSessionRef.current === chatFlow.id) return;
    const latest = nodes[nodes.length - 1]; // chatNodes are timestamp-sorted asc
    rf.fitView({
      nodes: [{ id: latest.id }],
      padding: 0.4,
      maxZoom: 1.0,
      minZoom: 0.5,
      duration: 0,
    });
    focusedSessionRef.current = chatFlow.id;
  }, [chatFlow.id, nodes, rf]);

  return (
    <ReactFlow
      nodes={decoratedNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onEdgeMouseEnter={(_e, edge: Edge) =>
        onEdgeHover({
          source: edge.source,
          target: edge.target,
          targetModel: (edge.data as { targetModel?: string } | undefined)?.targetModel,
        })
      }
      onEdgeMouseLeave={() => onEdgeHover(null)}
      minZoom={0.05}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      // Viewer mode: layout is dagre-deterministic, no manual edits.
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
