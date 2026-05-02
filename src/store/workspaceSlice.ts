import type { StateCreator } from "zustand";

import type {
  LoomscopeStore,
  SessionSummary,
  WorkspaceSlice,
  WorkspaceSummary,
} from "@/store/types";

async function fetchJson<T>(input: string): Promise<T> {
  const res = await fetch(input);
  if (!res.ok) throw new Error(`fetch ${input} → ${res.status}`);
  return (await res.json()) as T;
}

export const createWorkspaceSlice: StateCreator<LoomscopeStore, [], [], WorkspaceSlice> = (
  set,
  get,
) => ({
  workspaces: [],
  workspacesLoading: false,
  workspacesError: null,
  sessionsByCwd: new Map<string, SessionSummary[]>(),
  expandedCwds: new Set<string>(),

  refreshWorkspaces: async () => {
    set({ workspacesLoading: true, workspacesError: null });
    try {
      const items = await fetchJson<WorkspaceSummary[]>("/api/workspaces");
      set({ workspaces: items, workspacesLoading: false });
    } catch (err) {
      set({
        workspacesLoading: false,
        workspacesError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadSessions: async (cwd) => {
    const url = `/api/workspaces/${encodeURIComponent(cwd)}/sessions`;
    try {
      const items = await fetchJson<SessionSummary[]>(url);
      const next = new Map(get().sessionsByCwd);
      next.set(cwd, items);
      set({ sessionsByCwd: next });
    } catch (err) {
      // Persist the error onto the workspaces error slot for the sidebar
      // to surface; sessions list stays empty.
      set({ workspacesError: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleExpanded: (cwd) => {
    const next = new Set(get().expandedCwds);
    if (next.has(cwd)) {
      next.delete(cwd);
    } else {
      next.add(cwd);
      // Lazy-fetch sessions on first expand if we don't have them yet.
      if (!get().sessionsByCwd.has(cwd)) {
        // Fire-and-forget — don't block the toggle on network.
        void get().loadSessions(cwd);
      }
    }
    set({ expandedCwds: next });
  },
});
