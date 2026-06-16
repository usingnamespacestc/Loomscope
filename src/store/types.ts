// Store slice contracts. Splitting into 4 slices mirrors `design-architecture.md`
// "前端状态管理" so future v∞ work can drop SSE / hook handlers into
// `LiveEventSlice` without rippling across the rest of the store.

import type { ChatFlow, ChatNode, WorkflowSummary } from "@/data/types";
import type { RawRecord } from "@/parse/raw-record";
import type { AgentMetadata } from "@/parse/sidecar";

/**
 * EN (v2.1 PR D2): client-side mirror of the server delta event types
 * (defined in src/server/services/chatFlowDeltaEngine.ts). Same shapes,
 * separate definition to avoid a server-module import from client code.
 *
 * 中: 服务端 ChatFlowDeltaEvent 的客户端镜像；shape 一样，独立定义
 * 避免客户端代码从 server 模块拖代码。
 */
export type ChatFlowDeltaEvent =
  | {
      type: "chatnode-added";
      seq: number;
      chatNode: ChatNode;
    }
  | {
      type: "chatnode-summary-updated";
      seq: number;
      chatNodeId: string;
      summary: WorkflowSummary;
    }
  | {
      type: "chatnode-removed";
      seq: number;
      chatNodeId: string;
    }
  | {
      type: "checkpoint";
      seq: number;
      chatNodeCount: number;
    };

// ─── UI slice ────────────────────────────────────────────────────────────────

// v0.8 M3: DrillPanel tabs. Per design micro-decision 1B, the tab
// state is global (UISlice) — partialize automatically writes it to
// localStorage so the user's "I prefer Detail tab" preference
// survives reload. per-session preferences would have needed a
// separate persistence path; the global pref matches user intent
// (tab choice is about the panel's role, not about the session).
export type DrillPanelTab =
  | "detail"
  | "conversation"
  | "effective_context"
  | "git";

export interface UISlice {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  // v0.4 drill panel width (right-side resizable). 0 = collapsed.
  drillPanelWidth: number;
  drillPanelCollapsed: boolean;
  // v0.8 M3: which tab is active in DrillPanel. "detail" preserves
  // v0.4-v0.7 single-view behaviour 1:1.
  drillPanelTab: DrillPanelTab;
  // v0.8.1 #7: full-canvas drill panel. When true, panel covers the
  // canvas area; sidebar still visible. prevDrillPanelWidth caches
  // the pre-fullscreen width so toggling back restores it.
  drillPanelFullscreen: boolean;
  prevDrillPanelWidth: number | null;
  // v0.8.1 polish: chatNodeId currently being hovered in the
  // Conversation tab (after the 250ms dwell threshold). Drives a
  // dashed-outline highlight on the corresponding ChatNodeCard so
  // the user can see which canvas card the hovered message maps to.
  // Cleared on bubble mouseleave. Transient — not persisted.
  conversationHoveredChatNodeId: string | null;
  pinnedWorkspaces: string[];
  hiddenWorkspaces: string[];
  focusedWorkspace: string | null;
  // v1.1: viewer-only vs interactive mode. When `false`, every write
  // affordance is hidden (composer / trash menu / permission banner
  // buttons). Sourced from server-side preferences; loaded once on
  // App mount + sync'd back via setInteractiveMode → /api/preferences.
  // Default `true` matches the "loaded fresh, no preferences yet"
  // case so first-time users still see all the UI.
  interactiveMode: boolean;

  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  setDrillPanelWidth: (w: number) => void;
  toggleDrillPanel: () => void;
  toggleDrillPanelFullscreen: () => void;
  setConversationHoveredChatNodeId: (id: string | null) => void;
  setDrillPanelTab: (tab: DrillPanelTab) => void;
  pinWorkspace: (cwd: string) => void;
  unpinWorkspace: (cwd: string) => void;
  hideWorkspace: (cwd: string) => void;
  unhideWorkspace: (cwd: string) => void;
  setFocusedWorkspace: (cwd: string | null) => void;
  /** Set the in-memory mode without server sync. Used by App startup
   *  preferences-load to seed the store. */
  setInteractiveMode: (next: boolean) => void;
  /** Set + persist via PATCH /api/preferences. Resolves to true on
   *  success, false on network error (caller can show inline error). */
  saveInteractiveMode: (next: boolean) => Promise<boolean>;
}

// ─── Workspace slice ────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  cwd: string;
  sessionCount: number;
  lastModified: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  modified: string;
  messageCount: number;
  gitBranch: string | null;
  fileSize: number;
  isSidechain: boolean;
}

export interface WorkspaceSlice {
  workspaces: WorkspaceSummary[];
  workspacesLoading: boolean;
  workspacesError: string | null;
  // Sessions per workspace cwd. Lazy-loaded on first expand.
  sessionsByCwd: Map<string, SessionSummary[]>;
  // expanded workspace cwds (sidebar tree open state)
  expandedCwds: Set<string>;
  refreshWorkspaces: () => Promise<void>;
  loadSessions: (cwd: string) => Promise<void>;
  toggleExpanded: (cwd: string) => void;
}

// ─── Session slice ──────────────────────────────────────────────────────────

// Drill-stack frame. v0.3 ships only ``chatnode`` frames (one ChatNode →
// its inner WorkFlow). v0.5 adds ``subworkflow`` frames for sub-agent
// real-nesting (lazy-loaded sidecar WorkFlow under a delegate WorkNode).
// v0.7 had a `compact-original` frame; v0.x rework replaces it with
// inline fold (see SessionState.foldedCompactIds) — drill mode for
// compact's pre-compact range is gone, so the frame is gone too.
export type DrillFrame =
  | { kind: "chatnode"; chatNodeId: string }
  | { kind: "subworkflow"; parentWorkNodeId: string };

// Cached sub-agent ChatFlow plus its AgentMetadata. Stored per
// ``(sessionId, agentId)`` and dropped on session unload — sub-agents
// from a different session would have stale parentChatNodeId / uuid
// references anyway, so cross-session sharing isn't valuable.
// v0.10 lazy ChatFlow B2: per-ChatNode workflow lazy cache. Status
// machine mirrors SubAgentCacheEntry — `pending` while a fetch is in
// flight, `ready` once nodes/edges are populated, `error` on
// network/parse failure. Components reading workflow check status
// before iterating; pending → render skeleton, error → show retry.
export interface WorkflowCacheEntry {
  status: "pending" | "ready" | "error";
  workflow: import("@/data/types").WorkFlow | null;
  error: string | null;
  // EN: stale-while-revalidate marker. Set by refreshSession when a
  // ChatNode's summary shifted but the old workflow is still useful
  // as a placeholder during refetch (avoids 50-100ms of empty
  // WorkFlowCanvas while the new lazy fetch is in flight).
  // useChatNodeWorkflow displays the old workflow + status='ready'
  // while staleSince is truthy; loadChatNodeWorkflows refires the
  // fetch and clears staleSince on success.
  // 中: stale-while-revalidate 标记。refreshSession 发现 summary 变了
  // 但老 workflow 仍可作占位时设置；hook 在 staleSince 存在期间
  // 继续显示旧 workflow，避免 WorkFlowCanvas 出现 50-100ms 的空白。
  // 重新 fetch 完成后清除。
  staleSince?: number;
}

export interface SubAgentCacheEntry {
  status: "loading" | "ready" | "error";
  chatFlow: ChatFlow | null;
  meta: AgentMetadata | null;
  error: string | null;
  // Last access timestamp (ms). Reserved for future LRU eviction —
  // current implementation keeps everything until session switch.
  lastAccess: number;
}

export interface ActiveToolCall {
  /** PreToolUse hook's `tool_use_id` — the join key with PostToolUse. */
  toolUseId: string;
  /** `tool_name` from the hook (e.g. "Bash", "Read", "Write", "TodoWrite"). */
  toolName: string;
  /** `tool_input` from the hook. Free-form JSON; the chip surfaces the
   *  first useful one-line summary (e.g. for Bash, `input.command`). */
  toolInput: unknown;
  /** epoch-ms when the PreToolUse hook arrived. Drives the "Ns" counter. */
  since: number;
}

export interface SessionState {
  chatFlow: ChatFlow | null;
  // ChatFlow-layer fold state. v0.5 used this for the drill-down
  // ChatFlow→WorkFlow toggle (membership keyed on ChatNode id).
  foldedNodeIds: Set<string>;
  // Set of compact ChatNode ids whose pre-compact range is currently
  // folded out of the canvas (replaces v0.7's compact-original drill
  // mode). Default-populated on session load with ALL compact ChatNode
  // ids in the chatFlow — i.e. every compact's range starts folded —
  // unless a localStorage entry under ``loomscope:fold:${sessionId}``
  // overrides. Mutating actions: ``foldCompact`` / ``unfoldCompact`` /
  // ``toggleCompactFold``. Persistence is via localStorage on every
  // mutation; the in-memory ``Set`` is the source of truth at runtime.
  foldedCompactIds: Set<string>;
  viewport: { x: number; y: number; zoom: number };
  selectedNodeId: string | null;
  // WorkFlow-layer selection — kept independent from ChatFlow's
  // ``selectedNodeId`` so drilling out and back in doesn't lose the
  // node the user clicked inside the WorkFlow.
  workflowSelectedNodeId: string | null;
  // Empty stack = ChatFlow view; non-empty = WorkFlow view, with the
  // top frame identifying which ChatNode (or sub-agent ChatFlow) is
  // opened. v0.6 redo extends drillStack semantics for sub-ChatFlow
  // drill (subworkflow frame → resolves a full sub-agent ChatFlow,
  // not just chatNodes[0]).
  drillStack: DrillFrame[];
  // v0.8 M4: per-fork-point memory for the ConversationView
  // BranchSelector. Keyed forkChildId → leafId — when the user
  // navigates away from a fork point and later returns, we remember
  // which leaf they last viewed on that branch.
  // Per design choice 4A this is store-only (reload resets); v0.10
  // polish可考虑 localStorage 持久化。
  branchMemory: Record<string, string>;
  // ``agentId → entry`` cache for sub-agent ChatFlows loaded via the
  // ``/api/sessions/:id/subagents/:agentId`` endpoint. v0.5 keeps
  // everything in memory; eviction policy (LRU / max-size) is v0.10
  // backlog.
  subAgentCache: Map<string, SubAgentCacheEntry>;
  // v0.10 lazy ChatFlow B2: per-ChatNode workflow cache, keyed on
  // ChatNode.id. Populated by `loadChatNodeWorkflows` (batch fetch
  // against POST /api/sessions/:id/chatnodes/workflows). Empty on
  // session load — components trigger lazy loads as they need
  // workflows.
  workflowCache: Map<string, WorkflowCacheEntry>;
  // v0.10 收尾: per-ChatNode WorkFlow viewport stash. Populated when
  // the user pans/zooms inside a WorkFlowCanvas; restored on next
  // drill-in to that ChatNode. Store-only (lost on page reload —
  // drillStack also resets, so the user is back at ChatFlow anyway);
  // localStorage would be too granular for ephemeral exploration
  // state. Cleared via `setWorkflowViewport(sid, cnId, null)` if we
  // ever need to wipe.
  workflowViewports: Map<string, { x: number; y: number; zoom: number }>;
  // v∞.0 PR 2: surfaces CC's PermissionRequest hook (the one signal
  // not in jsonl). Set by `applyCcHookEvent` on PermissionRequest;
  // cleared on PermissionDenied or any PostToolUse / file-watch
  // refresh that proves the tool already ran. UI shows a non-modal
  // banner asking the user to alt-tab to their terminal and confirm.
  // null when no permission is currently pending.
  pendingPermission: {
    toolName?: string;
    toolInput?: unknown;
    cwd?: string;
    permissionMode?: string;
    receivedAt: number;
  } | null;
  // v∞.3 PR1: pending SDK canUseTool prompts awaiting user decision.
  // Created on `permission-prompt` SSE arrival; cleared when the
  // user clicks Allow / Always / Deny (decision POSTs back), when
  // the SDK aborts (`permission-prompt-resolved` SSE event with
  // reason='aborted'), or on sdk-session-closed.
  //
  // Distinct from `pendingPermission` above — that one mirrors CC's
  // PermissionRequest HOOK (terminal CC's y/n prompt, read-only
  // banner). canUseTool prompts are SDK-interactive (Loomscope
  // banner has actual buttons that resolve the SDK's awaiting
  // Promise via /api/sessions/:id/permission-prompts/:promptId/decision).
  pendingCanUseToolPrompts?: Array<{
    promptId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    title?: string;
    displayName?: string;
    decisionReason?: string;
    blockedPath?: string;
    receivedAt: number;
    /** EN (v2.3 PR F2): origin of the prompt — routes the user's
     *  decision to the right endpoint and drives the banner's source
     *  chip ("terminal CC" vs "Loomscope-spawned"). Defaults to
     *  "sdk" for back-compat: SSE payloads from canUseTool don't set
     *  `source`, while HTTP-hook prompts (PR F1) carry
     *  `source: "http"`.
     *  中: prompt 来源；决定 banner 上 chip 文案 + 决策走的 endpoint。 */
    source?: "sdk" | "http";
  }>;
  // v0.11: hook-driven turn window. UserPromptSubmit sets this to
  // { startedAt: now }; Stop clears it. When non-null, the session is
  // canonically "running" — drives card pulse + edge dashed flow
  // animations through useIsChatNodeRunning. Falls back to fs.watch +
  // hasInFlightWork when these hooks aren't wired (Settings → Hooks
  // → uncheck UserPromptSubmit/Stop). Stale-cleared by liveness hook
  // if older than ~10 minutes (covers a missed Stop fire).
  // 中: hook 驱动的 turn 窗口。UserPromptSubmit 时 set，Stop 时 clear。
  // 非 null = "正在跑" 的权威信号；用户没勾这俩 hook 时回落到旧逻辑。
  // 10 分钟内没收到 Stop 则视为 stale 自动清除（防止 hook 丢一次卡死）。
  currentTurn: { startedAt: number } | null;
  // EN (2026-06-16, Plan B): per-running-tool-call placeholders sourced
  // from PreToolUse hooks — they arrive in real time (HTTP, before CC
  // fsyncs the jsonl). The canvas's currently-running ChatNode card
  // surfaces these as transient "⚙️ Bash: ls /etc/hostname" chips so
  // tool activity is visible during the ~3s jsonl-flush window. Keyed
  // on the hook's `tool_use_id` so PostToolUse can remove the matching
  // entry. Stop / UserPromptSubmit clear the whole map (covers a missed
  // PostToolUse). Pure presentation: never touches chatFlow / WorkFlow
  // — when the real tool_call WorkNode lands via the jsonl-driven
  // delta, the chip is just stale UI and gets removed on the next
  // PostToolUse or Stop. Empty map = no placeholders shown.
  // 中: PreToolUse hook 实时占位。PostToolUse 删；Stop/UserPromptSubmit
  // 整图清。纯 UI，不进 chatFlow。
  activeToolCalls: Map<string, ActiveToolCall>;
  // EN: epoch-ms of the most recent UserPromptSubmit OR Stop hook
  // delivery. Lets `useSessionTurnRunning` detect whether the user
  // has these hooks wired at all — if 0 OR older than 30 min, the
  // hook is presumed absent/disabled and the legacy fallback (live +
  // hasInFlight) drives the animation. When fresh, currentTurn is
  // authoritative — Stop must turn off the animation precisely, not
  // wait for the 5s live-decay to expire.
  // 中: 最近一次 UserPromptSubmit/Stop 到达的时间。判定用户有没有
  // 接这俩 hook：30 分钟内有过 = 信任 currentTurn；没过 = 回落老逻辑。
  lastTurnHookAt: number;
  // v1.5: epoch-ms of the most recent UserPromptSubmit ONLY (NOT
  // touched by Stop). CC fires Stop after every assistant message,
  // including mid-turn ones in tool-use loops, so currentTurn flickers
  // off/on across a multi-step turn. This sticky anchor survives
  // those mid-turn Stops so the composer status bar's elapsed clock
  // counts from "user hit Enter" not "last assistant message". Reset
  // on the next UserPromptSubmit. 0 = never set.
  lastTurnUserSubmittedAt: number;
  // EN: most recent Notification hook fire — `notificationType`
  // includes `idle_prompt` (CC waiting for user input >60s),
  // `auth_success`, and a few MCP/swarm-specific kinds. Wired
  // through to state for future UI consumption (idle indicator on
  // Header, focus-on-composer in v∞.1, etc.); current builds don't
  // surface this yet.
  // 中: 最近一次 Notification hook。先把数据通路打通，UI 消费等
  // v∞.1 输入框上线再做。
  lastNotification: {
    message: string;
    notificationType: string;
    receivedAt: number;
  } | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: number;
  // EN: epoch-ms timestamp of the most recent SSE `invalidate` event
  // received for this session. Drives the "running" / live animation
  // heuristic (selectionHooks.useSessionLiveness): if `now -
  // lastInvalidateAt < 5000`, the session is treated as actively
  // ticking and the latest ChatNode/bubble pulses; otherwise it goes
  // static. This is also the orphan-handling story — a backend
  // restart cuts off SSE → no more invalidates → all liveness
  // indicators decay to static within 5s, no stuck "running"
  // forever. 0 = never received (fresh load, no liveness shown).
  // 中: 该 session 收到最后一次 SSE 'invalidate' 的时间戳（epoch ms）。
  // 用于"运行中"动画判定：5s 内有过 invalidate 就认为活跃，超时
  // 后所有 liveness 指示自动退化为静态。这就是 orphan 处理——后端
  // 重启 / SSE 断开 → 5s 内自然无指示，不会卡在"running"永久状态。
  // 0 = 从未收到（刚 load，不显示 liveness）。
  lastInvalidateAt: number;
  /** EN (v2.1 PR D2): last applied delta seq for this session. Set on
   *  every successful `applyChatFlowDelta` call. Used by the gap
   *  detector — if an incoming delta's seq != appliedVersion + 1, we
   *  dropped events and need a full refresh.
   *  null = never received a delta (fresh load) → first delta seeds
   *  the baseline without raising a gap.
   *
   *  中: 上一条已应用 delta 的 seq。null 表示从未收过 delta（fresh
   *  load）；下一条直接当 baseline。gap 检测发现错位时强制 full refresh。
   */
  appliedVersion: number | null;
  /** PR-1 (2026-05-18, convergence rework §9): server-authoritative
   *  monotonic `version` last reported (GET `version` / every SSE
   *  signal's top-level `version` / a delta's seq). RECORDED ONLY in
   *  PR-1 — NOTHING reads it for control flow; the gap detector still
   *  uses `appliedVersion`'s unchanged null-seeding contract. This is
   *  the watermark PR-2's convergent reconcile will consume.
   *  null = none reported yet. */
  serverVersion: number | null;
  /** EN (v2.2 PR E2): UUIDs of jsonl records already absorbed via the
   *  raw-record fast path. Idempotency guard so chokidar double-fires
   *  or out-of-order replay don't double-apply assistant text to a
   *  ChatNode's `assistantText`. The set grows linearly with the
   *  session's record count (~10k entries on a long session, ~200KB
   *  in memory — negligible). Cleared by `loadSession` / session
   *  remove; never auto-pruned mid-session because ground-truth
   *  delta replaces ChatNode wholesale anyway, so stale Set entries
   *  cost nothing.
   *
   *  中: 已通过 raw-record 通道吸收的 record uuid 集合。防止
   *  chokidar 重复或乱序 replay 把 assistant text append 两遍。
   *  session 加载 / 删除时清空；不做中段 prune 因为 ground-truth
   *  delta 会原地替换 ChatNode，旧 uuid 留着无害。
   */
  rawAppliedRecordUuids: Set<string>;
}

export interface SessionSlice {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  // v1.6: pending "draft" new-session slot. Set when the user clicks
  // "+ 新建" in sidebar with an empty prompt — they've chosen a cwd
  // but haven't sent a first message yet, so SDK hasn't spawned + no
  // CC sid exists. Composer detects activeSessionId === draftSession.id
  // (which is `draft-<random>`) and routes the first send through
  // POST /api/sessions/new instead of /turns; the returned real sid
  // replaces the draft via commitDraftSession.
  //
  // Why a synthetic-id row instead of a separate "draft" slot beside
  // activeSessionId: keeps activeSessionId's nullability semantics
  // simple — it's still always either a real CC sid OR null. The
  // draft id can flow through any code path that takes a sessionId
  // with no special-casing, except the few that explicitly check the
  // `draft-` prefix (Composer send-routing, Sidebar render,
  // ChatFlowCanvas placeholder).
  draftSession: { id: string; cwd: string } | null;
  startDraftSession: (cwd: string) => void;
  /** Replace the draft with the real CC-spawned session. Called by
   *  Composer after POST /api/sessions/new succeeds. Cleans up the
   *  draft entry and points activeSessionId at the real sid so the
   *  rest of the app sees a normal active session. */
  commitDraftSession: (realSid: string) => void;
  /** Drop the draft without spawning. Called from sidebar's draft
   *  context menu / when user explicitly cancels. */
  clearDraftSession: () => void;
  loadSession: (id: string) => Promise<void>;
  // v0.9 file-tail: re-fetch the lite ChatFlow for `id` triggered by
  // an SSE `invalidate` event (underlying jsonl appended). Reconciles
  // into the existing SessionState — preserves selection / viewport /
  // drillStack / foldedCompactIds — and clears `workflowCache` so the
  // lazy hooks pull fresh per-ChatNode workflow data.
  refreshSession: (id: string) => Promise<void>;
  /** Internal: actual fetch + diff-merge body. Used by `refreshSession`
   *  through a dedup wrapper. Not a public API — listed on the slice
   *  type because zustand needs every closure-captured action to be
   *  visible on the store. */
  _refreshSessionInner: (id: string) => Promise<void>;
  /** EN (v2.1 PR D2): apply a freshly-arrived server delta to this
   *  session's ChatFlow. Implements per-type reducers (chatnode-added /
   *  chatnode-summary-updated / chatnode-removed / checkpoint) and
   *  gap detection: if `delta.seq != appliedVersion + 1`, schedules a
   *  full `refreshSession` and bails (don't apply out-of-order).
   *
   *  中: 应用一条服务端推过来的 delta。包含 gap 检测——seq 错位会
   *  退回 full refresh，避免乱序状态。
   */
  applyChatFlowDelta: (sessionId: string, delta: ChatFlowDeltaEvent) => void;
  /** EN (v2.2 PR E1): apply a freshly-appended raw jsonl record to the
   *  active session's ChatFlow for an instant optimistic placeholder
   *  ChatNode — bypasses the ~1.5-2s buildChatFlow latency on the
   *  server. Scoped to MVP-relevant records:
   *    - `type=user` (non-meta, non-toolResult, non-compactSummary,
   *      non-sidechain, with promptId) → spawn a placeholder ChatNode
   *      keyed on `record.promptId`. Skipped if a ChatNode with that
   *      id already exists (the ground-truth `chatnode-added` delta
   *      arrived first OR a previous raw-record already placed one).
   *  All other record types are no-ops in MVP — the ground-truth delta
   *  flips them in 1-2s. The placeholder ChatNode's id matches the
   *  eventual real id (=promptId), so when the delta arrives,
   *  applyChatFlowDelta's existing dedup (`existsIdx >= 0` →
   *  replace-in-place) seamlessly swaps it out.
   *
   *  中: PR E1 把刚 append 的 raw record 当 optimistic placeholder。
   *  目前只处理 user record（生成占位 ChatNode），后续 ground-truth
   *  delta 通过同 id 在 applyChatFlowDelta 里替换掉。
   */
  applyRawRecord: (sessionId: string, record: RawRecord) => void;
  // EN: bump lastInvalidateAt for `sessionId` to now. Called from the
  // SSE `invalidate` handler in App.tsx so liveness UI flips into
  // active state.
  // 中: 把指定 session 的 lastInvalidateAt 设为当前时间戳，由 App.tsx
  // 的 SSE invalidate 处理器调用，触发 liveness 进入 active。
  markSessionActivity: (sessionId: string) => void;
  // v∞.3 PR1: SDK canUseTool browser banner state. Driven by the
  // `permission-prompt` / `permission-prompt-resolved` SSE events
  // in App.tsx + the InteractivePermissionBanner click handlers.
  addCanUseToolPrompt: (
    sessionId: string,
    prompt: {
      promptId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      title?: string;
      displayName?: string;
      decisionReason?: string;
      blockedPath?: string;
      receivedAt: number;
      source?: "sdk" | "http";
    },
  ) => void;
  removeCanUseToolPrompt: (sessionId: string, promptId: string) => void;
  /** Wipe all pending prompts for a session — used on
   *  sdk-session-closed to drop now-stale UI state. */
  clearCanUseToolPrompts: (sessionId: string) => void;
  // v∞.0 PR 2: dispatch a CC settings.json hook event into the
  // session's state. Driven by the `cc-hook` SSE event in App.tsx.
  // Common path = bump activity timestamp; the load-bearing branch
  // is PermissionRequest / PermissionDenied which manage the
  // `pendingPermission` slot (the only signal not in jsonl).
  applyCcHookEvent: (
    sessionId: string,
    event: string,
    payload: {
      session_id: string;
      transcript_path?: string;
      cwd?: string;
      permission_mode?: string;
      agent_id?: string;
      agent_type?: string;
      extras: Record<string, unknown>;
    },
  ) => void;
  // v0.9.1: SSE `invalidate` with kind='subagent' fires when a sidecar
  // sub-agent jsonl ticked over (CC delegated tool, sub-agent appended
  // a turn). Drops the cached entry then re-fetches if it was ready —
  // viewers currently looking at this sub-agent see a brief loading
  // flash then fresh content. If the entry wasn't loaded yet (cold),
  // does nothing — next loadSubAgent picks up fresh.
  refreshSubAgent: (
    sessionId: string,
    agentId: string,
    subdir?: string,
  ) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  // v0.10 收尾: drop in-memory state + GC localStorage entries scoped
  // to this session (currently `loomscope:unfold:<sid>` and the legacy
  // `loomscope:fold:<sid>`). Triggered by the workspace SSE
  // `workspace-changed` event with `reason: "remove"` — the
  // underlying jsonl was deleted from disk so retaining its UI
  // state can never serve a future visit.
  removeSession: (id: string) => void;
  /** v1.6 #182: optimistic anchor for the composer status bar so the
   *  spinner + elapsed clock appear immediately after the new-session
   *  modal succeeds, rather than waiting for the UserPromptSubmit SSE
   *  hook to arrive (which can race the SSE subscription opening). */
  markTurnSubmittedOptimistic: (sessionId: string, ts?: number) => void;
  setSelected: (sessionId: string, nodeId: string | null) => void;
  setViewport: (sessionId: string, vp: { x: number; y: number; zoom: number }) => void;
  // ── Drill-down navigation (v0.3 inner WorkFlow) ──
  enterWorkflow: (sessionId: string, chatNodeId: string) => void;
  exitWorkflow: (sessionId: string) => void;
  truncateDrillStack: (sessionId: string, depth: number) => void;
  setWorkflowSelected: (sessionId: string, nodeId: string | null) => void;
  // v0.10 收尾: stash WorkFlow viewport keyed by ChatNode id. Pass
  // null/undefined to clear. WorkFlowCanvas calls this on RF
  // onMoveEnd; on next mount it reads back to restore zoom/pan
  // instead of running fitView.
  setWorkflowViewport: (
    sessionId: string,
    chatNodeId: string,
    viewport: { x: number; y: number; zoom: number } | null,
  ) => void;
  // ── v0.10 lazy ChatFlow B2: per-ChatNode workflow lazy load ──
  // Batch-fetch workflows for the given ChatNode ids. Dedupes against
  // currently-pending fetches and skips ids whose entry is already
  // `ready`. Returns when the batch resolves; per-id status updates
  // land in `workflowCache` so subscribers re-render incrementally.
  // Server endpoint: POST /api/sessions/:id/chatnodes/workflows.
  loadChatNodeWorkflows: (sessionId: string, chatNodeIds: string[]) => Promise<void>;

  // ── v0.5 sub-agent nesting ──
  // Lazy-load a sub-agent's ChatFlow + meta and cache it. In-flight
  // calls dedupe (multiple double-clicks on the same delegate fold
  // into a single fetch). Returns the cache entry's ``status`` after
  // the call completes — useful for tests / debugging.
  loadSubAgent: (
    sessionId: string,
    agentId: string,
    subdir?: string,
  ) => Promise<SubAgentCacheEntry>;
  // Push a ``subworkflow`` drill frame (= drill into the sub-agent's
  // sub-ChatFlow). The current top frame must already be a chatnode
  // or subworkflow; ``parentWorkNodeId`` must resolve to a ``delegate``
  // WorkNode in that frame's WorkFlow. Triggers loadSubAgent if the
  // cache is cold. Idempotent on the same parentWorkNodeId.
  enterSubWorkflow: (sessionId: string, parentWorkNodeId: string) => void;
  // ── compact pre-compact-range fold (replaces v0.7 drill mode) ──
  // Mutate the session's ``foldedCompactIds`` and persist to localStorage.
  // ``compactChatNodeId`` must reference an existing compact ChatNode in
  // ``chatFlow``; otherwise the action is a no-op (defensive — we don't
  // want a stale id leaking into the persisted set). Calls are
  // idempotent (folding an already-folded id, or unfolding an
  // already-unfolded id, are no-ops that still re-persist for
  // determinism).
  // EN: `opts.persist=false` skips the localStorage write. Used by
  // the hover-pan release path so re-folding for preview restoration
  // doesn't write back the user's transient hover state to storage.
  // 中: persist:false 不写 storage；hover-pan 释放时恢复折叠用，
  // 避免临时预览状态污染持久化偏好。
  foldCompact: (
    sessionId: string,
    compactChatNodeId: string,
    opts?: { persist?: boolean },
  ) => void;
  // v0.9.1: `opts.persist=false` skips the localStorage write — used by
  // ConversationView's hover-pan auto-unfold so a transient navigation
  // gesture doesn't pollute the user's persisted "explicitly opened"
  // set. User-explicit clicks (the chatFold node card, the compact
  // node's fold-toggle button) leave persist at default true.
  unfoldCompact: (
    sessionId: string,
    compactChatNodeId: string,
    opts?: { persist?: boolean },
  ) => void;
  toggleCompactFold: (sessionId: string, compactChatNodeId: string) => void;
  // v0.8 M4: ConversationView BranchSelector picks a branch — record
  // the chosen leaf for the fork point + flip selectedNodeId so the
  // canvas + Conversation tab follow the new path. branchMemory
  // remembers the choice so re-entering the fork point auto-restores.
  pickBranch: (
    sessionId: string,
    forkChildId: string,
    leafChatNodeId: string,
  ) => void;
  // Legacy v0.5 fold toggle — keyed on a ChatNode id, manipulates
  // ``foldedNodeIds`` membership. Used by the drill-down chat-flow
  // fold UX (currently dormant in production but kept for future
  // ChatFlow-layer fold features). v0.6 redo deliberately does NOT
  // introduce a unified expand/collapse model — that was the v0.6
  // first-attempt mistake. See `handoff-v0.6-redo-node-base-interop.md`
  // hard constraint #4.
  toggleFold: (sessionId: string, nodeId: string) => void;
  // v0.11 Git tab ↔ WorkFlow cross-highlight (Phase 4 wiring): a
  // single source-of-truth pair tells GitDiffPanel which file path
  // is currently being hovered/focused from the WorkFlow side.
  // WorkFlow tool_use card writes via `set...FromWorkflow`, panel
  // reads & reflects with a colored ring + auto-expand-on-focus.
  // Reverse direction: panel hover writes via `setGitFileHoverFromPanel`
  // and WorkFlow card reads (its own card lights up).
  // null = nothing being hovered/focused.
  gitFileHoverFromWorkflow: string | null;
  gitFileFocusFromWorkflow: string | null;
  gitFileHoverFromPanel: string | null;
  setGitFileHoverFromWorkflow: (file: string | null) => void;
  setGitFileFocusFromWorkflow: (file: string | null) => void;
  setGitFileHoverFromPanel: (file: string | null) => void;
  // v0.11 Phase 2 — session search jump target. ConversationView
  // subscribes; on a value change it scrolls the matching record into
  // view and pulses a highlight for ~1.5 s. `receivedAt` is included
  // so the same record clicked twice still pulses the second time
  // (object identity changes).
  searchHighlight: {
    sessionId: string;
    recordUuid: string;
    chatNodeId: string;
    query: string;
    caseSensitive: boolean;
    receivedAt: number;
  } | null;
  setSearchHighlight: (h: SessionSlice["searchHighlight"]) => void;
}

// ─── Live event slice ────────────────────────────────────────────────────────

// v0.9.1: per-channel SSE connection state. App.tsx owns the
// EventSource lifecycle and pokes this slot so the Header indicator
// reflects reality. `idle` = no EventSource open (e.g., no active
// session for the session channel); `connecting` = constructed but
// no `hello` yet; `open` = received hello / readyState 1; `error` =
// readyState != 0/1 (browser will auto-retry).
export type LiveChannelState = "idle" | "connecting" | "open" | "error";
export type LiveChannelName = "session" | "workspaces";

export interface LiveEventSlice {
  liveStatus: Record<LiveChannelName, LiveChannelState>;
  setLiveStatus: (channel: LiveChannelName, state: LiveChannelState) => void;
}

// CC TaskList — read-only mirror of `~/.claude/tasks/<sid>/*.json`,
// sourced from the `GET /api/sessions/:id/tasks` endpoint. Updates are
// driven by the existing per-session SSE channel via `kind: "tasks"`
// invalidate events.
export type CcTaskStatus = "pending" | "in_progress" | "completed";
export interface CcTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: CcTaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}
export interface TaskListSlice {
  /** sessionId → tasks (sorted by numeric id ascending). */
  tasksBySession: Map<string, CcTask[]>;
  /** Inflight controller per session — last-write-wins on race. */
  taskFetchControllers: Map<string, AbortController>;
  /** Bottom-right panel collapsed/expanded toggle (UI pref). */
  taskListPanelCollapsed: boolean;
  setTaskListPanelCollapsed: (collapsed: boolean) => void;
  /** Idempotent: fetch + cache tasks for a session. */
  loadTasks: (sessionId: string) => Promise<void>;
  /** SSE-driven refresh — same network call as load, no debounce. */
  refreshTasks: (sessionId: string) => Promise<void>;
  /** Drop cache for a session (called on session unmount / removal). */
  clearTasks: (sessionId: string) => void;
}

export type LoomscopeStore = UISlice &
  WorkspaceSlice &
  SessionSlice &
  LiveEventSlice &
  TaskListSlice &
  import("./gitFilesSlice").GitFilesSlice &
  import("./sdkChannelSlice").SdkChannelSlice &
  import("./trashSlice").TrashSlice;
