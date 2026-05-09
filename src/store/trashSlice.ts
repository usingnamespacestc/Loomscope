// EN: trash UI state + mutation actions. Holds the list of trashed
// sessions returned by GET /api/trash and exposes
// trash/restore/purge/empty operations that keep the rest of the
// store consistent (drop from sessionsByCwd on trash, refetch the
// owning workspace on restore, clear active session if the user
// trashed it).
//
// 中: 回收站 UI state + 5 个变更操作。trash 后从 sessionsByCwd 移除，
// restore 后刷新原 workspace；删的是当前 active session 则跳回 empty。

import type { StateCreator } from "zustand";

import {
  emptyTrash as apiEmptyTrash,
  listTrashedSessions,
  purgeTrashedSession,
  restoreTrashedSession,
  trashSession as apiTrashSession,
  type TrashedSession,
} from "@/api/trash";
import type { LoomscopeStore } from "@/store/types";

export interface TrashSlice {
  trashedSessions: TrashedSession[];
  trashLoading: boolean;
  trashError: string | null;
  /** Sidebar 回收站 folder open/closed state. Persisted via the same
   *  partialize allowlist as expandedCwds (added in store/index.ts). */
  trashExpanded: boolean;

  refreshTrash: () => Promise<void>;
  /** Soft-delete: server moves the jsonl, store removes from
   *  sessionsByCwd + workspace counts + adds to trashedSessions.
   *  If the deleted sid is currently active, also clear active. */
  trashSession: (sessionId: string, cwd: string) => Promise<{
    ok: true;
  } | { ok: false; error: string }>;
  /** Restore from trash. Pulls the session out of trashedSessions
   *  and re-fetches the owning workspace's session list so the
   *  restored row reappears. */
  restoreSession: (sessionId: string) => Promise<{
    ok: true;
  } | { ok: false; error: string }>;
  /** Hard delete (permanent). */
  purgeSession: (sessionId: string) => Promise<{
    ok: true;
  } | { ok: false; error: string }>;
  /** Wipe entire trash. */
  emptyTrash: () => Promise<{ ok: true; count: number } | { ok: false; error: string }>;
  toggleTrashExpanded: () => void;
}

export const createTrashSlice: StateCreator<
  LoomscopeStore,
  [],
  [],
  TrashSlice
> = (set, get) => ({
  trashedSessions: [],
  trashLoading: false,
  trashError: null,
  trashExpanded: false,

  refreshTrash: async () => {
    set({ trashLoading: true, trashError: null });
    const r = await listTrashedSessions();
    if ("ok" in r && r.ok === false) {
      set({ trashLoading: false, trashError: r.error });
      return;
    }
    set({ trashedSessions: r as TrashedSession[], trashLoading: false });
  },

  trashSession: async (sessionId, cwd) => {
    const r = await apiTrashSession(sessionId);
    if ("ok" in r && r.ok === false) return { ok: false, error: r.error };
    const trashed = r as TrashedSession;

    // Drop from sessionsByCwd + decrement workspace count.
    const sessionsByCwd = new Map(get().sessionsByCwd);
    const list = sessionsByCwd.get(cwd);
    if (list) {
      sessionsByCwd.set(
        cwd,
        list.filter((s) => s.sessionId !== sessionId),
      );
    }
    const workspaces = get().workspaces.map((w) =>
      w.cwd === cwd
        ? { ...w, sessionCount: Math.max(0, w.sessionCount - 1) }
        : w,
    );

    // Insert at top of trashedSessions (newest-trashed first).
    const trashedSessions = [trashed, ...get().trashedSessions];

    // Clear active session if the user just trashed it. App.tsx's
    // empty-state will render; the user can pick another session
    // or click into 回收站 to recover.
    const patch: Partial<LoomscopeStore> = {
      sessionsByCwd,
      workspaces,
      trashedSessions,
    };
    if (get().activeSessionId === sessionId) {
      patch.activeSessionId = null;
    }
    set(patch);
    return { ok: true };
  },

  restoreSession: async (sessionId) => {
    const r = await restoreTrashedSession(sessionId);
    if ("ok" in r && r.ok === false) return { ok: false, error: r.error };

    const trashed = get().trashedSessions.find(
      (t) => t.sessionId === sessionId,
    );
    set({
      trashedSessions: get().trashedSessions.filter(
        (t) => t.sessionId !== sessionId,
      ),
    });
    // Re-fetch the owning workspace so the restored row reappears
    // immediately. If the cwd is unknown (meta missing), force a full
    // workspace refresh as a fallback.
    if (trashed?.originalCwd) {
      void get().loadSessions(trashed.originalCwd);
    }
    void get().refreshWorkspaces();
    return { ok: true };
  },

  purgeSession: async (sessionId) => {
    const r = await purgeTrashedSession(sessionId);
    if ("ok" in r && r.ok === false) return { ok: false, error: r.error };
    set({
      trashedSessions: get().trashedSessions.filter(
        (t) => t.sessionId !== sessionId,
      ),
    });
    return { ok: true };
  },

  emptyTrash: async () => {
    const r = await apiEmptyTrash();
    if ("ok" in r && r.ok === false) return { ok: false, error: r.error };
    set({ trashedSessions: [] });
    return { ok: true, count: (r as { count: number }).count };
  },

  toggleTrashExpanded: () => {
    set({ trashExpanded: !get().trashExpanded });
  },
});
