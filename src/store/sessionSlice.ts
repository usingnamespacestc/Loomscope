import type { StateCreator } from "zustand";

import type { ChatFlow } from "@/data/types";
import type { LoomscopeStore, SessionSlice, SessionState } from "@/store/types";

const EMPTY_VIEWPORT = { x: 0, y: 0, zoom: 1 };

function blankSessionState(): SessionState {
  return {
    chatFlow: null,
    foldedNodeIds: new Set<string>(),
    viewport: EMPTY_VIEWPORT,
    selectedNodeId: null,
    isLoading: false,
    error: null,
    lastUpdated: 0,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return (await res.json()) as T;
}

export const createSessionSlice: StateCreator<LoomscopeStore, [], [], SessionSlice> = (
  set,
  get,
) => ({
  sessions: new Map<string, SessionState>(),
  activeSessionId: null,

  loadSession: async (id) => {
    const next = new Map(get().sessions);
    const prev = next.get(id) ?? blankSessionState();
    next.set(id, { ...prev, isLoading: true, error: null });
    set({ sessions: next });

    try {
      const cf = await fetchJson<ChatFlow>(`/api/sessions/${id}`);
      const updated = new Map(get().sessions);
      const cur = updated.get(id) ?? blankSessionState();
      updated.set(id, {
        ...cur,
        chatFlow: cf,
        isLoading: false,
        error: null,
        lastUpdated: Date.now(),
      });
      set({ sessions: updated });
    } catch (err) {
      const updated = new Map(get().sessions);
      const cur = updated.get(id) ?? blankSessionState();
      updated.set(id, {
        ...cur,
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      set({ sessions: updated });
    }
  },

  setActiveSession: (id) => {
    if (id && !get().sessions.has(id)) {
      // Auto-load if we haven't fetched it yet. Fire-and-forget.
      void get().loadSession(id);
    }
    set({ activeSessionId: id });
  },

  toggleFold: (sessionId, nodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    const folded = new Set(cur.foldedNodeIds);
    if (folded.has(nodeId)) folded.delete(nodeId);
    else folded.add(nodeId);
    updated.set(sessionId, { ...cur, foldedNodeIds: folded });
    set({ sessions: updated });
  },

  setSelected: (sessionId, nodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    updated.set(sessionId, { ...cur, selectedNodeId: nodeId });
    set({ sessions: updated });
  },

  setViewport: (sessionId, vp) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    updated.set(sessionId, { ...cur, viewport: vp });
    set({ sessions: updated });
  },
});
