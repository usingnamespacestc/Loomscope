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

/**
 * EN (v2.0.1 PR A): client mirror of the server's SDKRateLimitInfo.
 * Same shape as the SDK + server type — kept here to avoid pulling
 * server imports into the client store. Populated by `sdk-rate-limit`
 * SSE events; PR B's banner reads it.
 *
 * 中: 服务端 SDKRateLimitInfo 的客户端镜像。SSE 事件填，PR B banner 读。
 */
export interface SdkRateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?:
    | "five_hour"
    | "seven_day"
    | "seven_day_opus"
    | "seven_day_sonnet"
    | "overage";
  utilization?: number;
  surpassedThreshold?: number;
  receivedAt: number;
}

/**
 * EN (v2.0.1 PR B): rate-limit deferral state per session. When
 * `deferralUntilEpoch != null && Date.now() < deferralUntilEpoch`,
 * the auto-defer banner shows above the composer. Server emits
 * `sdk-deferral` SSE events for trigger / clear transitions.
 *
 * 中: 每 session 的 deferral 状态。banner 据此显示+倒计时。
 */
export interface SdkDeferralState {
  deferralUntilEpoch: number | null;
  reason: {
    utilization: number;
    rateLimitType: string;
    surpassedThreshold?: number;
    startedAt: number;
  } | null;
}

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
  /** P1 (2026-05-17): text of the prompt currently EXECUTING
   *  (currentRun), retained across the pending→running transition.
   *  When a Loomscope-composer prompt is dequeued to run it leaves
   *  `pendingPrompts` (its PendingBubble vanishes), but the SDK
   *  subprocess only flushes the user record to jsonl ~tens of
   *  seconds later — so for that whole window there is NO ChatNode
   *  and NO pending bubble, only the running-time stat (P1 report).
   *  The conversation renders an optimistic "running turn" bubble
   *  from this so the user's just-sent message shows immediately.
   *  null when nothing is executing.
   *  中: 正在执行的 prompt 文本，跨 pending→running 保留，供对话面板
   *  在 jsonl 落盘前即时显示"运行中的这一轮"。 */
  runningPromptText: string | null;
  /** P1 robustness (2026-05-17): client-known prompt text keyed by
   *  the itemId `postTurn` returns at SEND time. The original P1
   *  resolution derived runningPromptText ONLY from the SSE-delivered
   *  pending list — but SSE is broadcast-only with NO replay, so on a
   *  large/slow session the early `pending=[X]` event is often missed
   *  (subscribe-time race; same root as 327995e/P5) and the text
   *  resolved to null → no bubble, even though the running-time stat
   *  showed (state did reach running). Optimistic UI must NOT depend
   *  on the server echo: the client already knows the text it just
   *  POSTed. This is the SSE-timing-independent source of truth.
   *  FIFO-capped; stale entries are inert (the selector hides the
   *  bubble via tail-node match once the real ChatNode lands).
   *  中: 发送时 postTurn 返回 itemId，客户端本就知道文本——不依赖
   *  SSE 回声（broadcast-only 无 replay，大会话常丢早期 pending
   *  事件）。SSE 时序无关的权威来源，FIFO 限长，旧条目无害。 */
  sentTextByItemId: Map<string, string>;
}

// Bounds `sentTextByItemId` growth. Far more than any realistic
// in-flight queue depth; stale entries are inert (see field doc) so
// the only cost of keeping them is memory — a small FIFO cap suffices.
const SENT_TEXT_CAP = 16;

const EMPTY_INFLIGHT: SdkInflight = {
  state: "idle",
  currentRun: null,
  pendingPrompts: [],
  lastError: null,
  respawnNotice: null,
  runningPromptText: null,
  sentTextByItemId: new Map(),
};

export interface SdkChannelSlice {
  inflightBySession: Map<string, SdkInflight>;
  /**
   * EN (v2.0.1 PR A): latest rate_limit_event per session. CC emits
   * these on threshold crossings (75% / 90% / 100% / reset). PR B's
   * auto-defer banner reads here; PR B engine on server reacts.
   *
   * 中: 每 session 最近一次 rate_limit_event 快照。Banner 读这。
   */
  rateLimitBySession: Map<string, SdkRateLimitInfo>;

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
  /** P1 robustness: record the prompt text the client just POSTed,
   *  keyed by the itemId `postTurn` returned. Called from the
   *  composer the instant a send succeeds — SSE-timing-independent
   *  source for the optimistic running-turn bubble. */
  noteSdkSentPrompt: (
    sessionId: string,
    itemId: string,
    text: string,
  ) => void;
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
  /**
   * EN (v2.0.1 PR A): apply a freshly-arrived rate_limit_event into
   * the cache. Always overwrites — the latest event by definition
   * supersedes prior state (CC dedupes upstream via `isEqual`).
   *
   * 中: 收到 rate_limit_event SSE 后 set 进去；总是覆盖（最新即权威）。
   */
  applyRateLimitEvent: (sessionId: string, info: SdkRateLimitInfo) => void;

  /**
   * EN (v2.0.1 PR B): per-session deferral state map. Banner reads
   * here to show "等 reset T-XhYm" cooldown.
   *
   * 中: 每 session 的 deferral 状态，banner 用。
   */
  deferralBySession: Map<string, SdkDeferralState>;

  /** Apply an `sdk-deferral` SSE payload. Null reason+epoch clears.
   *  中: 收到 `sdk-deferral` 时调；null 表示解除。 */
  applyDeferralEvent: (sessionId: string, state: SdkDeferralState) => void;
}

export const createSdkChannelSlice: StateCreator<
  LoomscopeStore,
  [],
  [],
  SdkChannelSlice
> = (set, get) => ({
  inflightBySession: new Map(),
  rateLimitBySession: new Map(),
  deferralBySession: new Map(),

  applySdkQueueState: (sessionId, payload) => {
    const cur = get().inflightBySession.get(sessionId) ?? EMPTY_INFLIGHT;
    // P1: resolve the running prompt's text across pending→running.
    // Priority: still-listed in this payload → the item that just
    // left cur.pendingPrompts to run → keep prior text if the SAME
    // item is still currentRun (no pendings to re-derive from) →
    // null. Cleared whenever nothing is executing.
    // 中: 解析正在执行 prompt 的文本，跨 pending→running 保留。
    let runningPromptText: string | null = null;
    if (payload.currentRun) {
      const id = payload.currentRun.promptItemId;
      runningPromptText =
        payload.pendingPrompts.find((p) => p.id === id)?.text ??
        cur.pendingPrompts.find((p) => p.id === id)?.text ??
        (cur.currentRun?.promptItemId === id ? cur.runningPromptText : null) ??
        // P1 robustness: SSE-timing-independent fallback. If the early
        // `pending=[X]` event was missed (broadcast-only, no replay —
        // common on a large/slow session), the chain above yields
        // null even though state reached running (the bug: timer
        // showed, bubble didn't). The client recorded this text at
        // send time keyed by itemId — use it.
        cur.sentTextByItemId.get(id) ??
        null;
    }
    const next: SdkInflight = {
      state: payload.state,
      currentRun: payload.currentRun,
      pendingPrompts: payload.pendingPrompts,
      lastError: cur.lastError, // queue-state events don't override errors
      respawnNotice: cur.respawnNotice, // ditto for the race banner
      runningPromptText,
      sentTextByItemId: cur.sentTextByItemId, // carried; FIFO-capped on add
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
        // PR fix-a: preserve pendingPrompts too. Between sdk-session-
        // closed and the next sdk-queue-state(running, pendings=[])
        // arrival, the registry's `respawnPreservingQueue` keeps the
        // server-side pending list intact. If the frontend wipes them
        // here, the user's PendingBubble flickers off for the spawn
        // window (~hundreds of ms), making "send" feel like nothing
        // happened. Keeping them visible until the next queue-state
        // overwrites with the post-dispatch state matches the
        // server's actual behaviour.
        pendingPrompts: cur.pendingPrompts,
        lastError: null,
        respawnNotice: cur.respawnNotice,
        // P1: a mid-respawn close is transient — the same turn keeps
        // running after the fresh spawn; retain its text so the
        // optimistic running bubble doesn't flicker off.
        runningPromptText: cur.runningPromptText,
        // P1 robustness: a respawn between send and the running event
        // is exactly when the SSE-derived text is lost — the
        // client-known map MUST survive it.
        sentTextByItemId: cur.sentTextByItemId,
      });
      set({ inflightBySession: m });
      return;
    }
    // Genuine close (idle eviction, shutdown, abnormal subprocess
    // exit) — drop the entry entirely so no stale state lingers.
    // PR A/B: drop rate-limit + deferral snapshots. Fresh spawn re-
    // emits rate-limit on its own threshold crossing; server-side
    // deferral persistence handles cross-restart hydration.
    // 中: 关 session 时 rate-limit + deferral 缓存都清。
    const m = new Map(get().inflightBySession);
    m.delete(sessionId);
    const r = new Map(get().rateLimitBySession);
    r.delete(sessionId);
    const d = new Map(get().deferralBySession);
    d.delete(sessionId);
    set({ inflightBySession: m, rateLimitBySession: r, deferralBySession: d });
  },

  noteSdkSentPrompt: (sessionId, itemId, text) => {
    const cur = get().inflightBySession.get(sessionId) ?? EMPTY_INFLIGHT;
    // Clone + re-insert (Map preserves insertion order) so the FIFO
    // cap drops the OLDEST entry. Deleting an existing key first keeps
    // a re-sent itemId fresh in the order.
    const sentTextByItemId = new Map(cur.sentTextByItemId);
    sentTextByItemId.delete(itemId);
    sentTextByItemId.set(itemId, text);
    while (sentTextByItemId.size > SENT_TEXT_CAP) {
      const oldest = sentTextByItemId.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      sentTextByItemId.delete(oldest);
    }
    const m = new Map(get().inflightBySession);
    m.set(sessionId, { ...cur, sentTextByItemId });
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

  applyRateLimitEvent: (sessionId, info) => {
    const m = new Map(get().rateLimitBySession);
    m.set(sessionId, info);
    set({ rateLimitBySession: m });
  },

  applyDeferralEvent: (sessionId, state) => {
    const m = new Map(get().deferralBySession);
    // Treat "fully null" as clear → drop the entry to keep the map small.
    // 中: 双 null 视为清除，删 map 项保持 lean。
    if (state.deferralUntilEpoch == null && state.reason == null) {
      m.delete(sessionId);
    } else {
      m.set(sessionId, state);
    }
    set({ deferralBySession: m });
  },
});

/** Stable empty for selectors that need to return a non-null shape. */
export function getInflight(
  store: LoomscopeStore,
  sessionId: string,
): SdkInflight {
  return store.inflightBySession.get(sessionId) ?? EMPTY_INFLIGHT;
}
