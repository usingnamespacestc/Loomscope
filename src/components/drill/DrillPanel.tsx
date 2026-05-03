// Right-side resizable drill panel — surfaces the full content of the
// currently selected node. Position chosen per design抉择 1 (matches
// Agentloom ConversationView layout). Mode-following per design抉择 2:
// in ChatFlow view shows ChatNode detail; in WorkFlow view shows
// WorkNode detail.
//
// Toggle button on the panel header lets users collapse to a 12px
// strip when they need full canvas width — preferred over hard-hide
// so the strip stays as a re-entry affordance.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatNodeDetail } from "@/components/drill/ChatNodeDetail";
import { WorkNodeDetail } from "@/components/drill/WorkNodeDetail";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode, WorkNode } from "@/data/types";

interface Props {
  sessionId: string;
  chatFlow: ChatFlow;
  // ``chatnode`` when the main viewport is the ChatFlow canvas;
  // ``workflow`` when drilled into a WorkFlow. Drives which detail
  // component renders.
  viewMode: "chatflow" | "workflow";
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
  const selectedChatId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const selectedWorkId = useStore(
    (s) => s.sessions.get(sessionId)?.workflowSelectedNodeId ?? null,
  );

  // Resolve the currently focused node based on viewMode + selection.
  const focused = useMemo(() => {
    if (viewMode === "chatflow") {
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
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
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
      </div>
    </aside>
  );
}

function Header({
  viewMode,
  drilledChatNode,
  onCollapse,
}: {
  viewMode: "chatflow" | "workflow";
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
