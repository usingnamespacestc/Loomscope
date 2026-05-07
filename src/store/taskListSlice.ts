// CC TaskList store slice. Owns:
//   - `tasksBySession`: latest fetched task array per session
//   - inflight AbortController per session (race guard — fast SSE
//     bursts can fire refresh-while-load; last-write-wins)
//   - the panel collapsed/expanded UI pref
//   - load / refresh / clear actions
//
// Network: GET /api/sessions/:id/tasks → { tasks: CcTask[] } (sorted
// by id by the server). 404 / network error → empty array (CC may
// have never run TaskCreate for this session). The endpoint is read-
// only and idempotent; no CSRF needed.

import type { StateCreator } from "zustand";

import type {
  CcTask,
  LoomscopeStore,
  TaskListSlice,
} from "@/store/types";

const TASK_LIST_PANEL_COLLAPSED_KEY = "loomscope:taskListPanelCollapsed";

function loadCollapsedPref(): boolean {
  try {
    const raw = localStorage.getItem(TASK_LIST_PANEL_COLLAPSED_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // localStorage may be disabled in some environments
  }
  // Default to collapsed — keep canvas focus on the graph.
  return true;
}

function persistCollapsedPref(collapsed: boolean): void {
  try {
    localStorage.setItem(TASK_LIST_PANEL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // ignore
  }
}

async function fetchTasks(
  sessionId: string,
  signal: AbortSignal,
): Promise<CcTask[]> {
  const res = await fetch(`/api/sessions/${sessionId}/tasks`, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { tasks: CcTask[] };
  return data.tasks ?? [];
}

export const createTaskListSlice: StateCreator<
  LoomscopeStore,
  [],
  [],
  TaskListSlice
> = (set, get) => ({
  tasksBySession: new Map(),
  taskFetchControllers: new Map(),
  taskListPanelCollapsed: loadCollapsedPref(),

  setTaskListPanelCollapsed: (collapsed) => {
    persistCollapsedPref(collapsed);
    set({ taskListPanelCollapsed: collapsed });
  },

  loadTasks: async (sessionId) => {
    // Skip if we already have a snapshot AND no inflight (refresh covers
    // staleness). Idempotent: callers can hit on every session-mount
    // without flooding the backend.
    const state = get();
    if (
      state.tasksBySession.has(sessionId) &&
      !state.taskFetchControllers.has(sessionId)
    ) {
      return;
    }
    await get().refreshTasks(sessionId);
  },

  refreshTasks: async (sessionId) => {
    // Cancel any prior fetch — last-write-wins.
    const prior = get().taskFetchControllers.get(sessionId);
    prior?.abort();

    const ctrl = new AbortController();
    set((s) => {
      const next = new Map(s.taskFetchControllers);
      next.set(sessionId, ctrl);
      return { taskFetchControllers: next };
    });

    try {
      const tasks = await fetchTasks(sessionId, ctrl.signal);
      // Race guard: another refresh may have superseded ours.
      if (get().taskFetchControllers.get(sessionId) !== ctrl) return;
      set((s) => {
        const next = new Map(s.tasksBySession);
        next.set(sessionId, tasks);
        return { tasksBySession: next };
      });
    } catch (err) {
      // AbortError means a newer refresh took over — silent.
      if ((err as Error)?.name === "AbortError") return;
      console.error("[taskListSlice] fetch failed:", err);
    } finally {
      // Only clear our controller if it's still ours.
      if (get().taskFetchControllers.get(sessionId) === ctrl) {
        set((s) => {
          const next = new Map(s.taskFetchControllers);
          next.delete(sessionId);
          return { taskFetchControllers: next };
        });
      }
    }
  },

  clearTasks: (sessionId) => {
    get().taskFetchControllers.get(sessionId)?.abort();
    set((s) => {
      const tasks = new Map(s.tasksBySession);
      tasks.delete(sessionId);
      const ctrls = new Map(s.taskFetchControllers);
      ctrls.delete(sessionId);
      return { tasksBySession: tasks, taskFetchControllers: ctrls };
    });
  },
});
