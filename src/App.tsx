// v0.2 layout: header above, sidebar left, canvas filling remaining area.

import { useEffect } from "react";

import { ChatFlowCanvas } from "@/canvas/ChatFlowCanvas";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { useStore } from "@/store/index";

export default function App() {
  const activeId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeId ? s.sessions.get(activeId) : null));

  useEffect(() => {
    // Auto-fetch when active id changes and we don't already have it.
    if (activeId && !session) {
      void useStore.getState().loadSession(activeId);
    }
  }, [activeId, session]);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 text-gray-900">
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 relative" data-testid="canvas-host">
          {!activeId && <EmptyState />}
          {activeId && session?.isLoading && <LoadingState />}
          {activeId && session?.error && <ErrorState message={session.error} />}
          {activeId && session?.chatFlow && (
            <ChatFlowCanvas chatFlow={session.chatFlow} sessionId={activeId} />
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">
      Select a session from the sidebar to view its ChatFlow.
    </div>
  );
}

function LoadingState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
      <span className="animate-pulse">Parsing JSONL…</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-red-600 text-sm">
      <span>Failed to load session.</span>
      <code className="text-xs bg-red-50 px-2 py-1 rounded">{message}</code>
    </div>
  );
}
