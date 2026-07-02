import type { StateCreator } from "zustand";
import { apiFetch } from "@/api/http";

import type { LoomscopeStore, UISlice } from "@/store/types";

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 600;

const DEFAULT_DRILL_PANEL_WIDTH = 380;
const MIN_DRILL_PANEL_WIDTH = 240;
// v0.8.1 #7: dropped the upper clamp. Users running 80% of their
// session in Conversation mode want to drag the panel to swallow the
// canvas. The previous 720px cap forced a roundabout multi-step
// resize. min stays so the resize handle can't disappear.

export const createUISlice: StateCreator<LoomscopeStore, [], [], UISlice> = (set) => ({
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsed: false,
  interactiveMode: true,
  serverPermissionMode: null,
  drillPanelWidth: DEFAULT_DRILL_PANEL_WIDTH,
  drillPanelCollapsed: false,
  // v0.8.1 #7: full-canvas mode. When true, the panel covers the
  // canvas area entirely (sidebar still visible). prevDrillPanelWidth
  // caches the pre-fullscreen drag width so toggling back restores it.
  drillPanelFullscreen: false,
  prevDrillPanelWidth: null,
  conversationHoveredChatNodeId: null,
  // Default "detail" preserves v0.4-v0.7 single-view behaviour for
  // first-time users; persisted via partialize so subsequent loads
  // honour the user's last selection.
  drillPanelTab: "detail" as const,
  pinnedWorkspaces: [],
  hiddenWorkspaces: [],
  focusedWorkspace: null,

  setSidebarWidth: (w) =>
    set({ sidebarWidth: Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w)) }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setDrillPanelWidth: (w) =>
    set({
      // No upper clamp (v0.8.1 #7). Min stays so the resize handle is
      // never < the touch-target minimum.
      drillPanelWidth: Math.max(MIN_DRILL_PANEL_WIDTH, w),
    }),

  toggleDrillPanel: () =>
    set((s) => ({
      drillPanelCollapsed: !s.drillPanelCollapsed,
      // Collapsing while in fullscreen would leave the panel in an
      // invisible but-still-fullscreen state. Exit fullscreen on any
      // collapse toggle so the state machine has only legal
      // configurations.
      drillPanelFullscreen: false,
      drillPanelWidth:
        s.drillPanelFullscreen && s.prevDrillPanelWidth != null
          ? s.prevDrillPanelWidth
          : s.drillPanelWidth,
      prevDrillPanelWidth: null,
    })),

  toggleDrillPanelFullscreen: () =>
    set((s) => {
      if (s.drillPanelFullscreen) {
        // Exit: restore the cached width if any.
        return {
          drillPanelFullscreen: false,
          drillPanelWidth: s.prevDrillPanelWidth ?? s.drillPanelWidth,
          prevDrillPanelWidth: null,
        };
      }
      // Enter: cache the current width so we can restore it on exit.
      return {
        drillPanelFullscreen: true,
        prevDrillPanelWidth: s.drillPanelWidth,
      };
    }),

  setConversationHoveredChatNodeId: (id) =>
    set({ conversationHoveredChatNodeId: id }),

  setDrillPanelTab: (tab) => set({ drillPanelTab: tab }),

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

  setInteractiveMode: (next) => set({ interactiveMode: next }),

  setServerPermissionMode: (mode) => set({ serverPermissionMode: mode }),

  saveInteractiveMode: async (next) => {
    // Optimistic flip — if the PATCH fails we roll back. Keeps the
    // toggle responsive on slow networks while still surfacing
    // errors. The server is authoritative; on success its echoed
    // value lands here.
    set({ interactiveMode: next });
    try {
      const res = await apiFetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactiveMode: next }),
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const merged = (await res.json()) as { interactiveMode?: boolean };
      if (typeof merged.interactiveMode === "boolean") {
        set({ interactiveMode: merged.interactiveMode });
      }
      return true;
    } catch {
      // Roll back on failure.
      set({ interactiveMode: !next });
      return false;
    }
  },
});
