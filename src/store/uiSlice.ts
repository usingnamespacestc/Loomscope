import type { StateCreator } from "zustand";

import type { LoomscopeStore, UISlice } from "@/store/types";

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 600;

const DEFAULT_DRILL_PANEL_WIDTH = 380;
const MIN_DRILL_PANEL_WIDTH = 240;
const MAX_DRILL_PANEL_WIDTH = 720;

export const createUISlice: StateCreator<LoomscopeStore, [], [], UISlice> = (set) => ({
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsed: false,
  drillPanelWidth: DEFAULT_DRILL_PANEL_WIDTH,
  drillPanelCollapsed: false,
  pinnedWorkspaces: [],
  hiddenWorkspaces: [],
  focusedWorkspace: null,

  setSidebarWidth: (w) =>
    set({ sidebarWidth: Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w)) }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setDrillPanelWidth: (w) =>
    set({
      drillPanelWidth: Math.min(
        MAX_DRILL_PANEL_WIDTH,
        Math.max(MIN_DRILL_PANEL_WIDTH, w),
      ),
    }),

  toggleDrillPanel: () =>
    set((s) => ({ drillPanelCollapsed: !s.drillPanelCollapsed })),

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
