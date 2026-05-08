// EN: client-side mirror of SessionRegistry's per-session state.
// SSE feeds three event types into this slice:
//   - sdk-queue-state: state machine + pending queue snapshot
//   - sdk-message: every SDKMessage frame (assistant chunks, results,
//     errors). Stored as `lastMessage` so consumers can render
//     transient streaming state; we don't keep a long log here
//     because the jsonl file watch path renders the durable
//     transcript.
//   - sdk-session-closed: registry dropped the entry; clear state.
//
// Inflight is keyed by sessionId so multiple sessions running at once
// each get their own slot. Pending bubbles + the "running" indicator
// in Header / Sidebar / Composer all read from here.
//
// 中: 客户端镜像服务端 SessionRegistry 状态。SSE 推 3 种事件：
// queue-state（状态机 + 待处理列表快照）、sdk-message（实时帧，
// 仅留最新一条）、session-closed（注册表删条目时清干净）。

import type { StateCreator } from "zustand";

import type { LoomscopeStore } from "@/store/types";

export type SdkSessionState = "idle" | "running";
export type SdkPriority = "now" | "next" | "later";

export interface SdkPendingPrompt {
  id: string;
  text: string;
  imageCount: number;
  priority: SdkPriority;
  createdAt: number;
}

export interface SdkInflight {
  state: SdkSessionState;
  currentRun: { promptItemId: string; startedAt: number } | null;
  pendingPrompts: SdkPendingPrompt[];
  // Last error from a failed POST (network / 4xx). Cleared on next
  // successful action. Composer renders this inline.
  lastError: string | null;
}

const EMPTY_INFLIGHT: SdkInflight = {
  state: "idle",
  currentRun: null,
  pendingPrompts: [],
  lastError: null,
};

export interface SdkChannelSlice {
  inflightBySession: Map<string, SdkInflight>;

  // Reducers fed by App.tsx SSE handlers.
  applySdkQueueState: (
    sessionId: string,
    payload: {
      state: SdkSessionState;
      currentRun: SdkInflight["currentRun"];
      pendingPrompts: SdkPendingPrompt[];
    },
  ) => void;
  clearSdkSession: (sessionId: string) => void;
  // Set/clear an inline error message after a failed API call.
  setSdkError: (sessionId: string, message: string | null) => void;
}

export const createSdkChannelSlice: StateCreator<
  LoomscopeStore,
  [],
  [],
  SdkChannelSlice
> = (set, get) => ({
  inflightBySession: new Map(),

  applySdkQueueState: (sessionId, payload) => {
    const cur = get().inflightBySession.get(sessionId) ?? EMPTY_INFLIGHT;
    const next: SdkInflight = {
      state: payload.state,
      currentRun: payload.currentRun,
      pendingPrompts: payload.pendingPrompts,
      lastError: cur.lastError, // queue-state events don't override errors
    };
    const m = new Map(get().inflightBySession);
    m.set(sessionId, next);
    set({ inflightBySession: m });
  },

  clearSdkSession: (sessionId) => {
    if (!get().inflightBySession.has(sessionId)) return;
    const m = new Map(get().inflightBySession);
    m.delete(sessionId);
    set({ inflightBySession: m });
  },

  setSdkError: (sessionId, message) => {
    const cur = get().inflightBySession.get(sessionId) ?? EMPTY_INFLIGHT;
    const m = new Map(get().inflightBySession);
    m.set(sessionId, { ...cur, lastError: message });
    set({ inflightBySession: m });
  },
});

/** Stable empty for selectors that need to return a non-null shape. */
export function getInflight(
  store: LoomscopeStore,
  sessionId: string,
): SdkInflight {
  return store.inflightBySession.get(sessionId) ?? EMPTY_INFLIGHT;
}
