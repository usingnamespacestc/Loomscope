// Stub for v∞.0. The real implementation will wire SSE per session and
// reconcile incoming hook events into the chatFlow held in `SessionSlice`.
// We define the slot now so component code can import the action names
// without creating churn when v∞ lands.

import type { StateCreator } from "zustand";

import type { LiveEventSlice, LoomscopeStore } from "@/store/types";

export const createLiveEventSlice: StateCreator<LoomscopeStore, [], [], LiveEventSlice> = () => ({
  ssePending: new Map<string, unknown>(),
  // No-ops in v0.2; replaced by SSE wiring in v∞.0.
  subscribeSession: () => undefined,
  unsubscribeSession: () => undefined,
});
