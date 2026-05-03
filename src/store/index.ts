// Combined Zustand store. Persist middleware narrows to UI-only via
// `partialize` — session data and SSE subscriptions are runtime-only and
// re-fetched/re-subscribed on app boot.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { LoomscopeStore } from "@/store/types";
import { createLiveEventSlice } from "@/store/liveEventSlice";
import { createSessionSlice } from "@/store/sessionSlice";
import { createUISlice } from "@/store/uiSlice";
import { createWorkspaceSlice } from "@/store/workspaceSlice";

export const useStore = create<LoomscopeStore>()(
  persist(
    (set, get, api) => ({
      ...createUISlice(set, get, api),
      ...createWorkspaceSlice(set, get, api),
      ...createSessionSlice(set, get, api),
      ...createLiveEventSlice(set, get, api),
    }),
    {
      name: "loomscope:state",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        drillPanelWidth: state.drillPanelWidth,
        drillPanelCollapsed: state.drillPanelCollapsed,
        pinnedWorkspaces: state.pinnedWorkspaces,
        hiddenWorkspaces: state.hiddenWorkspaces,
        focusedWorkspace: state.focusedWorkspace,
      }),
    },
  ),
);

export type { LoomscopeStore } from "@/store/types";
