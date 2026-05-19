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
import { useTranslation } from "react-i18next";

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

import { postFork } from "@/api/turns";
import { CanvasPanContext } from "@/canvas/CanvasPanContext";
import { useConversationScrollShim } from "@/canvas/ConversationScrollContext";
import { ContextMenu, type ContextMenuItem } from "@/canvas/ContextMenu";
import {
  useLatestChatNodeId,
  useSessionLiveness,
} from "@/store/livenessHooks";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  chatFlowLayoutSignature,
  incrementalAppendLayout,
  layoutChatFlow,
  nodeCenterPoint,
  refreshChatNodeContent,
  safePanTarget,
  type PrevLayout,
} from "@/canvas/layoutDag";
import { chatFlowContentSignature } from "@/utils/chatFlowSig";
import { ModelRibbonLayer } from "@/canvas/ModelRibbonLayer";
import { AwaySummaryNodeCard } from "@/canvas/nodes/AwaySummaryNodeCard";
import { ChatFoldNodeCard } from "@/canvas/nodes/ChatFoldNodeCard";
import { ChatNodeCard } from "@/canvas/nodes/ChatNodeCard";
import { AwaySummaryEdge } from "@/canvas/edges/AwaySummaryEdge";
import { ContinuationArrowDefs, ContinuationEdge } from "@/canvas/edges/ContinuationEdge";
import {
  FoldAnchorContext,
  type FoldAnchorAPI,
} from "@/canvas/FoldAnchorContext";
import { computeUnfoldChainTo, isChatFoldId } from "@/canvas/foldProjection";
import { isAwaySummaryId } from "@/canvas/layoutDag";
import type { ChatFlow } from "@/data/types";
import { useStore } from "@/store/index";

const nodeTypes: NodeTypes = {
  chatNode: ChatNodeCard,
  chatFold: ChatFoldNodeCard,
  awaySummary: AwaySummaryNodeCard,
};
const edgeTypes: EdgeTypes = {
  continuation: ContinuationEdge,
  awaySummary: AwaySummaryEdge,
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
//
// CANVAS_FOCUS_BIAS_Y_PX (v0.11): bottom of the canvas carries
// more visual chrome than the top — zoom controls at bottom-left,
// the TaskListPanel chip (or expanded panel) at bottom-right —
// while the top has only a small DrillBreadcrumb in the corner.
// Geometrically centering a card at (canvas.w/2, canvas.h/2) puts
// it under the imaginary line that splits the visible (uncovered)
// area, so users perceive the card as "slightly low". Bias the
// target y upward in screen px (added to world y because positive
// y is down in RF coords; setCenter then pans further so the card
// appears above the geometric midpoint by this amount).
//
// Used by BOTH first-paint fitView-then-recenter AND click-focus
// panToNodeCenter so the two paths land cards at identical screen
// y. 32 was the original click-focus value; first-paint had no
// bias, so refresh-then-click produced visible vertical drift.
// 16 is the midpoint between "no bias" (auto-display lower) and
// "32 bias" (click-focus higher), matching user preference for
// the in-between position 2026-05-08.
//
// 中: 由于画布底部 chrome 比顶部重（左下 zoom controls + 右下
// TaskListPanel），几何居中的卡片视觉上偏下；把目标点世界 y +
// bias/zoom，setCenter 多 pan 一点，卡片屏幕位置上移 bias px。
// 首屏 + 点击 focus 两条路径共用此 bias，消除刷新前后视觉漂移。
const CANVAS_FOCUS_BIAS_Y_PX = 16;

// Returns false (no-op) when the node has no finite dagre position
// yet — see nodeCenterPoint. Callers with a pending-pan retry should
// keep the target pending so the post-layout drain re-attempts.
function panToNodeCenter(
  rf: ReturnType<typeof useReactFlow>,
  node: { position: { x: number; y: number }; measured?: { width?: number; height?: number } },
  opts: { duration?: number } = {},
): boolean {
  const vp = rf.getViewport();
  const t = safePanTarget(
    nodeCenterPoint(node),
    vp.zoom,
    CANVAS_FOCUS_BIAS_Y_PX,
  );
  // null = node not laid out yet OR viewport zoom not ready OR any
  // degraded input → no-op. Callers with a pending-pan retry keep the
  // target pending so the post-layout drain re-attempts once geometry
  // is sane (the earlier fix only guarded node position, missing the
  // viewport-zoom path — this composes both, fully).
  if (!t) return false;
  rf.setCenter(t.x, t.y, {
    zoom: t.zoom,
    // Default 200ms for click-focus animation; first-paint passes 0
    // because the canvas is opacity-gated until firstPaintReady and
    // an animation would play out behind the gate, then unblur into
    // motion — looks like a flicker.
    duration: opts.duration ?? 200,
  });
  return true;
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
  // EN (2026-05-16 perf): memoise the dagre layout on a structural
  // SIGNATURE, not the `chatFlow` object reference. Node positions
  // depend only on topology + fold state (dagre uses fixed size
  // hints); the frequent `chatnode-summary-updated` deltas (assistant
  // text streaming in) mint a fresh chatFlow object but do NOT move
  // any node. Re-running a 600-node dagre layout for every such delta
  // was the long-conversation jank (>12 s main-thread block / 10 s+
  // append latency, measured in e2e/sse_longconv.spec.ts). With the
  // signature key, content-only deltas are layout no-ops; we only
  // re-layout when topology / fold actually changes (chatnode-added,
  // -removed, fold toggle). chatFlow/foldedCompactIds are read inside
  // but intentionally NOT in the deps — layoutSig is their complete
  // structural digest.
  // 中: layout memo 改依赖结构指纹而非 chatFlow 引用。内容 delta 不
  // 动布局，避免长会话每条 delta 全量重排导致的卡顿。
  const layoutSig = useMemo(
    () => chatFlowLayoutSignature(chatFlow, foldedCompactIds),
    [chatFlow, foldedCompactIds],
  );
  // EN (2026-05-17, #226): incremental tail-append. On a topology
  // change (layoutSig changed) try the cheap linear-tail-append path
  // first — it reuses every existing node's dagre position and only
  // places the appended leaf at parent + one rank. Falls back to the
  // full dagre `layoutChatFlow` for anything non-trivial (fork, fold,
  // awaySummary, compact, removal, reorder, relink, first build).
  // The ref caches the last result + its signature + the chatNodes
  // array it was built from (object-identity reuse for unchanged
  // nodes). Mutating a ref inside useMemo is the standard
  // memo-with-cache pattern — no observable side-effect, and the
  // useMemo([layoutSig]) gate preserves the 82ce1f8 invariant
  // (content-only deltas never reach here at all).
  // 中: 拓扑变化时先试线性尾追加（复用旧坐标，仅新叶子定位），
  // 非平凡情况回退全量 dagre。ref 缓存上次结果用于增量。
  const prevLayoutRef = useRef<PrevLayout | null>(null);
  // POSITIONS — dagre, gated on the structural signature ONLY. This
  // is the #226 perf invariant: content-only deltas never re-run the
  // 600-node layout (the `__layoutChatFlowCalls` e2e gate asserts
  // this). Unchanged from before.
  const laidOut = useMemo(() => {
    const incr = incrementalAppendLayout(
      prevLayoutRef.current,
      chatFlow,
      foldedCompactIds,
    );
    const result = incr ?? layoutChatFlow(chatFlow, foldedCompactIds);
    prevLayoutRef.current = {
      sig: layoutSig,
      result,
      chatNodes: chatFlow.chatNodes,
    };
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSig]);
  // CONTENT — the dual gate. The node memo used to be `[layoutSig]`
  // alone, so a `chatnode-summary-updated` delta (assistant text
  // streaming in) updated the store but the card's
  // `data.assistantPreview` only refreshed on the NEXT topology
  // change — the user-reported "ChatNode assistant message doesn't
  // update until the next message creates a node". `contentSig`
  // changes whenever any card's rendered content changes;
  // `refreshChatNodeContent` re-derives card `data` from the live
  // chatFlow over the cached positions — O(N), NO dagre, so the
  // #226 invariant above is fully preserved.
  const contentSig = useMemo(
    () => chatFlowContentSignature(chatFlow),
    [chatFlow],
  );
  const { nodes, edges: rawEdges } = useMemo(
    () => ({
      nodes: refreshChatNodeContent(laidOut.nodes, chatFlow),
      edges: laidOut.edges,
    }),
    // chatFlow is read but its render-relevant content is digested by
    // contentSig (structure by laidOut/layoutSig) — same intentional
    // exhaustive-deps exclusion as the layout memo above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [laidOut, contentSig],
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
      if (isChatFoldId(node.id) || isAwaySummaryId(node.id)) return;
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
      if (isChatFoldId(node.id) || isAwaySummaryId(node.id)) return;
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

  // PR 2 of fork-UX rework: right-click context menu state. Built per-
  // canvas because the menu's fork/jump actions need access to chatFlow
  // (lookup ChatNode by id) + sessionId + the activeSession setter.
  const { t } = useTranslation();
  const setActiveSession = useStore((s) => s.setActiveSession);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    chatNodeId: string;
  } | null>(null);
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: { id: string }) => {
      // Skip synthetic chatFold nodes — they're not real ChatNodes,
      // there's nothing to fork from / jump to.
      if (isChatFoldId(node.id) || isAwaySummaryId(node.id)) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, chatNodeId: node.id });
    },
    [],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu) return [];
    const cn = chatFlow.chatNodes.find((c) => c.id === contextMenu.chatNodeId);
    if (!cn) return [];
    const cs = cn.contributingSessions ?? [];
    const onActiveChain =
      cs.length === 0 || cs.includes(sessionId);
    // For off-chain nodes, the "source session" is whichever session
    // contributed records (== the sibling fork's sid). When a node
    // somehow contributes to multiple non-active sessions, picking
    // the first is fine — practical case is single-source.
    const sourceSid = onActiveChain
      ? undefined
      : cs.find((s) => s !== sessionId);
    // Fork point = userMessage.uuid (the bucket's root user record).
    // CC's forkSession copies up to and including this uuid, so the
    // fork's last turn is the user's prompt; the assistant's response
    // to that turn is dropped. Lite payload doesn't expose the
    // bucket's last record uuid; falling back to userMessage.uuid is
    // the same convention v∞.2's auto-fork used. For "include the
    // assistant's response" UX a future patch can lazy-fetch the
    // workflow + read its tail uuid.
    const upToMessageId = cn.userMessage.uuid;

    const items: ContextMenuItem[] = [];
    if (onActiveChain) {
      // Fork from a node ON the active chain: source = active session,
      // intent is unambiguous ("I'm working in session A, branch from
      // this point on A's chain"). Off-chain nodes deliberately omit
      // this item — forking from a gray sibling-fork node would
      // create a new session that descends from a session the user
      // isn't currently viewing, which is confusing + easy to mis-
      // trigger. The user is expected to jump-to-source first, then
      // fork from there if needed.
      items.push({
        key: "fork-from-here",
        label: t("canvas.context_menu.fork_from_here"),
        description: t("canvas.context_menu.fork_from_here_hint"),
        onClick: async () => {
          const r = await postFork(sessionId, { upToMessageId });
          if ("error" in r) {
            // Fork errors land here; for now just console — a toast
            // system would slot in cleanly when one exists.
            // eslint-disable-next-line no-console
            console.error("[loomscope:fork] failed:", r.error);
            return;
          }
          // chokidar should pick up the new jsonl within ~1 RAF and
          // populate the workspace. setActiveSession schedules the
          // switch — first paint may briefly show empty state until
          // the new chatFlow loads, that's expected.
          setActiveSession(r.sessionId);
        },
      });
    }
    if (sourceSid) {
      items.push({
        key: "jump-to-source",
        label: t("canvas.context_menu.jump_to_source", {
          sid: sourceSid.slice(0, 8),
        }),
        description: t("canvas.context_menu.jump_to_source_hint"),
        onClick: () => {
          setActiveSession(sourceSid);
        },
      });
    }
    return items;
  }, [contextMenu, chatFlow, sessionId, t, setActiveSession]);

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
  // Subscribe to RF's pixel-dimension store so the first-paint effect
  // reruns once ResizeObserver populates real width/height (initially
  // 0,0 before mount). Without this we'd compute fit zoom against
  // bogus dimensions and freeze.
  const rfPixelW = useReactFlowStore((s: ReactFlowState) => s.width);
  const rfPixelH = useReactFlowStore((s: ReactFlowState) => s.height);
  // Focus on the latest ChatNode when the user opens a different session.
  // Re-running on every chatFlow change is intentional — for v0.2 a
  // chatFlow change == "user picked a different session". When v0.7
  // file-tail lands, this dependency should narrow to chatFlow.id so
  // incremental updates don't yank the viewport away from the user.
  const focusedSessionRef = useRef<string | null>(null);
  // EN (v0.10 收尾): hide the canvas until first-paint fitView lands.
  // Without this, ReactFlow paints one frame at the default viewport
  // (origin, zoom=1) BEFORE the ResizeObserver-driven measurement
  // arrives + this useEffect fires fitView. On a tiny ChatFlow that
  // frame shows the root and looks fine. On a 244 MB session with
  // hundreds of ChatNodes laid out left-to-right with parallel forks,
  // the user briefly sees the entire spread (= "复杂的树形 workflow
  // 闪过" in the user repro) before the camera jumps to the leaf.
  // Opacity gate is enough — the canvas is rendered, sized, ready;
  // we just don't show it until fitView has centred. Reset to false
  // when chatFlow.id changes so a session switch re-runs the gate.
  // 中: 隐藏画布直到 fitView 完成，避免大 session 切换时一帧默认视
  // 口（zoom=1，原点）暴露整张 dagre 展开图的"树状闪过"。session 切
  // 换时把闸门重置回 false。
  const [firstPaintReady, setFirstPaintReady] = useState(false);
  useEffect(() => {
    setFirstPaintReady(false);
  }, [chatFlow.id]);
  useEffect(() => {
    if (!latestNodeMeasured) return;
    if (!latestNodeId) return;
    if (rfPixelW === 0 || rfPixelH === 0) return;
    if (focusedSessionRef.current === chatFlow.id) return;
    const node = rf.getNode(latestNodeId);
    if (!node) return;
    // NOTE: focusedSessionRef is set ONLY after a successful center
    // (below), not here — so if `nodes` doesn't yet contain the laid
    // position on this tick, the effect re-runs (nodes dep) and
    // retries instead of gating itself out uncentred (the #232 trap).
    // Single setCenter — NO fitView.
    //
    // Why drop fitView: even with `duration: 0`, xyflow v12's fitView
    // commits its viewport via an internal scheduler (not synchronous
    // store write). Our follow-up `panToNodeCenter` (in rAF) lands
    // BEFORE fitView's commit, then fitView clobbers it back to
    // geometric center — symptom users saw was first-paint at
    // geometric center / click-focus 16px above (canvas hops upward
    // on the first card click after refresh).
    //
    // Replacement: mirror xyflow's `getViewportForBounds` math
    // (zoom = min(W/(w*(1+pad)), H/(h*(1+pad))) clamped to range),
    // then one `setCenter` with the same bias formula
    // panToNodeCenter uses. Single store write, no race.
    //
    // 中: fitView({duration:0}) 在 xyflow v12 仍然异步提交，会盖掉
    // 我们随后的 panToNodeCenter，导致首屏停在几何中心、点击焦点偏上
    // 16px → 刷新后点最新卡片画布上跳。改成自己算 zoom + 一次
    // setCenter，无竞态。
    const w = node.measured?.width ?? NODE_WIDTH;
    const h = node.measured?.height ?? NODE_HEIGHT;
    const padding = 0.4;
    const zoomX = rfPixelW / (w * (1 + padding));
    const zoomY = rfPixelH / (h * (1 + padding));
    const zoom = Math.max(0.5, Math.min(1.0, Math.min(zoomX, zoomY)));
    // #232 fix (2026-05-18): center from OUR dagre layout position,
    // not `rf.getNode().position`. The NaN-pan guard (05795b8) made
    // first-paint read `nodeCenterPoint(rf.getNode(latestNodeId))` —
    // but React Flow's internal store lags our `nodes` prop on a cold
    // 600-node load: `latestNodeMeasured` (DOM size) goes true BEFORE
    // RF commits the dagre coordinate, so `node.position` is non-
    // finite at this tick → setCenter skipped → canvas unblurred at
    // the DEFAULT viewport → the latest card (far right in LR) is
    // off-screen → open→first-card +3.6s (8475 vs 4816ms; the #232
    // regression). Our `nodes` memo IS the dagre output and is ALWAYS
    // finite, available synchronously with render. Use it. The finite
    // check stays as defence (and preserves the NaN-flood guard: we
    // still never feed NaN to setCenter); it just (almost) never
    // trips now because dagre output is finite.
    const laid = nodes.find((n) => n.id === latestNodeId);
    const px = laid?.position?.x;
    const py = laid?.position?.y;
    if (Number.isFinite(px) && Number.isFinite(py)) {
      rf.setCenter(
        (px as number) + w / 2,
        (py as number) + h / 2 + CANVAS_FOCUS_BIAS_Y_PX / zoom,
        { zoom, duration: 0 },
      );
      // Mark done ONLY now — a real center happened. If we couldn't
      // center yet, leave it unset so the nodes-dep re-run retries.
      focusedSessionRef.current = chatFlow.id;
    }
    // Always unblur — never leave the canvas stuck behind the opacity
    // gate even in the (now rare) not-yet-laid-out case; the retry
    // above snaps it to center within a render or two.
    setFirstPaintReady(true);
  }, [
    chatFlow.id,
    latestNodeId,
    latestNodeMeasured,
    rfPixelW,
    rfPixelH,
    rf,
    nodes,
  ]);

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
        // Only clear the pending target if the pan actually landed.
        // If the node exists but has no finite position yet (optimistic
        // / placeholder appended ahead of layout), panToNodeCenter
        // no-ops → keep it pending so the post-layout drain effect
        // re-attempts once dagre assigns a real coordinate (instead of
        // feeding NaN into setCenter and spamming the console).
        if (node && panToNodeCenter(rf, node)) {
          pendingPanRef.current = null;
        }
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
    // Keep pending if the node exists but isn't laid out yet; this
    // effect re-runs on every `nodes` (layout) commit, so it converges
    // once dagre assigns the placeholder a finite position.
    if (panToNodeCenter(rf, node)) pendingPanRef.current = null;
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
    <div
      className="absolute inset-0"
      style={{
        opacity: firstPaintReady ? 1 : 0,
        // Brief fade so the appear isn't a hard pop. Long-enough sessions
        // already paid a multi-second parse wait, an extra 80 ms is
        // imperceptible.
        transition: "opacity 80ms",
      }}
      data-loomscope-first-paint={firstPaintReady ? "ready" : "pending"}
    >
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onNodeContextMenu={onNodeContextMenu}
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
    {contextMenu && menuItems.length > 0 && (
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        items={menuItems}
        onClose={closeContextMenu}
      />
    )}
    </div>
    </FoldAnchorContext.Provider>
  );
}
