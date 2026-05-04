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

const COLLAPSED_WIDTH = 12;

export function DrillPanel({ sessionId, chatFlow, viewMode, drilledChatNode }: Props) {
  const width = useStore((s) => s.drillPanelWidth);
  const collapsed = useStore((s) => s.drillPanelCollapsed);
  const setWidth = useStore((s) => s.setDrillPanelWidth);
  const toggle = useStore((s) => s.toggleDrillPanel);
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

  return (
    <aside
      data-testid="drill-panel"
      className="relative flex h-full flex-col border-l border-gray-200 bg-gray-50"
      style={{ width, minWidth: width, maxWidth: width }}
    >
      <ResizeHandle width={width} setWidth={setWidth} />
      <Header
        viewMode={viewMode}
        drilledChatNode={drilledChatNode}
        onCollapse={toggle}
      />
      <TabStrip activeTab={tab} onSelect={setTab} />
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

// 2-tab strip — sits between Header and content. Per hard constraint
// #11, switching between tabs MUST not affect Detail tab content
// behaviour (it's just a visibility toggle, not a re-render trigger).
function TabStrip({
  activeTab,
  onSelect,
}: {
  activeTab: DrillPanelTab;
  onSelect: (tab: DrillPanelTab) => void;
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
        <ChatNodeDetail chatNode={focused.chatNode} />
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

function Header({
  viewMode,
  drilledChatNode,
  onCollapse,
}: {
  viewMode: "chatflow" | "workflow" | "sub-chatflow";
  drilledChatNode: ChatNode | null;
  onCollapse: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-200 bg-white">
      <span className="text-[10px] font-semibold tracking-widest text-gray-500">
        DETAIL
      </span>
      {viewMode === "workflow" && drilledChatNode && (
        // Mode-following + breadcrumb: keep parent ChatNode visible
        // even when the panel is rendering WorkNode detail (per
        // design抉择 2).
        <span
          className="ml-1 inline-flex items-center gap-1 truncate text-[10px] text-gray-400 font-mono"
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
        onClick={onCollapse}
        title="Collapse panel"
        data-testid="drill-panel-collapse"
      >
        ▶
      </button>
    </div>
  );
}

function CollapsedStrip({
  width,
  onExpand,
}: {
  width: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className="h-full border-l border-gray-200 bg-gray-100 hover:bg-blue-50 transition-colors flex items-center justify-center text-gray-400 hover:text-blue-600 cursor-pointer"
      style={{ width, minWidth: width }}
      onClick={onExpand}
      title="Expand drill panel"
      data-testid="drill-panel-expand"
    >
      ◀
    </button>
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
