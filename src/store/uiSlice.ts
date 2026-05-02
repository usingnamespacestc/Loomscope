import type { StateCreator } from "zustand";

import type { LoomscopeStore, UISlice } from "@/store/types";

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 600;

export const createUISlice: StateCreator<LoomscopeStore, [], [], UISlice> = (set) => ({
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsed: false,
  pinnedWorkspaces: [],
  hiddenWorkspaces: [],
  focusedWorkspace: null,

  setSidebarWidth: (w) =>
    set({ sidebarWidth: Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w)) }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  pinWorkspace: (cwd) =>
    set((s) => ({
      pinnedWorkspaces: s.pinnedWorkspaces.includes(cwd)
        ? s.pinnedWorkspaces
        : [...s.pinnedWorkspaces, cwd],
    })),

  unpinWorkspace: (cwd) =>
    set((s) => ({ pinnedWorkspaces: s.pinnedWorkspaces.filter((x) => x !== cwd) })),

  hideWorkspace: (cwd) =>
    set((s) => ({
      hiddenWorkspaces: s.hiddenWorkspaces.includes(cwd)
        ? s.hiddenWorkspaces
        : [...s.hiddenWorkspaces, cwd],
    })),

  unhideWorkspace: (cwd) =>
    set((s) => ({ hiddenWorkspaces: s.hiddenWorkspaces.filter((x) => x !== cwd) })),

  setFocusedWorkspace: (cwd) => set({ focusedWorkspace: cwd }),
});
