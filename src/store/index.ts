// Combined Zustand store. Persist middleware narrows to UI-only via
// `partialize` — session data and SSE subscriptions are runtime-only and
// re-fetched/re-subscribed on app boot.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { LoomscopeStore } from "@/store/types";
import { createLiveEventSlice } from "@/store/liveEventSlice";
import { createSessionSlice } from "@/store/sessionSlice";
import { createTaskListSlice } from "@/store/taskListSlice";
import { createGitFilesSlice } from "@/store/gitFilesSlice";
import { createSdkChannelSlice } from "@/store/sdkChannelSlice";
import { createUISlice } from "@/store/uiSlice";
import { createWorkspaceSlice } from "@/store/workspaceSlice";

export const useStore = create<LoomscopeStore>()(
  persist(
    (set, get, api) => ({
      ...createUISlice(set, get, api),
      ...createWorkspaceSlice(set, get, api),
      ...createSessionSlice(set, get, api),
      ...createLiveEventSlice(set, get, api),
      ...createTaskListSlice(set, get, api),
      ...createGitFilesSlice(set, get, api),
      ...createSdkChannelSlice(set, get, api),
    }),
    {
      name: "loomscope:state",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        drillPanelWidth: state.drillPanelWidth,
        drillPanelCollapsed: state.drillPanelCollapsed,
        drillPanelTab: state.drillPanelTab,
        drillPanelFullscreen: state.drillPanelFullscreen,
        prevDrillPanelWidth: state.prevDrillPanelWidth,
        pinnedWorkspaces: state.pinnedWorkspaces,
        hiddenWorkspaces: state.hiddenWorkspaces,
        focusedWorkspace: state.focusedWorkspace,
        // v0.11: persist last-active session so refresh lands the
        // user back on the same session (not the empty landing). The
        // sessions Map itself isn't persisted (full ChatFlow data,
        // re-fetched on load); App.tsx's existing
        //   useEffect → if activeId && !session → loadSession(activeId)
        // catches the rehydrated id and restores the canvas. If the
        // session was deleted from disk while we were away,
        // loadSession sets session.error and the user sees a clean
        // hint to pick a new one.
        activeSessionId: state.activeSessionId,
      }),
    },
  ),
);

export type { LoomscopeStore } from "@/store/types";
