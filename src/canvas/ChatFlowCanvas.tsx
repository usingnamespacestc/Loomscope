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

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

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

import { CanvasPanContext } from "@/canvas/CanvasPanContext";
import { useConversationScrollShim } from "@/canvas/ConversationScrollContext";
import {
  useLatestChatNodeId,
  useSessionLiveness,
} from "@/store/livenessHooks";
import { NODE_HEIGHT, NODE_WIDTH, layoutChatFlow } from "@/canvas/layoutDag";
import { ModelRibbonLayer } from "@/canvas/ModelRibbonLayer";
import { ChatFoldNodeCard } from "@/canvas/nodes/ChatFoldNodeCard";
import { ChatNodeCard } from "@/canvas/nodes/ChatNodeCard";
import { ContinuationArrowDefs, ContinuationEdge } from "@/canvas/edges/ContinuationEdge";
import {
  FoldAnchorContext,
  type FoldAnchorAPI,
} from "@/canvas/FoldAnchorContext";
import { computeUnfoldChainTo, isChatFoldId } from "@/canvas/foldProjection";
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

// EN: Pan the viewport so the node's CENTER lands at the screen
// center while preserving zoom. RF's `node.position` is the
// TOP-LEFT corner; for setCenter we need the center, so add half
// the node's measured dimensions. When the node hasn't been
// measured yet (just unfolded, DOM not yet sized), fall back to
// the layout constants — same dimensions dagre used during
// placement, so the estimate is close to the real card. Without
// this fallback, `node.measured?.width ?? 0` collapsed to zero
// and setCenter received the top-left point as the center → card
// landed in the bottom-right quadrant of the viewport.
// 中: 把 viewport pan 到节点中心。RF 的 node.position 是左上角，
// 计算中心需要加半个 width/height。卡片刚出现 DOM 没量过时
// fallback 到 layout 常量（dagre 用的也是这些），否则 ?? 0
// 会让 setCenter 拿到左上角当中心，卡片显示在视口右下方。
function panToNodeCenter(
  rf: ReturnType<typeof useReactFlow>,
  node: { position: { x: number; y: number }; measured?: { width?: number; height?: number } },
): void {
  const w = node.measured?.width ?? NODE_WIDTH;
  const h = node.measured?.height ?? NODE_HEIGHT;
  const vp = rf.getViewport();
  rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
    zoom: vp.zoom,
    duration: 200,
  });
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
  const { nodes, edges: rawEdges } = useMemo(
    () => layoutChatFlow(chatFlow, foldedCompactIds),
    [chatFlow, foldedCompactIds],
  );
  // EN: v0.9.1 Task 3 — decorate the edge feeding the running
  // ChatNode with `data.running=true` so ContinuationEdge / SpawnEdge
  // render the animated dashed flow. We pass it as edge data rather
  // than a global flag so each edge component decides locally and
  // non-running edges keep their stable identity (avoids forcing
  // every edge to re-render on liveness flips).
  // 中: 把流向运行节点的那条边的 data.running 标 true，让边组件
  // 自己决定是否画流动虚线；其它边不变 identity 避免 liveness 切换
  // 触发全图 re-render。
  const sessionLive = useSessionLiveness(sessionId);
  const latestRunningId = useLatestChatNodeId(sessionId);
  const edges = useMemo(() => {
    if (!sessionLive || !latestRunningId) return rawEdges;
    return rawEdges.map((e) =>
      e.target === latestRunningId
        ? { ...e, data: { ...(e.data ?? {}), running: true } }
        : e,
    );
  }, [rawEdges, sessionLive, latestRunningId]);
  const setSelected = useStore((s) => s.setSelected);
  const selectedId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const conversationScroll = useConversationScrollShim();
  const hoverScrollReleaseRef = useRef<(() => void) | null>(null);
  const onNodeClick = useCallback(
    (_e: unknown, node: { id: string }) => {
      if (isChatFoldId(node.id)) return;
      // Click → drop any in-flight hover preview WITHOUT restoring,
      // so the click's persistent scroll wins.
      hoverScrollReleaseRef.current = null;
      setSelected(sessionId, node.id);
      conversationScroll(node.id, { smooth: true, mode: "click" });
    },
    [setSelected, sessionId, conversationScroll],
  );

  // EN (v0.9.1): canvas hover-dwell on a ChatNode → conversation
  // scrolls to the matching bubble as a TRANSIENT preview. Stash
  // the release so onMouseLeave can restore the previous scroll
  // position; without this, brushing the cursor over a card
  // permanently jumps the conversation panel and feels like
  // misclicking. 250ms dwell mirrors ConversationView's hover-pan.
  // 中: canvas hover 250ms 停留 → conversation scroll 到对应 bubble
  // 作临时预览。stash 返回的 release，mouseLeave 时调它恢复滚动位置，
  // 避免误触把 conversation 永久滚走。
  const hoverTimerRef = useRef<number | null>(null);
  const onNodeMouseEnter = useCallback(
    (_e: unknown, node: { id: string }) => {
      if (isChatFoldId(node.id)) return;
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        // Release any prior preview before kicking off this one.
        hoverScrollReleaseRef.current?.();
        const release = conversationScroll(node.id, {
          smooth: true,
          mode: "hover",
        });
        hoverScrollReleaseRef.current =
          typeof release === "function" ? release : null;
      }, 250);
    },
    [conversationScroll],
  );
  const onNodeMouseLeave = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverScrollReleaseRef.current?.();
    hoverScrollReleaseRef.current = null;
  }, []);
  // Cleanup on unmount so a half-fired timer doesn't reach a stale
  // shim after canvas remount.
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    },
    [],
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

  // v0.8.1 #5: register a pan-to-chat-node handler that ConversationView
  // hover triggers can call. The handler:
  //   1. computes the fold-host chain hiding `targetId` (if any)
  //   2. unfolds them in order from outer-most → inner-most
  //   3. stashes a pending pan target so the next layout commit
  //      centres the canvas on the now-visible node.
  //
  // Auto-unfold here deliberately does NOT go through FoldAnchorContext.
  // Anchor's contract is "preserve the user's MANUAL hand on the
  // wheel"; for the auto path we want the canvas to slide to the
  // newly-visible target, not stay glued to where the host used to be.
  const panCtx = useContext(CanvasPanContext);
  const pendingPanRef = useRef<string | null>(null);
  useEffect(() => {
    if (!panCtx) return;
    panCtx.ref.current = (targetId, mode = "click") => {
      const cur = useStore.getState().sessions.get(sessionId);
      if (!cur || !cur.chatFlow) return;
      const chain = computeUnfoldChainTo(
        cur.chatFlow,
        cur.foldedCompactIds,
        targetId,
      );
      // EN (v0.9.1): persist:false on every auto-unfold — this is a
      // navigation aid, not a user preference. Without persist:false
      // the hover/click rewrite would re-pollute `loomscope:unfold:`
      // storage on every cursor pass. User-explicit fold/unfold
      // (chatFold node card, compact node fold-toggle button)
      // continues to default-persist via opts.persist=true.
      // 中: 任何自动展开都走 persist:false（不是用户偏好）；用户主动
      // 点 fold/unfold 才持久。
      for (const host of chain) {
        unfoldAction(sessionId, host, { persist: false });
      }
      // EN: stash viewport BEFORE pan so the hover release can
      // restore. Click mode doesn't need stash but capturing it is
      // cheap; we just don't expose a release for click.
      // 中: pan 前先 stash viewport；hover release 时恢复。click 模式
      // 不暴露 release 也无所谓，stash 本身只是读一次 viewport。
      const stashedViewport = rf.getViewport();
      pendingPanRef.current = targetId;
      if (chain.length === 0) {
        const node = rf.getNode(targetId);
        if (node) panToNodeCenter(rf, node);
        pendingPanRef.current = null;
      }
      if (mode === "click") return; // persistent: no release
      // EN (hover preview release): caller (ConversationView's
      // mouseLeave) calls this to undo the transient pan + re-fold.
      // Idempotent — we mark applied=false on first call so a second
      // release is a no-op.
      // 中: hover 释放回调，恢复 viewport + 重新折叠之前展开的链。
      // 幂等，重复调用安全。
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Re-fold in reverse order (innermost first → outermost) so
        // each parent fold sees its child correctly stowed.
        for (let i = chain.length - 1; i >= 0; i -= 1) {
          useStore
            .getState()
            .foldCompact(sessionId, chain[i], { persist: false });
        }
        rf.setViewport(stashedViewport, { duration: 200 });
      };
    };
    return () => {
      if (panCtx.ref.current) panCtx.ref.current = null;
    };
  }, [panCtx, sessionId, rf, unfoldAction]);

  // After each layout commit, drain the pending pan target.
  useEffect(() => {
    const target = pendingPanRef.current;
    if (!target) return;
    const node = rf.getNode(target);
    if (!node) return; // Still hidden — wait for the next layout.
    panToNodeCenter(rf, node);
    pendingPanRef.current = null;
  }, [nodes, rf]);

  // EN (v0.9.1): canvas-pan-on-selection-change. selectedNodeId can
  // flip from sources OUTSIDE the canvas — Conversation bubble click,
  // follow-on-leaf when a new SSE-delivered ChatNode descends from
  // current focus, BranchSelector pickBranch, keyboard nav. The
  // explicit click paths already pan via panCtx (because they call
  // panToChatNode with mode='click' which both unfolds AND pans).
  // BUT follow-on-leaf and any future store-driven selection changes
  // bypass that path and only flip selectedNodeId. Without this
  // effect, the conversation auto-scrolls to the new bubble (good)
  // but the canvas viewport stays put (bad — user has to manually
  // pan to keep up with their own focus).
  // Skip the very first mount run — first-paint fitView already
  // handles initial focus (see latestNodeMeasured effect above) and
  // this would race with it.
  // 中: selectedNodeId 从 canvas 外部变化时（Conversation 点击 / 新
  // 消息 follow-on-leaf / 分支切换 / 键盘导航）自动 pan canvas 到
  // 焦点节点。Conversation auto-scroll 已经做了，canvas 之前漏了。
  // 跳过首次 mount——首屏 fitView 自己处理初始焦点。
  const skipFirstSelectionPanRef = useRef(true);
  useEffect(() => {
    if (skipFirstSelectionPanRef.current) {
      skipFirstSelectionPanRef.current = false;
      return;
    }
    if (!selectedId) return;
    const node = rf.getNode(selectedId);
    if (!node) return; // hidden behind a fold — let panCtx callers handle unfold
    panToNodeCenter(rf, node);
  }, [selectedId, rf]);

  // EN (v0.9.1): capture / restore viewport across drill in ⇄ out.
  // ChatFlow canvas is kept-mounted (display:none) when the user
  // enters a WorkFlow drill — React Flow's internal viewport state
  // SHOULD persist across display flips but doesn't reliably: the
  // ResizeObserver fires on the 0×0 → real-size jump and at certain
  // timings resets the viewport to origin. Explicit capture (on
  // 0 → >0 drillDepth transition) + restore (on >0 → 0, scheduled
  // for the next rAF so RF's resize-driven adjust runs first and our
  // restore overrides it) is the only reliable fix.
  // 中: drill 进出 WorkFlow 时保留 ChatFlow viewport。React Flow 的
  // 内部 viewport 应该 persist 但 display:none↔block 切换时
  // ResizeObserver 在 0×0→正常尺寸跳变里会把 viewport reset 到原点，
  // 显式 stash + 下一帧 restore 是唯一可靠方案。
  const drillDepth = useStore(
    (s) => s.sessions.get(sessionId)?.drillStack.length ?? 0,
  );
  const stashedViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(
    null,
  );
  const prevDepthRef = useRef(drillDepth);
  useEffect(() => {
    const prev = prevDepthRef.current;
    if (prev === 0 && drillDepth > 0) {
      // Just entered a drill — stash the current viewport.
      stashedViewportRef.current = rf.getViewport();
    } else if (prev > 0 && drillDepth === 0 && stashedViewportRef.current) {
      // Just exited — restore on the next paint so the display flip
      // and React Flow's internal resize handling settle first. A
      // single rAF is enough; without it the restore lands BEFORE
      // RF's ResizeObserver-driven viewport adjust and gets clobbered.
      const stash = stashedViewportRef.current;
      stashedViewportRef.current = null;
      requestAnimationFrame(() => {
        rf.setViewport(stash, { duration: 0 });
      });
    }
    prevDepthRef.current = drillDepth;
  }, [drillDepth, rf]);

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
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
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
