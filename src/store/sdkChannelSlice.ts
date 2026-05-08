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

export type RespawnReason = "per-send" | "staleness-detected";

export interface SdkInflight {
  state: SdkSessionState;
  currentRun: { promptItemId: string; startedAt: number } | null;
  pendingPrompts: SdkPendingPrompt[];
  // Last error from a failed POST (network / 4xx). Cleared on next
  // successful action. Composer renders this inline.
  lastError: string | null;
  /** Server announced a respawn (close + fresh spawn) before
   *  dispatching the next turn — see
   *  `docs/dual-writer-race-mitigation.md`. Composer renders a brief
   *  banner so the user understands the few-hundred-ms latency
   *  bump. Auto-cleared on the next `sdk-message` arrival (= the
   *  fresh Query produced output) or by a 10s timeout, whichever
   *  fires first. Null when no respawn is in flight. */
  respawnNotice: { startedAt: number; reason: RespawnReason } | null;
}

const EMPTY_INFLIGHT: SdkInflight = {
  state: "idle",
  currentRun: null,
  pendingPrompts: [],
  lastError: null,
  respawnNotice: null,
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
  // Race-mitigation respawn notice (see docs/dual-writer-race-
  // mitigation.md). Set on `sdk-respawn-notice` SSE arrival;
  // cleared on next `sdk-message` arrival or 10s timeout, both
  // driven from App.tsx.
  setRespawnNotice: (
    sessionId: string,
    notice: { startedAt: number; reason: RespawnReason } | null,
  ) => void;
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
      respawnNotice: cur.respawnNotice, // ditto for the race banner
    };
    const m = new Map(get().inflightBySession);
    m.set(sessionId, next);
    set({ inflightBySession: m });
  },

  clearSdkSession: (sessionId) => {
    const cur = get().inflightBySession.get(sessionId);
    if (!cur) return;
    // Race-mitigation respawn path: SessionRegistry's
    // `respawnPreservingQueue` calls close() which broadcasts
    // sdk-session-closed RIGHT BEFORE the new spawn fires its first
    // sdk-queue-state. If we full-clear the entry here, the
    // respawnNotice we set milliseconds earlier (from the
    // sdk-respawn-notice event) gets wiped and the composer banner
    // never visibly appears. Treat session-closed as transient when
    // a respawn is mid-flight: reset queue state but PRESERVE the
    // notice so the banner survives until the new Query's first
    // sdk-message arrival clears it normally.
    if (cur.respawnNotice) {
      const m = new Map(get().inflightBySession);
      m.set(sessionId, {
        state: "idle",
        currentRun: null,
        pendingPrompts: [],
        lastError: null,
        respawnNotice: cur.respawnNotice,
      });
      set({ inflightBySession: m });
      return;
    }
    // Genuine close (idle eviction, shutdown, abnormal subprocess
    // exit) — drop the entry entirely so no stale state lingers.
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

  setRespawnNotice: (sessionId, notice) => {
    const cur = get().inflightBySession.get(sessionId);
    // Skip allocation when clearing a session that was never set —
    // common case: every `sdk-message` arrival fires a clear, and
    // most sessions never had a notice set.
    if (!cur && notice === null) return;
    const m = new Map(get().inflightBySession);
    m.set(sessionId, { ...(cur ?? EMPTY_INFLIGHT), respawnNotice: notice });
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
