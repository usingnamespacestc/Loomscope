// CC TaskList store slice. Owns:
//   - `tasksBySession`: latest fetched task array per session
//   - inflight AbortController per session (race guard — fast SSE
//     bursts can fire refresh-while-load; last-write-wins)
//   - per-session debounce timer so SSE-invalidate + TaskCreated-hook
//     bursts (which fire within ~50ms of each other for the same
//     ~/.claude/tasks/<sid>/*.json write) coalesce into one fetch
//     instead of cancel-then-retry showing up as "(failed)" + "200"
//     pairs in devtools network panel.
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

// SSE invalidate (kind:"tasks") and TaskCreated hook fire for the
// same disk write within ~50-100ms of each other. Without coalescing,
// each pair produces a "(canceled)" + "200" in devtools network. 80ms
// window is short enough that a real successive change (user
// completing one task right after creating another) still gets a
// fresh fetch within ~100ms of its triggering invalidate; long
// enough to absorb the SSE-vs-hook duplicate.
const REFRESH_DEBOUNCE_MS = 80;
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const refreshResolvers = new Map<string, Array<() => void>>();

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

  refreshTasks: (sessionId) =>
    new Promise<void>((resolve) => {
      // Coalesce SSE-invalidate + TaskCreated-hook duplicates. Each
      // call (re)schedules a single fetch at REFRESH_DEBOUNCE_MS
      // from now; earlier callers' returned Promises still resolve
      // when that single fetch completes.
      const existing = refreshTimers.get(sessionId);
      if (existing) clearTimeout(existing);
      const resolvers = refreshResolvers.get(sessionId) ?? [];
      resolvers.push(resolve);
      refreshResolvers.set(sessionId, resolvers);

      const timer = setTimeout(async () => {
        refreshTimers.delete(sessionId);
        const pending = refreshResolvers.get(sessionId) ?? [];
        refreshResolvers.delete(sessionId);

        // DON'T abort a prior inflight fetch — even though the new
        // batch is fresher, calling .abort() surfaces as
        // "(canceled)" / "failed to load response data" in devtools.
        // The controller-mismatch guard below (`controllers.get !==
        // ctrl`) is enough to last-write-wins discard the stale
        // result silently. Cost: prior fetch completes uselessly
        // (one redundant 200 in network panel), but only when fetch
        // was slow enough to still be inflight after the debounce
        // window — and that's the only case where abort would have
        // fired anyway. clearTasks is the explicit-cancel path.
        const ctrl = new AbortController();
        set((s) => {
          const next = new Map(s.taskFetchControllers);
          next.set(sessionId, ctrl);
          return { taskFetchControllers: next };
        });

        try {
          const tasks = await fetchTasks(sessionId, ctrl.signal);
          if (get().taskFetchControllers.get(sessionId) !== ctrl) return;
          set((s) => {
            const next = new Map(s.tasksBySession);
            next.set(sessionId, tasks);
            return { tasksBySession: next };
          });
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
          console.error("[taskListSlice] fetch failed:", err);
        } finally {
          if (get().taskFetchControllers.get(sessionId) === ctrl) {
            set((s) => {
              const next = new Map(s.taskFetchControllers);
              next.delete(sessionId);
              return { taskFetchControllers: next };
            });
          }
          for (const r of pending) r();
        }
      }, REFRESH_DEBOUNCE_MS);
      refreshTimers.set(sessionId, timer);
    }),

  clearTasks: (sessionId) => {
    get().taskFetchControllers.get(sessionId)?.abort();
    // Cancel any pending debounced refresh + resolve waiters as no-op
    // so callers don't hang on a Promise we'll never fulfil.
    const t = refreshTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      refreshTimers.delete(sessionId);
    }
    const pending = refreshResolvers.get(sessionId);
    if (pending) {
      refreshResolvers.delete(sessionId);
      for (const r of pending) r();
    }
    set((s) => {
      const tasks = new Map(s.tasksBySession);
      tasks.delete(sessionId);
      const ctrls = new Map(s.taskFetchControllers);
      ctrls.delete(sessionId);
      return { tasksBySession: tasks, taskFetchControllers: ctrls };
    });
  },
});
