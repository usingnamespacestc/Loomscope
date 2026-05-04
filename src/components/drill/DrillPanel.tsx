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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatNodeDetail } from "@/components/drill/ChatNodeDetail";
import { ConversationView } from "@/components/drill/ConversationView";
import { WorkNodeDetail } from "@/components/drill/WorkNodeDetail";
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
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {tab === "detail" && (
          <DetailTabContent
            sessionId={sessionId}
            chatFlow={chatFlow}
            viewMode={viewMode}
            drilledChatNode={drilledChatNode}
          />
        )}
        {tab === "conversation" && (
          <ConversationView sessionId={sessionId} chatFlow={chatFlow} />
        )}
      </div>
    </aside>
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
  return (
    <div
      data-testid="drill-panel-tabs"
      className="flex items-center border-b border-gray-200 bg-white"
    >
      <TabButton
        active={activeTab === "detail"}
        onClick={() => onSelect("detail")}
        testId="drill-panel-tab-detail"
        label="Detail"
      />
      <TabButton
        active={activeTab === "conversation"}
        onClick={() => onSelect("conversation")}
        testId="drill-panel-tab-conversation"
        label="Conversation"
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
  const selectedChatId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const selectedWorkId = useStore(
    (s) => s.sessions.get(sessionId)?.workflowSelectedNodeId ?? null,
  );

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
      ? drilledChatNode.workflow.nodes.find((n) => n.id === selectedWorkId) ?? null
      : null;
    return { kind: "worknode" as const, workNode: wn };
  }, [viewMode, selectedChatId, selectedWorkId, chatFlow, drilledChatNode]);

  return (
    <>
      {focused.kind === "chatnode" && focused.chatNode && (
        <ChatNodeDetail chatNode={focused.chatNode} chatFlow={chatFlow} />
      )}
      {focused.kind === "chatnode" && !focused.chatNode && (
        <EmptyHint label="点 ChatNode 查看详情" />
      )}
      {focused.kind === "worknode" && focused.workNode && (
        <WorkNodeDetail workNode={focused.workNode} sessionId={sessionId} />
      )}
      {focused.kind === "worknode" && !focused.workNode && (
        <EmptyHint label="点 WorkNode 查看详情" />
      )}
      {focused.kind === "empty" && <EmptyHint label="进入工作流后选 WorkNode 查看" />}
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

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-gray-400 text-[12px]">
      {label}
    </div>
  );
}

// Keep the WorkNode union exported for tests / consumers needing it.
export type { WorkNode };
