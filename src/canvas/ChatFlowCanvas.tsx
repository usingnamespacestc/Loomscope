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
  useStore as useReactFlowStore,
  type Edge,
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { layoutChatFlow } from "@/canvas/layoutDag";
import { ModelRibbonLayer } from "@/canvas/ModelRibbonLayer";
import { ChatFoldNodeCard } from "@/canvas/nodes/ChatFoldNodeCard";
import { ChatNodeCard } from "@/canvas/nodes/ChatNodeCard";
import { ContinuationArrowDefs, ContinuationEdge } from "@/canvas/edges/ContinuationEdge";
import {
  FoldAnchorContext,
  type FoldAnchorAPI,
} from "@/canvas/FoldAnchorContext";
import { isChatFoldId } from "@/canvas/foldProjection";
import type { ChatFlow } from "@/data/types";
import { useStore } from "@/store/index";

const nodeTypes: NodeTypes = {
  chatNode: ChatNodeCard,
  chatFold: ChatFoldNodeCard,
};
const edgeTypes: EdgeTypes = {
  continuation: ContinuationEdge,
};

export interface ChatFlowCanvasProps {
  chatFlow: ChatFlow;
  sessionId: string;
}

interface HoveredEdgeState {
  parent: string;
  child: string;
  targetModel?: string;
}

export function ChatFlowCanvas({ chatFlow, sessionId }: ChatFlowCanvasProps) {
  // Edge hover tooltip state — lives at the wrapper level so the tooltip
  // can render outside ReactFlow as a fixed-position overlay. The
  // ribbon overlay reads it from inside CanvasInner via prop.
  const [hoveredEdge, setHoveredEdge] = useState<HoveredEdgeState | null>(null);
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
          hoveredEdge={hoveredEdge}
          onEdgeHover={setHoveredEdge}
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

// Why this tooltip only shows `model` and not effort / fast-mode:
//
// We considered surfacing the request's reasoning effort and a
// `fast mode` flag (toggled by `/fast`, opus-4-6 only) alongside the
// model name. After scanning every assistant record across every
// CC jsonl on disk, the assistant message field set is exactly:
//
//   container, content, context_management, diagnostics, id, model,
//   role, stop_details, stop_reason, stop_sequence, type, usage
//
// Content blocks only carry `text / thinking / tool_use`. There is
// no `effort`, `reasoning_effort`, `thinking_budget`, `fast_mode`, or
// `[1m]`-style suffix anywhere — CC strips request-side parameters
// before persisting, leaving just the bare model id (e.g.
// `claude-opus-4-7`). Fast mode in particular is a UI-only toggle
// that doesn't show up in the request snapshot at all.
//
// We could have added placeholder rows that always render as "—",
// but that's pretending we have data we don't. If a future CC
// version starts writing these fields, extend `targetModel` in
// `layoutDag.ts` to a richer struct and add the rows here.
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
  hoveredEdge: HoveredEdgeState | null;
  onEdgeHover: (e: HoveredEdgeState | null) => void;
}

function CanvasInner({ chatFlow, sessionId, hoveredEdge, onEdgeHover }: CanvasInnerProps) {
  // Subscribe to the active session's foldedCompactIds so layout
  // recomputes whenever the user folds / unfolds a compact. We
  // intentionally pass the SAME chatFlow ref through to layout —
  // recomputing layout while the underlying flow is unchanged is the
  // intended design (fold projection is a function of fold state).
  // For sub-ChatFlow drill (sub-agent canvas) the same store id keys
  // the fold set; the inner ChatFlow has its own compact ids that are
  // disjoint from the top-level set, so the same hydrated set works
  // unmodified — non-existent ids are filtered by the projection's
  // empty-range guard.
  const foldedCompactIds = useStore(
    (s) => s.sessions.get(sessionId)?.foldedCompactIds,
  );
  const { nodes, edges } = useMemo(
    () => layoutChatFlow(chatFlow, foldedCompactIds),
    [chatFlow, foldedCompactIds],
  );
  const setSelected = useStore((s) => s.setSelected);
  const onNodeClick = useCallback(
    (_e: unknown, node: { id: string }) => {
      // chatFold phantoms aren't real ChatNodes — skip selection so
      // DrillPanel doesn't try to look up a non-existent ChatNode by
      // the phantom id. The card itself stops propagation on click,
      // but defense-in-depth here covers keyboard activation paths.
      if (isChatFoldId(node.id)) return;
      setSelected(sessionId, node.id);
    },
    [setSelected, sessionId],
  );

  const rf = useReactFlow();

  // Viewport-anchored fold/unfold. See FoldAnchorContext.tsx for the
  // why; the implementation here is a two-phase capture/apply:
  //   1. Before the store mutation, read the host compact's CURRENT
  //      absolute layout position via rf.getNode(...) and convert it
  //      to screen-space using the current viewport. Stash {compactId,
  //      screenX, screenY} in a ref.
  //   2. After the next render commits (useEffect on [nodes]) — i.e.
  //      after layoutChatFlow re-ran with the new fold set and React
  //      Flow ingested the new node positions — read the host's NEW
  //      absolute position, compute the delta in screen space, shift
  //      the viewport by the delta. Clear the ref so subsequent
  //      unrelated layout changes (e.g., cross-session switch) don't
  //      try to re-anchor.
  //
  // The host compact ChatNode is the semantic anchor: it's visible
  // both before and after every fold toggle that the user can trigger
  // from the canvas (fold a compact → host stays and chatFold
  // appears upstream; unfold from chatFold → host stays and chatFold
  // disappears). When the host is absent in the new layout (rare
  // cross-fold cases — outer fold absorbed it after a separate
  // mutation), we silently abandon the anchor rather than guessing.
  const toggleAction = useStore((s) => s.toggleCompactFold);
  const foldAction = useStore((s) => s.foldCompact);
  const unfoldAction = useStore((s) => s.unfoldCompact);
  const anchorRef = useRef<{
    compactId: string;
    screenX: number;
    screenY: number;
  } | null>(null);

  const captureAnchor = useCallback(
    (compactId: string) => {
      const node = rf.getNode(compactId);
      if (!node) return;
      const vp = rf.getViewport();
      // Use ``positionAbsolute`` if available (= computed by RF after
      // measurement); fall back to ``position`` (= our dagre-written
      // layout coords) when measurement hasn't completed. Both match
      // top-left corner so the screen-space conversion is consistent.
      const ax = node.position.x;
      const ay = node.position.y;
      anchorRef.current = {
        compactId,
        screenX: ax * vp.zoom + vp.x,
        screenY: ay * vp.zoom + vp.y,
      };
    },
    [rf],
  );

  const foldAnchor = useMemo<FoldAnchorAPI>(
    () => ({
      toggle: (compactId: string) => {
        captureAnchor(compactId);
        toggleAction(sessionId, compactId);
      },
      fold: (compactId: string) => {
        captureAnchor(compactId);
        foldAction(sessionId, compactId);
      },
      unfold: (compactId: string) => {
        captureAnchor(compactId);
        unfoldAction(sessionId, compactId);
      },
    }),
    [captureAnchor, sessionId, toggleAction, foldAction, unfoldAction],
  );

  // No `decoratedNodes` indirection: ChatNodeCard subscribes to its own
  // selected boolean via `useIsChatNodeSelected(id)`. Wrapping nodes with
  // a fresh `{ ...n, selected: ... }` per click meant React Flow saw
  // 1500 new identities and reconciled the whole graph (458 ms on 256MB
  // session in v0.4). Per-card subscription cuts that to 2 re-renders.

  // We need to know when xyflow has actually measured the latest card
  // before firing fitView — without measurements `fitView({ nodes: [{
  // id }] })` reads an empty bbox and silently no-ops, which is what
  // was leaving the viewport at the default origin on session-open
  // and on hard refresh.
  //
  // The naive choice — `useNodesInitialized()` — looks like it does
  // the job but actually stays `false` forever in Loomscope: it
  // returns the store's `s.nodesInitialized` flag, which is only
  // recomputed when xyflow re-runs `adoptUserNodes`, which only
  // happens when the user-supplied `nodes` prop is replaced with one
  // that carries `measured` back. Loomscope is viewer-only with no
  // `onNodesChange`, so the round-trip never happens — measurements
  // land on the InternalNode in `s.nodeLookup` but the flag never
  // updates. Instead, subscribe directly to the latest node's
  // measured-dimensions presence in `nodeLookup`. That selector
  // re-runs whenever `updateNodeInternals` calls `set({})` after a
  // ResizeObserver hit, and its boolean result flips false→true the
  // moment our target card is ready — which is exactly the trigger
  // we want.
  // Pick the latest visible REAL ChatNode (skip chatFold phantoms) so
  // first-paint fitView centres on the most recent turn the user was
  // actually conversing in, not on a fold placeholder upstream.
  const latestNodeId = (() => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const n = nodes[i];
      if (n.type === "chatNode") return n.id;
    }
    return null;
  })();
  const latestNodeMeasured = useReactFlowStore((s: ReactFlowState) => {
    if (!latestNodeId) return false;
    const n = s.nodeLookup.get(latestNodeId);
    return n?.measured.width !== undefined && n?.measured.height !== undefined;
  });
  // Focus on the latest ChatNode when the user opens a different session.
  // Re-running on every chatFlow change is intentional — for v0.2 a
  // chatFlow change == "user picked a different session". When v0.7
  // file-tail lands, this dependency should narrow to chatFlow.id so
  // incremental updates don't yank the viewport away from the user.
  const focusedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestNodeMeasured) return;
    if (!latestNodeId) return;
    if (focusedSessionRef.current === chatFlow.id) return;
    rf.fitView({
      nodes: [{ id: latestNodeId }],
      padding: 0.4,
      maxZoom: 1.0,
      minZoom: 0.5,
      duration: 0,
    });
    focusedSessionRef.current = chatFlow.id;
  }, [chatFlow.id, latestNodeId, latestNodeMeasured, rf]);

  // Apply the captured fold anchor: after every layout commit (= nodes
  // identity changed), if a fold/unfold has just stashed an anchor,
  // shift the viewport so the host compact lands at its previous
  // screen position. The ref is cleared after each application so an
  // unrelated layout change (cross-session switch, etc.) doesn't
  // re-anchor.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const newNode = rf.getNode(anchor.compactId);
    if (!newNode) {
      anchorRef.current = null;
      return;
    }
    const vp = rf.getViewport();
    const newScreenX = newNode.position.x * vp.zoom + vp.x;
    const newScreenY = newNode.position.y * vp.zoom + vp.y;
    rf.setViewport({
      x: vp.x + (anchor.screenX - newScreenX),
      y: vp.y + (anchor.screenY - newScreenY),
      zoom: vp.zoom,
    });
    anchorRef.current = null;
  }, [nodes, rf]);

  return (
    <FoldAnchorContext.Provider value={foldAnchor}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onEdgeMouseEnter={(_e, edge: Edge) =>
        onEdgeHover({
          parent: edge.source,
          child: edge.target,
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
      <ModelRibbonLayer
        chatFlow={chatFlow}
        hoveredEdge={
          hoveredEdge ? { parent: hoveredEdge.parent, child: hoveredEdge.child } : null
        }
      />
    </ReactFlow>
    </FoldAnchorContext.Provider>
  );
}
