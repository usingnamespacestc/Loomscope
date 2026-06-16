// v0.9.1: tracks SSE connection state per channel so the Header live
// indicator can show green/amber/red. App.tsx owns the EventSource
// lifecycle and calls setLiveStatus on readyState transitions.

import type { StateCreator } from "zustand";

import type { LiveEventSlice, LoomscopeStore } from "@/store/types";

export const createLiveEventSlice: StateCreator<
  LoomscopeStore,
  [],
  [],
  LiveEventSlice
> = (set) => ({
  liveStatus: { session: "idle", workspaces: "idle" },
  setLiveStatus: (channel, state) =>
    set((s) => ({
      liveStatus: { ...s.liveStatus, [channel]: state },
    })),
});
