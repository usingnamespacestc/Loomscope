// Right-side resizable drill panel — surfaces the full content of the
// currently selected node. Position chosen per design抉择 1 (matches
// Agentloom ConversationView layout). Mode-following per design抉择 2:
// in ChatFlow view shows ChatNode detail; in WorkFlow view shows
// WorkNode detail.
//
// Toggle button on the panel header lets users collapse to a 12px
// strip when they need full canvas width — preferred over hard-hide
// so the strip stays as a re-entry affordance.
//
// v0.8 M3: panel becomes 2-tab — Detail (1:1 v0.4-v0.7 behaviour) +
// Conversation (M4 fills it; M3 ships placeholder). Tab state is
// global UI pref via UISlice.drillPanelTab (per micro-decision 1B),
// persisted via partialize. Detail tab content is identical to v0.7's
// panel body — extracted into DetailTabContent subcomponent purely so
// the JSX of the wrapper reads cleanly with the new tab strip.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// v0.10 polish #6B: lazy-load the heavy detail / conversation
// components. All three pull in the markdown stack (react-markdown +
// remark-gfm + rehype-raw + rehype-sanitize + rehype-highlight +
// highlight.js with its language pack), totalling ~300KB / ~80KB gz.
// Until the user clicks a session and the panel renders content,
// none of that needs to be in the initial bundle.
const ChatNodeDetail = lazy(() =>
  import("@/components/drill/ChatNodeDetail").then((m) => ({
    default: m.ChatNodeDetail,
  })),
);
const ConversationView = lazy(() =>
  import("@/components/drill/ConversationView").then((m) => ({
    default: m.ConversationView,
  })),
);
const WorkNodeDetail = lazy(() =>
  import("@/components/drill/WorkNodeDetail").then((m) => ({
    default: m.WorkNodeDetail,
  })),
);
const GitDiffPanel = lazy(() =>
  import("@/components/drill/GitDiffPanel").then((m) => ({
    default: m.GitDiffPanel,
  })),
);
const EffectiveContextView = lazy(() =>
  import("@/components/drill/EffectiveContextView").then((m) => ({
    default: m.EffectiveContextView,
  })),
);
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode, WorkNode } from "@/data/types";
import type { DrillPanelTab } from "@/store/types";

interface Props {
  sessionId: string;
  chatFlow: ChatFlow;
  // ``chatnode`` when the main viewport is the ChatFlow canvas;
  // ``workflow`` when drilled into a WorkFlow. Drives which detail
  // component renders.
  viewMode: "chatflow" | "workflow" | "sub-chatflow";
  // Only meaningful when viewMode === "workflow" — the ChatNode whose
  // WorkFlow is being viewed (panel header shows it as a breadcrumb).
  drilledChatNode: ChatNode | null;
}

// v0.8.1 #2: bump from 12 → 24 so the collapsed strip mirrors the
// Sidebar's collapsed pattern (div wrapper + button child) and the
// click target is wide enough to feel intentional. The narrower 12px
// wasn't the root cause of the overflow but a 12px hit target was
// also bad UX — fix both at once.
const COLLAPSED_WIDTH = 24;

export function DrillPanel({ sessionId, chatFlow, viewMode, drilledChatNode }: Props) {
  const width = useStore((s) => s.drillPanelWidth);
  const collapsed = useStore((s) => s.drillPanelCollapsed);
  const fullscreen = useStore((s) => s.drillPanelFullscreen);
  const setWidth = useStore((s) => s.setDrillPanelWidth);
  const toggle = useStore((s) => s.toggleDrillPanel);
  const toggleFullscreen = useStore((s) => s.toggleDrillPanelFullscreen);
  const tab = useStore((s) => s.drillPanelTab);
  const setTab = useStore((s) => s.setDrillPanelTab);

  // v0.10 polish: auto-pick the contextually appropriate tab when
  // viewMode changes. ChatFlow / sub-ChatFlow → Conversation (the
  // user is browsing dialogue). WorkFlow → Detail (the user has
  // drilled into a specific ChatNode and wants to inspect WorkNode
  // payloads, not re-read the conversation). User can still flip the
  // tab manually after the auto-set; the override sticks until the
  // next viewMode transition.
  const prevViewModeRef = useRef<typeof viewMode | null>(null);
  useEffect(() => {
    if (prevViewModeRef.current === viewMode) return;
    prevViewModeRef.current = viewMode;
    const desired: DrillPanelTab =
      viewMode === "workflow" ? "detail" : "conversation";
    if (tab !== desired) setTab(desired);
    // Only react to viewMode changes — `tab` and `setTab` are stable
    // enough that we don't need them in deps; leaving them out keeps
    // user-initiated tab clicks from triggering this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  if (collapsed) {
    return (
      <CollapsedStrip
        width={COLLAPSED_WIDTH}
        onExpand={toggle}
      />
    );
  }

  // v0.8.1 #7: in fullscreen, the panel takes flex: 1 instead of a
  // pinned width. App.tsx hides <main> in this mode so flex-1 grows
  // into the canvas area. Resize handle is hidden — there's nothing
  // to resize against in fullscreen.
  const sizingStyle = fullscreen
    ? { flex: 1, minWidth: 0 }
    : { width, minWidth: width, maxWidth: width };

  return (
    <aside
      data-testid="drill-panel"
      data-fullscreen={fullscreen ? "true" : "false"}
      className={[
        "relative flex h-full flex-col bg-gray-50",
        fullscreen ? "" : "border-l border-gray-200",
      ].join(" ")}
      style={sizingStyle}
    >
      {!fullscreen && <ResizeHandle width={width} setWidth={setWidth} />}
      <TabStrip
        activeTab={tab}
        onSelect={setTab}
        viewMode={viewMode}
        drilledChatNode={drilledChatNode}
        onCollapse={toggle}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
      />
      {/* min-w-0 + overflow-x-hidden so panel resize doesn't expose
          horizontal scrollbar when markdown content (wide tables, long
          pre code lines) exceeds the narrower panel width. Each block
          inside (typography pre, table) handles its own x-overflow
          locally; the panel itself stays clean — never scroll
          horizontally. Re-verify on @tailwindcss/typography upgrades:
          if typography stops setting `pre { overflow-x: auto }` this
          would start clipping code blocks instead of letting them
          scroll within. */}
      <div
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-3 [overflow-anchor:auto]"
      >
        {/* Suspense fallback covers the first-render fetch of the
            lazy markdown chunk (~80 KB gz). Subsequent tab switches
            are cached.
            v0.10 perf: Both Detail + Conversation tabs render
            simultaneously — only the inactive one's container gets
            display:none. Otherwise switching tabs (which the
            viewMode auto-flip does on every drill in/out) would
            unmount + remount ConversationView, re-running the
            entire markdown pipeline (remark-gfm + rehype-raw +
            rehype-highlight + rehype-sanitize) on every visible
            message. For a 50-bubble visible slice that costs ~5 s
            on every drill exit. Keeping both mounted means the
            pipeline runs once per chatNode change, not per tab
            switch. */}
        <Suspense fallback={<LazyFallback />}>
          <div style={{ display: tab === "detail" ? "block" : "none" }}>
            <DetailTabContent
              sessionId={sessionId}
              chatFlow={chatFlow}
              viewMode={viewMode}
              drilledChatNode={drilledChatNode}
            />
          </div>
          <div style={{ display: tab === "conversation" ? "block" : "none" }}>
            <ConversationView
              sessionId={sessionId}
              chatFlow={chatFlow}
              // In workflow drill view, lock conversation focus to the
              // drilled ChatNode: the canvas is showing WorkNodes (not
              // ChatNodes), so click-to-select / hover-pan have no
              // meaningful target on the canvas. ChatFlow / sub-chatflow
              // views keep the normal click-driven selection.
              focusLock={
                viewMode === "workflow" ? drilledChatNode?.id ?? null : null
              }
            />
          </div>
          <div
            style={{
              display: tab === "effective_context" ? "block" : "none",
            }}
          >
            <EffectiveContextView
              sessionId={sessionId}
              chatFlow={chatFlow}
              viewMode={viewMode}
              drilledChatNode={drilledChatNode}
            />
          </div>
          <div style={{ display: tab === "git" ? "block" : "none" }}>
            <GitTabContent
              sessionId={sessionId}
              chatFlow={chatFlow}
              viewMode={viewMode}
              drilledChatNode={drilledChatNode}
            />
          </div>
        </Suspense>
      </div>
    </aside>
  );
}

// Suspense fallback while the lazy panel-content chunk loads. Light
// touch — Loomscope's network is local so the fetch is sub-100ms;
// flashing a heavy spinner would be more distracting than the small
// pause itself.
function LazyFallback() {
  return (
    <div
      data-testid="drill-panel-loading"
      className="text-[11px] text-gray-400 italic"
    >
      Loading…
    </div>
  );
}

// 2-tab strip — top of panel, replacing the v0.8 Header. The "DETAIL"
// uppercase header was redundant once tabs existed (Detail and
// Conversation are tab labels themselves); v0.8.1 #1 removes it and
// folds the breadcrumb (workflow-mode `↳ CN xxxxxxxx`) + collapse
// button into this strip on the right side.
//
// Per hard constraint #11, switching between tabs MUST not affect
// Detail tab content behaviour (it's just a visibility toggle, not a
// re-render trigger).
function TabStrip({
  activeTab,
  onSelect,
  viewMode,
  drilledChatNode,
  onCollapse,
  fullscreen,
  onToggleFullscreen,
}: {
  activeTab: DrillPanelTab;
  onSelect: (tab: DrillPanelTab) => void;
  viewMode: "chatflow" | "workflow" | "sub-chatflow";
  drilledChatNode: ChatNode | null;
  onCollapse: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="drill-panel-tabs"
      className="flex items-center border-b border-gray-200 bg-white"
    >
      <TabButton
        active={activeTab === "detail"}
        onClick={() => onSelect("detail")}
        testId="drill-panel-tab-detail"
        label={t("drill_panel.tab_detail")}
      />
      <TabButton
        active={activeTab === "conversation"}
        onClick={() => onSelect("conversation")}
        testId="drill-panel-tab-conversation"
        label={t("drill_panel.tab_conversation")}
      />
      <TabButton
        active={activeTab === "effective_context"}
        onClick={() => onSelect("effective_context")}
        testId="drill-panel-tab-effective-context"
        label={t("drill_panel.tab_effective_context")}
      />
      <TabButton
        active={activeTab === "git"}
        onClick={() => onSelect("git")}
        testId="drill-panel-tab-git"
        label={t("drill_panel.tab_git")}
      />
      {viewMode === "workflow" && drilledChatNode && (
        // Mode-following breadcrumb: keep parent ChatNode visible
        // even when the panel is rendering WorkNode detail (preserves
        // v0.4 design choice 2). Sits between tab buttons and the
        // right-edge actions so it gets squeezed first when the panel
        // is narrow — tabs + actions stay clickable.
        <span
          className="ml-2 inline-flex min-w-0 items-center gap-1 truncate text-[10px] text-gray-400 font-mono"
          title={drilledChatNode.id}
          data-testid="drill-panel-breadcrumb"
        >
          <span>↳</span>
          <span className="truncate">CN {drilledChatNode.id.slice(0, 8)}</span>
        </span>
      )}
      <button
        type="button"
        className="ml-auto flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors"
        onClick={onToggleFullscreen}
        title={fullscreen ? "Restore panel size" : "Maximize panel (cover canvas)"}
        data-testid="drill-panel-fullscreen"
        data-active={fullscreen ? "true" : "false"}
      >
        {/* ⛶ Square Four Corners — standard maximize / fullscreen icon.
            Same glyph for enter/exit; title attr distinguishes. */}
        ⛶
      </button>
      <button
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors"
        onClick={onCollapse}
        title="Collapse panel"
        data-testid="drill-panel-collapse"
      >
        ▶
      </button>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  testId,
  label,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={[
        "px-3 py-1.5 text-[11px] font-medium transition-colors",
        active
          ? "text-blue-700 border-b-2 border-blue-500 -mb-px"
          : "text-gray-500 hover:text-gray-800 hover:bg-gray-50",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

// Extracted Detail tab body — identical to v0.7's panel content. M4
// will mount ConversationView in the Conversation tab; M3 ships a
// placeholder so each milestone is independently committable per
// project convention.
function DetailTabContent({
  sessionId,
  chatFlow,
  viewMode,
  drilledChatNode,
}: Props) {
  const { t } = useTranslation();
  const selectedChatId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const selectedWorkId = useStore(
    (s) => s.sessions.get(sessionId)?.workflowSelectedNodeId ?? null,
  );

  // v0.10 lazy ChatFlow B4 + v0.9.1 sub-agent fix: prefer INLINE
  // workflow.nodes when populated; only fall back to workflowCache
  // when inline is empty (lite top-level ChatNode that hasn't lazy-
  // fetched yet). Sub-agent ChatNodes from /subagents always have
  // inline populated and MUST NOT consult the cache, because
  // workflowCache is keyed by chatNode.id and CC's Task delegation
  // reuses parent uuids — the cache lookup with sub-agent's
  // chatNodeId would return the top-level entry (wrong WorkFlow).
  const drilledWorkflowCache = useStore((s) =>
    drilledChatNode && drilledChatNode.workflow.nodes.length === 0
      ? s.sessions.get(sessionId)?.workflowCache.get(drilledChatNode.id) ?? null
      : null,
  );
  const drilledWorkflowNodes = drilledChatNode
    ? drilledChatNode.workflow.nodes.length > 0
      ? drilledChatNode.workflow.nodes
      : drilledWorkflowCache?.status === "ready" && drilledWorkflowCache.workflow
        ? drilledWorkflowCache.workflow.nodes
        : []
    : [];

  // Resolve the currently focused node based on viewMode + selection.
  // chatflow + sub-chatflow both surface ChatNodeDetail; workflow
  // surfaces WorkNodeDetail. ``chatFlow`` here is the *scope*
  // ChatFlow (top-level for chatflow view, sub-agent for sub-chatflow
  // view) — App.tsx narrows it before passing.
  const focused = useMemo(() => {
    if (viewMode === "chatflow" || viewMode === "sub-chatflow") {
      const cn = selectedChatId
        ? chatFlow.chatNodes.find((c) => c.id === selectedChatId) ?? null
        : null;
      return { kind: "chatnode" as const, chatNode: cn };
    }
    if (!drilledChatNode) return { kind: "empty" as const };
    const wn = selectedWorkId
      ? drilledWorkflowNodes.find((n) => n.id === selectedWorkId) ?? null
      : null;
    return { kind: "worknode" as const, workNode: wn };
  }, [
    viewMode,
    selectedChatId,
    selectedWorkId,
    chatFlow,
    drilledChatNode,
    drilledWorkflowNodes,
  ]);

  return (
    <>
      {focused.kind === "chatnode" && focused.chatNode && (
        <ChatNodeDetail
          chatNode={focused.chatNode}
          chatFlow={chatFlow}
          sessionId={sessionId}
        />
      )}
      {focused.kind === "chatnode" && !focused.chatNode && (
        <EmptyHint label={t("placeholders.click_chatnode_for_details")} />
      )}
      {focused.kind === "worknode" && focused.workNode && (
        <WorkNodeDetail
          workNode={focused.workNode}
          sessionId={sessionId}
          workflowNodes={drilledWorkflowNodes}
        />
      )}
      {focused.kind === "worknode" && !focused.workNode && (
        <EmptyHint label={t("placeholders.click_worknode_for_details")} />
      )}
      {focused.kind === "empty" && (
        <EmptyHint label={t("placeholders.enter_workflow_first")} />
      )}
    </>
  );
}

// v0.8.1 #2: wrap the click target in a div with explicit width
// pinning (mirrors Sidebar's collapsed pattern). The previous version
// returned the <button> directly into the App's flex row — buttons
// have intrinsic content sizing that can leak past `width: 12px` if
// the icon font glyph metrics push wider, and once that happens main
// (flex-1 min-w-0) doesn't shrink because there's no overflow-hidden
// on it. Real fix in two parts: this wrapper + overflow-hidden on
// <main> in App.tsx.
function CollapsedStrip({
  width,
  onExpand,
}: {
  width: number;
  onExpand: () => void;
}) {
  return (
    <div
      className="border-l border-gray-200 bg-gray-100 flex items-center justify-center flex-shrink-0"
      style={{ width, minWidth: width }}
    >
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:bg-blue-50 hover:text-blue-600 transition-colors cursor-pointer"
        onClick={onExpand}
        title="Expand drill panel"
        data-testid="drill-panel-expand"
      >
        ◀
      </button>
    </div>
  );
}

function ResizeHandle({
  width,
  setWidth,
}: {
  width: number;
  setWidth: (w: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(width);

  const onMove = useCallback(
    (e: MouseEvent) => {
      // Panel is on the right, so dragging the handle LEFT grows it.
      const dx = startX.current - e.clientX;
      setWidth(startWidth.current + dx);
    },
    [setWidth],
  );

  const onUp = useCallback(() => {
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, onMove, onUp]);

  return (
    <div
      className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-300 transition-colors z-10"
      onMouseDown={(e) => {
        e.preventDefault();
        startX.current = e.clientX;
        startWidth.current = width;
        setDragging(true);
      }}
      data-testid="drill-panel-resize"
    />
  );
}

// v0.11 Git tab body. Resolves the focused ChatNode the same way
// DetailTabContent does (chatflow / sub-chatflow → selectedNodeId;
// workflow → drilledChatNode), then renders GitDiffPanel.
function GitTabContent({
  sessionId,
  chatFlow,
  viewMode,
  drilledChatNode,
}: Props) {
  const selectedChatId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const focusedChatNode = useMemo<ChatNode | null>(() => {
    if (viewMode === "workflow") return drilledChatNode;
    if (!selectedChatId) return null;
    return chatFlow.chatNodes.find((c) => c.id === selectedChatId) ?? null;
  }, [viewMode, selectedChatId, chatFlow, drilledChatNode]);
  return (
    <GitDiffPanel
      sessionId={sessionId}
      chatNode={focusedChatNode}
      chatFlow={chatFlow}
    />
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-gray-400 text-[12px]">
      {label}
    </div>
  );
}

// Keep the WorkNode union exported for tests / consumers needing it.
export type { WorkNode };
