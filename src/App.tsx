// v0.2 layout: header above, sidebar left, canvas filling remaining area.
// v0.3: drill-down WorkFlow view replaces the main viewport when
// ``drillStack`` is non-empty. The chosen drill model (option C) means
// only one canvas type renders at a time — picked by ``viewMode``.
// Breadcrumb pinned top-left when in WorkFlow view to navigate back.
//
// Visual chrome per `design-visual-language.md` 视觉 token 章节.

import { useEffect, useMemo } from "react";

import { ChatFlowCanvas } from "@/canvas/ChatFlowCanvas";
import { WorkFlowCanvas } from "@/canvas/WorkFlowCanvas";
import { DrillPanel } from "@/components/drill/DrillPanel";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode } from "@/data/types";

export default function App() {
  const activeId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeId ? s.sessions.get(activeId) : null));

  useEffect(() => {
    if (activeId && !session) {
      void useStore.getState().loadSession(activeId);
    }
  }, [activeId, session]);

  // Resolve which view to show + which ChatNode (if drilled). Computing
  // here rather than inside the canvas so the breadcrumb has access to
  // the same data without separate selectors.
  const view = useMemo(() => {
    if (!session?.chatFlow || !activeId) return { mode: "chatflow" as const };
    const top = session.drillStack[0];
    if (!top || top.kind !== "chatnode") return { mode: "chatflow" as const };
    const cn = findChatNode(session.chatFlow, top.chatNodeId);
    if (!cn) return { mode: "chatflow" as const }; // stale id — silent fallback
    return { mode: "workflow" as const, chatNode: cn };
  }, [session?.chatFlow, session?.drillStack, activeId]);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 text-gray-900">
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 relative bg-gray-100" data-testid="canvas-host">
          {!activeId && <EmptyState />}
          {activeId && session?.isLoading && <LoadingState />}
          {activeId && session?.error && <ErrorState message={session.error} />}
          {activeId && session?.chatFlow && view.mode === "chatflow" && (
            <ChatFlowCanvas chatFlow={session.chatFlow} sessionId={activeId} />
          )}
          {activeId && session?.chatFlow && view.mode === "workflow" && (
            <>
              <WorkFlowCanvas chatNode={view.chatNode} sessionId={activeId} />
              <DrillBreadcrumb sessionId={activeId} chatNode={view.chatNode} />
            </>
          )}
        </main>
        {activeId && session?.chatFlow && (
          <DrillPanel
            sessionId={activeId}
            chatFlow={session.chatFlow}
            viewMode={view.mode}
            drilledChatNode={view.mode === "workflow" ? view.chatNode : null}
          />
        )}
      </div>
    </div>
  );
}

function findChatNode(cf: ChatFlow, id: string): ChatNode | null {
  // Linear lookup is fine — ChatFlow has at most ~1500 nodes per
  // 256MB session and this only runs once per render.
  for (const cn of cf.chatNodes) if (cn.id === id) return cn;
  return null;
}

function DrillBreadcrumb({
  sessionId,
  chatNode,
}: {
  sessionId: string;
  chatNode: ChatNode;
}) {
  const exitWorkflow = useStore((s) => s.exitWorkflow);
  const previewId = chatNode.id.length > 12 ? `${chatNode.id.slice(0, 12)}…` : chatNode.id;
  return (
    <nav
      data-testid="drill-breadcrumb"
      className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded border border-gray-300 bg-white/90 px-2.5 py-1.5 text-xs text-gray-700 shadow-sm"
    >
      <button
        type="button"
        onClick={() => exitWorkflow(sessionId)}
        data-testid="exit-workflow"
        className="hover:text-blue-600 hover:underline transition-colors"
      >
        ← ChatFlow
      </button>
      <span className="text-gray-400">/</span>
      <span
        className="font-mono text-[11px] text-gray-900"
        title={`ChatNode ${chatNode.id}`}
      >
        WorkFlow ({previewId})
      </span>
    </nav>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
      <div className="text-5xl opacity-40">⌬</div>
      <div className="text-sm">
        Select a session from the <span className="text-gray-500 font-medium">sidebar</span> to view its ChatFlow.
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500">
      <span className="inline-flex items-center gap-2 rounded bg-teal-100 px-3 py-1.5 text-sm font-medium text-teal-900">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-teal-500" />
        Parsing JSONL…
      </span>
      <span className="text-[11px] text-gray-400">Large sessions may take a few seconds.</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-rose-700">
      <span className="text-3xl">✗</span>
      <span className="text-sm font-medium">Failed to load session.</span>
      <code className="text-[11px] bg-rose-50 border border-rose-200 px-2 py-1 rounded font-mono text-rose-900 max-w-[480px] break-words">
        {message}
      </code>
    </div>
  );
}
