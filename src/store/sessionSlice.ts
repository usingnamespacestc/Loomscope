import type { StateCreator } from "zustand";

import type { ChatFlow, ChatNode, DelegateNode, WorkFlow } from "@/data/types";
import type { AgentMetadata } from "@/parse/sidecar";
import type {
  DrillFrame,
  LoomscopeStore,
  SessionSlice,
  SessionState,
  SubAgentCacheEntry,
  WorkflowCacheEntry,
} from "@/store/types";

const EMPTY_VIEWPORT = { x: 0, y: 0, zoom: 1 };

function blankSessionState(): SessionState {
  return {
    chatFlow: null,
    foldedNodeIds: new Set<string>(),
    foldedCompactIds: new Set<string>(),
    viewport: EMPTY_VIEWPORT,
    selectedNodeId: null,
    workflowSelectedNodeId: null,
    drillStack: [],
    branchMemory: {},
    subAgentCache: new Map<string, SubAgentCacheEntry>(),
    workflowCache: new Map<string, WorkflowCacheEntry>(),
    workflowViewports: new Map<string, { x: number; y: number; zoom: number }>(),
    isLoading: false,
    error: null,
    lastUpdated: 0,
    lastInvalidateAt: 0,
  };
}

// localStorage stores the EXPLICITLY-UNFOLDED compact ids. New
// compacts (live-tail append, never-visited sessions) default-fold
// because they're not in the unfold set. v0.7.1's older "fold list"
// scheme broke for new compacts; the v0.9.1 flip to "unfold list"
// fixed that.
const UNFOLD_STORAGE_PREFIX = "loomscope:unfold:";

function unfoldStorageKey(sessionId: string): string {
  return `${UNFOLD_STORAGE_PREFIX}${sessionId}`;
}

function readUnfoldStorage(sessionId: string): string[] | null {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(unfoldStorageKey(sessionId))
        : null;
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

function writeUnfoldStorage(sessionId: string, unfoldedIds: Set<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      unfoldStorageKey(sessionId),
      JSON.stringify([...unfoldedIds]),
    );
  } catch {
    // quota / privacy / SSR — in-memory set still works.
  }
}

// v0.10 收尾: drop every per-session localStorage key for `sessionId`.
// Keep this list in sync with any future per-session storage we add —
// the central listing avoids leaving leaked keys behind. Called from
// `removeSession` when the workspace SSE reports the underlying jsonl
// was deleted; that's the only signal where we can be confident the
// key will never serve a future visit. (Sessions in non-loaded
// workspaces aren't sweepable from a global GC pass — we don't know
// whether they exist or were already deleted while Loomscope was
// offline. Stale-from-offline-deletion entries leak by design until a
// future TTL pass; today the bleed is negligible vs. the engineering
// cost of timestamping.)
function gcSessionLocalStorage(sessionId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(unfoldStorageKey(sessionId));
    // Legacy v0.7.1 → v0.9.1 "fold list" storage. Semantics flipped to
    // an "unfold list" so reads no longer hit it, but writes from old
    // installs may still be on disk — sweep alongside.
    localStorage.removeItem(`loomscope:fold:${sessionId}`);
  } catch {
    // Same hands-off failure mode as writeUnfoldStorage.
  }
}

// EN: Cheap structural equality check on a ChatNode workflow summary.
// Used by refreshSession's diff-merge to decide whether a ChatNode
// changed. All fields are primitives or short string arrays — full
// JSON-stringify would work but field-by-field is faster and
// avoids allocating a string per ChatNode per refresh.
// 中: ChatNode summary 的廉价结构相等判定，refreshSession diff-merge
// 用。字段都是基础类型或短数组，逐字段比对比 JSON.stringify 更快
// 也不需要每个 ChatNode 都分配字符串。
function workflowSummariesEqual(
  a: import("@/data/types").WorkflowSummary | undefined,
  b: import("@/data/types").WorkflowSummary | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.assistantPreview !== b.assistantPreview) return false;
  if (a.hasInFlightWork !== b.hasInFlightWork) return false;
  if (a.llmCount !== b.llmCount) return false;
  if (a.chainCount !== b.chainCount) return false;
  if (a.toolCount !== b.toolCount) return false;
  if (a.totalThinkingChars !== b.totalThinkingChars) return false;
  if (a.contextTokens !== b.contextTokens) return false;
  if (a.maxContextTokens !== b.maxContextTokens) return false;
  if (a.lastModel !== b.lastModel) return false;
  const af = a.toolUseFilePaths;
  const bf = b.toolUseFilePaths;
  if (af.length !== bf.length) return false;
  for (let i = 0; i < af.length; i += 1) {
    if (af[i] !== bf[i]) return false;
  }
  // assistantText: array equality. Length check fast-path; element-
  // wise on tie. Without this, refreshSession's diff-merge could
  // mark a ChatNode as "unchanged" when only mid-round text grew
  // (last round same → assistantPreview same → all numeric fields
  // same → equal returns true → old ref reused → bubble shows
  // stale text).
  // 中: assistantText 数组比对（长度 + 元素），避免 mid-round 文本
  // 增长但末轮不变时 diff-merge 误判等价、复用旧 summary。
  const at = a.assistantText;
  const bt = b.assistantText;
  if (at.length !== bt.length) return false;
  for (let i = 0; i < at.length; i += 1) {
    if (at[i] !== bt[i]) return false;
  }
  return true;
}

// Persist the explicitly-unfolded ids derived from the in-memory
// folded set. Computed as liveCompacts \ foldedSet so storage
// always reflects the current "user wants this open" state.
function persistUnfoldFromFolded(
  sessionId: string,
  foldedIds: Set<string>,
  chatFlow: ChatFlow,
): void {
  const unfolded = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    if (cn.isCompactSummary && !foldedIds.has(cn.id)) unfolded.add(cn.id);
  }
  writeUnfoldStorage(sessionId, unfolded);
}

// Compute the initial foldedCompactIds set for a freshly-loaded
// chatFlow. Default = all compacts FOLDED; subtract the explicitly-
// unfolded set from localStorage so user-unfolded ones stay open.
// Live compacts not mentioned in storage default-fold automatically.
export function hydrateFoldedCompactIds(
  sessionId: string,
  chatFlow: ChatFlow,
): Set<string> {
  const liveCompactIds = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    if (cn.isCompactSummary) liveCompactIds.add(cn.id);
  }
  const unfolded = new Set(readUnfoldStorage(sessionId) ?? []);
  const folded = new Set<string>();
  for (const id of liveCompactIds) {
    if (!unfolded.has(id)) folded.add(id);
  }
  return folded;
}

// In-flight loadSubAgent promises, keyed ``sessionId/agentId``. Lives
// outside the store because Promises aren't serializable and we want
// cheap dedupe without re-rendering subscribers.
const loadInFlight = new Map<string, Promise<SubAgentCacheEntry>>();

// v0.10 lazy ChatFlow B5 polish: microtask-coalesced flush buffer for
// `loadChatNodeWorkflows`. React's effect lifecycle fires children's
// useEffects BEFORE the parent's, so a ConversationView showing 50
// MessageBubbles produces 50 individual `loadChatNodeWorkflows([id])`
// calls (one per child hook) before the parent's batch
// `loadChatNodeWorkflows(sessionId, visiblePath)` runs. Without
// coalescing, that's 50 separate HTTP requests — observed in
// DevTools Network tab.
//
// Coalescing strategy:
//   - Synchronously mark each requested id as `pending` in the cache
//     so concurrent same-tick callers see them and skip re-adding.
//   - Accumulate ids into a per-session buffer.
//   - First caller schedules `queueMicrotask` to flush; later callers
//     in the same tick add to the existing buffer's id set.
//   - At microtask flush, fire ONE fetchWorkflowBatch with all
//     accumulated ids → 1 HTTP request total (or 2+ if > 100 ids,
//     since the helper still chunks at 100 per server URL limit).
//
// Side effect: the old per-id `workflowLoadInFlight` map is gone.
// Mid-fetch dedupe is now handled implicitly by the synchronous
// pending mark + the per-session buffer.
const workflowFlushBuffers = new Map<
  string,
  {
    ids: Set<string>;
    promise: Promise<void>;
    resolve: () => void;
  }
>();

// Helper used by `loadChatNodeWorkflows`. Splits the id list into
// chunks the server accepts (<= 200 ids per query) and concatenates
// the resulting workflow maps. Network failures in any chunk reject
// the whole call — caller is responsible for marking each requested
// id as `error` in that case.
async function fetchWorkflowBatch(
  sessionId: string,
  ids: string[],
): Promise<Record<string, WorkFlow>> {
  const CHUNK = 100;
  const merged: Record<string, WorkFlow> = {};
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const url = `/api/sessions/${sessionId}/chatnodes/workflows?ids=${slice.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    const body = (await res.json()) as {
      workflows: Record<string, { nodes: WorkFlow["nodes"]; edges: WorkFlow["edges"] }>;
    };
    for (const [id, wf] of Object.entries(body.workflows)) {
      // Server doesn't ship `summary` on the per-cn response (it
      // already lives on the lite ChatFlow's workflow.summary). We
      // reconstruct a complete WorkFlow object here so consumers
      // reading `entry.workflow.summary` after lazy load see the
      // same shape as before lazy load.
      merged[id] = {
        // summary will be back-filled by `loadChatNodeWorkflows`
        // from the existing chatFlow.chatNodes[id].workflow.summary.
        summary: undefined,
        nodes: wf.nodes,
        edges: wf.edges,
      };
    }
  }
  return merged;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return (await res.json()) as T;
}

export const createSessionSlice: StateCreator<LoomscopeStore, [], [], SessionSlice> = (
  set,
  get,
) => ({
  sessions: new Map<string, SessionState>(),
  activeSessionId: null,

  loadSession: async (id) => {
    const next = new Map(get().sessions);
    const prev = next.get(id) ?? blankSessionState();
    next.set(id, { ...prev, isLoading: true, error: null });
    set({ sessions: next });

    try {
      const cf = await fetchJson<ChatFlow>(`/api/sessions/${id}`);
      const updated = new Map(get().sessions);
      const cur = updated.get(id) ?? blankSessionState();
      updated.set(id, {
        ...cur,
        chatFlow: cf,
        // Hydrate fold state from localStorage (or default-fold all
        // compacts on first load). Done here rather than at first
        // subscriber so canvas / fold projection sees a populated set
        // on the very first render and doesn't flash "fully expanded
        // → folded" on session open.
        foldedCompactIds: hydrateFoldedCompactIds(id, cf),
        isLoading: false,
        error: null,
        lastUpdated: Date.now(),
      });
      set({ sessions: updated });
    } catch (err) {
      const updated = new Map(get().sessions);
      const cur = updated.get(id) ?? blankSessionState();
      updated.set(id, {
        ...cur,
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      set({ sessions: updated });
    }
  },

  // EN: v0.9 file-tail live re-fetch on SSE `invalidate`. Differs from
  // loadSession in two ways:
  //   (1) No isLoading flag flip — the user shouldn't see a full-screen
  //       "Parsing JSONL…" spinner just because the session ticked
  //       over; cards stay briefly stale until the network round-trip
  //       lands.
  //   (2) Reconciliation rather than overwrite: keeps selectedNodeId,
  //       workflowSelectedNodeId, viewport, drillStack, branchMemory.
  //       foldedCompactIds is re-hydrated against the new chatFlow so
  //       newly-appeared compacts default-fold + disappeared ones drop
  //       out (intersection logic mirrors initial load).
  // workflowCache cleared because lite ChatFlow's per-cn summary may
  // have shifted (turn count, contextTokens, etc.) — lazy hooks refetch
  // on next visibility. Failure here is non-fatal — previous chatFlow
  // is still valid; log and let the next invalidate retry.
  // 中: v0.9 file-tail 通过 SSE 'invalidate' 触发的实时刷新。跟
  // loadSession 的区别：(1) 不翻 isLoading（用户不该因为 session
  // 滴答一下就看到全屏 spinner）；(2) 保留 selection/viewport/drillStack
  // 等用户状态而不是覆盖。workflowCache 清空让 lazy hook 自动刷新；
  // subAgentCache 保留（避免 sub-agent drill 视图闪 loading）。失败
  // 不致命，记 log 等下次 SSE 重试。
  refreshSession: async (id) => {
    try {
      const cf = await fetchJson<ChatFlow>(`/api/sessions/${id}`);
      const updated = new Map(get().sessions);
      const cur = updated.get(id) ?? blankSessionState();
      // EN (v0.9.1 incremental refresh): naive replacement of chatFlow
      // + clearing the entire workflowCache produced a full-screen
      // stutter every time CC appended a turn — every ChatNodeCard
      // saw new prop identities, every useChatNodeWorkflow lost its
      // cache, all visible WorkFlows triggered re-fetches, React Flow
      // reconciled the whole graph. Diff-merge instead:
      //   - For each NEW ChatNode whose `summary` matches the OLD
      //     entry's, REUSE the old object reference. React.memo skips
      //     re-render, React Flow keeps the same node identity, no
      //     graph reconcile.
      //   - workflowCache entries for unchanged ChatNodes survive
      //     verbatim. The cache entry for the changed (typically
      //     latest) ChatNode is dropped so its lazy hook refetches
      //     fresh nodes — this is the only card that flickers.
      // Net effect: 200-card session, only the running latest card
      // re-renders + one targeted fetch. Matches Agentloom's
      // "append-only" feel for live updates.
      // 中: 全量替换 chatFlow + 清空 workflowCache 造成新一轮就全屏
      // 卡顿。改成 diff-merge：summary 不变的 ChatNode 复用旧引用
      // （React.memo + React Flow 跳过 reconcile）+ 只对改了 summary
      // 的那张卡（通常是最新一条）清 cache 让它重 fetch。200 卡片
      // session 只有 running 那一张闪一下，其他静默。
      const oldFlow = cur.chatFlow;
      const oldCache = cur.workflowCache;
      const oldById = oldFlow
        ? new Map(oldFlow.chatNodes.map((c) => [c.id, c]))
        : new Map<string, ChatNode>();
      const newCache = new Map<string, WorkflowCacheEntry>();
      const now = Date.now();
      const mergedChatNodes: ChatNode[] = cf.chatNodes.map((newCn) => {
        const oldCn = oldById.get(newCn.id);
        if (!oldCn) return newCn; // genuinely new ChatNode
        if (workflowSummariesEqual(oldCn.workflow.summary, newCn.workflow.summary)) {
          // Unchanged — preserve identity for memo/reconcile.
          const cached = oldCache.get(newCn.id);
          if (cached) newCache.set(newCn.id, cached);
          return oldCn;
        }
        // Summary shifted (turn count / contextTokens / etc.) — new
        // ref so canvas re-renders, but if there was a ready cached
        // workflow keep it visible as STALE while the lazy hook
        // refetches in the background. Without this the WorkFlowCanvas
        // briefly renders an empty placeholder during the 50-100ms
        // fetch window. Drill view is the most affected — that's the
        // running ChatNode whose summary keeps shifting.
        const cached = oldCache.get(newCn.id);
        if (cached?.status === "ready" && cached.workflow) {
          newCache.set(newCn.id, { ...cached, staleSince: now });
        }
        return newCn;
      });
      const mergedFlow: ChatFlow = { ...cf, chatNodes: mergedChatNodes };
      // EN: foldedCompactIds preservation. Previous behaviour
      // (`hydrateFoldedCompactIds(id, mergedFlow)`) re-read
      // localStorage on every refresh, which OVERRODE any in-session
      // fold/unfold the user did since the page loaded. Symptom:
      // user folds compact X → CC writes a new turn → SSE invalidate
      // → refreshSession re-hydrates → if storage's unfold list has
      // X (e.g., from earlier hover-pan poll-pollution before the
      // persist:false fix), X gets re-marked unfolded.
      // Fix: keep cur.foldedCompactIds verbatim for existing compacts
      // + add NEW compacts (appeared since last refresh) as folded
      // (default-fold for fresh nodes). Drop dead compacts (no longer
      // in chatFlow) so the set doesn't grow unbounded. Storage is
      // only consulted at session-load time via hydrateFoldedCompactIds.
      // 中: refresh 不再 re-hydrate fold；保留内存里的用户操作，新出
      // 现的 compact 默认折叠，已消失的 compact 从集合移除。storage
      // 只在 session 首次 load 时读。修复"已折叠 compact 在收到新消
      // 息后被打开"的问题（脏 storage 数据每次 refresh 都覆盖）。
      const liveCompactIds = new Set<string>();
      const oldCompactIds = new Set<string>();
      if (oldFlow) {
        for (const cn of oldFlow.chatNodes) {
          if (cn.isCompactSummary) oldCompactIds.add(cn.id);
        }
      }
      for (const cn of mergedFlow.chatNodes) {
        if (cn.isCompactSummary) liveCompactIds.add(cn.id);
      }
      const nextFolded = new Set<string>();
      for (const id of liveCompactIds) {
        if (cur.foldedCompactIds.has(id)) {
          nextFolded.add(id); // user-folded already, keep
        } else if (!oldCompactIds.has(id)) {
          nextFolded.add(id); // newly appeared → default-fold
        }
        // else: user explicitly unfolded earlier in this session, keep unfolded
      }
      const foldedChanged =
        nextFolded.size !== cur.foldedCompactIds.size ||
        [...nextFolded].some((id) => !cur.foldedCompactIds.has(id));
      // EN: follow-on-leaf — when a new ChatNode arrives whose parent
      // is the user's currently-focused ChatNode, advance focus to
      // the new one. Repeats forward through any chain of new
      // children so the user lands on the LEAF of the new turn.
      // If focus is mid-history (new ChatNode descends from a
      // DIFFERENT path), focus stays put — user is reading the
      // past, don't yank. Drives ConversationView's selectedId-
      // driven scroll-to-new-message UX too.
      //
      // Implicit-focus case: when `cur.selectedNodeId === null` the
      // user hasn't explicitly clicked anything, but the conversation
      // panel defaults to showing the latest leaf's path. So we
      // treat "no explicit selection" as "implicit focus on the
      // chronologically last ChatNode" and run the same follow-on-
      // leaf logic. This way passively watching a session live still
      // auto-advances focus + scrolls to new messages.
      // 中: 用户 focus 的节点是新 ChatNode 的父节点 → 自动跟随到最新
      // leaf。focus 在历史中（新节点不从这里延伸）→ 不动。
      // 隐式焦点：selectedNodeId 为 null 时，把上一份 chatFlow 的最后
      // 一条 ChatNode 当成隐式焦点（用户在被动观察 leaf），同样跟随。
      let nextSelected = cur.selectedNodeId;
      if (oldFlow) {
        const oldIds = oldById; // Map of old ids
        const implicitLeaf =
          oldFlow.chatNodes[oldFlow.chatNodes.length - 1]?.id ?? null;
        const effectiveSelected = cur.selectedNodeId ?? implicitLeaf;
        if (effectiveSelected) {
          let cursor = effectiveSelected;
          // Walk forward while children-of-cursor include new ChatNodes.
          // Greedy single-chain follow — for parallel forks both new,
          // we pick the first found (chronological by chatNodes order)
          // and let the user click to switch siblings.
          // Cap at chatNodes.length hops as a defensive cycle guard.
          for (let hops = 0; hops < mergedFlow.chatNodes.length; hops += 1) {
            const child = mergedFlow.chatNodes.find(
              (c) => c.parentChatNodeId === cursor && !oldIds.has(c.id),
            );
            if (!child) break;
            cursor = child.id;
          }
          if (cursor !== effectiveSelected) nextSelected = cursor;
        }
      }
      updated.set(id, {
        ...cur,
        chatFlow: mergedFlow,
        foldedCompactIds: foldedChanged ? nextFolded : cur.foldedCompactIds,
        workflowCache: newCache,
        selectedNodeId: nextSelected,
        // subAgentCache stays — sub-agent ids are sidecar-rooted; the
        // sub-agent SSE invalidate path (kind='subagent') has its own
        // refreshSubAgent action that targets only the affected agent.
        isLoading: false,
        error: null,
        lastUpdated: Date.now(),
      });
      set({ sessions: updated });
    } catch (err) {
      // Failure on a refresh is non-fatal — the previous chatFlow is
      // still valid; log and let the next SSE invalidate retry.
      console.error("[loomscope] refreshSession failed:", err);
    }
  },

  // v0.9.1: re-fetch a single sub-agent in response to SSE invalidate
  // with kind='subagent'. Strategy: only act if the entry was already
  // ready (= someone is presumably looking at it); for cold entries
  // the next loadSubAgent will pick up fresh on demand.
  refreshSubAgent: async (sessionId, agentId, subdir) => {
    const sess = get().sessions.get(sessionId);
    const cached = sess?.subAgentCache.get(agentId);
    if (!cached || cached.status !== "ready") return;
    // Mark as loading so consumers see the transition; loadSubAgent
    // would short-circuit on `ready` so we have to demote first.
    setSubAgentCacheEntry(get, set, sessionId, agentId, {
      ...cached,
      status: "loading",
      lastAccess: Date.now(),
    });
    try {
      await get().loadSubAgent(sessionId, agentId, subdir);
    } catch (err) {
      console.error("[loomscope] refreshSubAgent failed:", err);
    }
  },

  markSessionActivity: (sessionId) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur) return;
    const updated = new Map(sessions);
    updated.set(sessionId, { ...cur, lastInvalidateAt: Date.now() });
    set({ sessions: updated });
  },

  setActiveSession: (id) => {
    // Evict the previous session's sub-agent cache. Cross-session
    // sharing isn't valuable (uuids belong to different jsonls) and
    // a long-running viewer would otherwise pile up sub-agent
    // ChatFlows from every session the user has visited.
    const prevId = get().activeSessionId;
    if (prevId && prevId !== id) {
      const sessions = get().sessions;
      const prev = sessions.get(prevId);
      if (prev && prev.subAgentCache.size > 0) {
        const updated = new Map(sessions);
        updated.set(prevId, { ...prev, subAgentCache: new Map() });
        set({ sessions: updated });
      }
    }
    if (id && !get().sessions.has(id)) {
      // Auto-load if we haven't fetched it yet. Fire-and-forget.
      void get().loadSession(id);
    }
    set({ activeSessionId: id });
  },

  removeSession: (id) => {
    const sessions = new Map(get().sessions);
    if (sessions.has(id)) {
      sessions.delete(id);
      set({ sessions });
    }
    // If the removed session was active, clear the pointer — App.tsx
    // shows the empty-state CTA when activeSessionId is null.
    if (get().activeSessionId === id) {
      set({ activeSessionId: null });
    }
    gcSessionLocalStorage(id);
  },

  // Toggle a node's membership in ``foldedNodeIds``. v0.5 ChatFlow-
  // layer fold UX (currently dormant). Symmetrical: re-toggle removes.
  toggleFold: (sessionId, nodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    const folded = new Set(cur.foldedNodeIds);
    if (folded.has(nodeId)) folded.delete(nodeId);
    else folded.add(nodeId);
    updated.set(sessionId, { ...cur, foldedNodeIds: folded });
    set({ sessions: updated });
  },

  setSelected: (sessionId, nodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    updated.set(sessionId, { ...cur, selectedNodeId: nodeId });
    set({ sessions: updated });
  },

  setViewport: (sessionId, vp) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    updated.set(sessionId, { ...cur, viewport: vp });
    set({ sessions: updated });
  },

  // ── Drill-down navigation (v0.3 + v0.6 redo) ──────────────────────
  // Push a ChatNode frame and reset workflow-layer selection so the
  // drill view opens "fresh".
  //
  // Stack-aware: when the current top frame is ``subworkflow`` (= we're
  // viewing a sub-agent's ChatFlow recursively), enterWorkflow PUSHES
  // a chatnode frame so the drill stack records the path
  // ``main → CN A → 🤖 Agent → CN B``. From any other state (empty or
  // top-level chatnode), it RESETS to a single-frame stack — that's the
  // top-level "click ChatNode in main canvas" path.
  enterWorkflow: (sessionId, chatNodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    const top = cur.drillStack[cur.drillStack.length - 1];
    // Idempotent on the same chatnode at the top.
    if (top?.kind === "chatnode" && top.chatNodeId === chatNodeId) return;
    // EN: Stack-aware push.
    //   top kind == subworkflow → user is viewing a sub-agent's
    //     ChatFlow; click is a sub-ChatNode drill → APPEND a chatnode
    //     frame (`[CN A, 🤖, CN B]`).
    //   otherwise (empty stack or top is chatnode) → user is at the
    //     top-level ChatFlow; click is a "from scratch" drill →
    //     RESET to a single-frame stack `[CN]`.
    // ⚠ Do NOT disambiguate by "is chatNodeId in top-level scope?" —
    // CC's Task delegation reuses the parent's user uuid as the
    // sub-agent jsonl's first user record uuid, so sub-agent ChatNodes
    // routinely share `id` with a top-level ChatNode. id-based
    // check produces false RESETs that drop the user out of a deep
    // drill back to the top-level WorkFlow. The drillStack top
    // (= which canvas is currently being clicked) is the only
    // reliable signal. See `docs/design-data-model.md` "uuid 共享
    // 陷阱" + `feedback_loomscope_uuid_sharing` memory entry.
    // 中: 按 drillStack 顶帧类型决定 push 还是 reset。⚠ 不能用 id 判
    // scope —— sub-agent ChatNode 跟 parent ChatNode 共享 uuid（CC
    // delegate 派发复用 parent 的 user uuid），id-based 判定会把
    // sub-agent 内点击误识别为 top-level click 触发 RESET 把用户
    // 踢回顶层。drillStack 顶帧（= 用户在哪块 canvas 上点）才是
    // 可靠信号。详见 design-data-model.md 的 "uuid 共享陷阱"。
    const drillStack: DrillFrame[] =
      top?.kind === "subworkflow"
        ? [...cur.drillStack, { kind: "chatnode", chatNodeId }]
        : [{ kind: "chatnode", chatNodeId }];
    updated.set(sessionId, {
      ...cur,
      drillStack,
      workflowSelectedNodeId: null,
    });
    set({ sessions: updated });
  },

  // Pop everything — back to ChatFlow view. Also clears workflow-layer
  // selection so a future drill into a different ChatNode doesn't
  // accidentally read a stale id.
  exitWorkflow: (sessionId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    if (cur.drillStack.length === 0 && cur.workflowSelectedNodeId === null) return;
    updated.set(sessionId, {
      ...cur,
      drillStack: [],
      workflowSelectedNodeId: null,
    });
    set({ sessions: updated });
  },

  // Cut the stack to the first ``depth`` frames. ``depth=0`` is
  // equivalent to ``exitWorkflow``. Used by the breadcrumb to jump
  // back N levels in v0.5+ when nested drill stacks exist; v0.3 only
  // reaches depth=1 in practice.
  truncateDrillStack: (sessionId, depth) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    if (cur.drillStack.length <= depth) return;
    updated.set(sessionId, {
      ...cur,
      drillStack: cur.drillStack.slice(0, Math.max(0, depth)),
      workflowSelectedNodeId: depth === 0 ? null : cur.workflowSelectedNodeId,
    });
    set({ sessions: updated });
  },

  setWorkflowSelected: (sessionId, nodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    updated.set(sessionId, { ...cur, workflowSelectedNodeId: nodeId });
    set({ sessions: updated });
  },

  setWorkflowViewport: (sessionId, chatNodeId, viewport) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    const next = new Map(cur.workflowViewports);
    if (viewport == null) {
      if (!next.has(chatNodeId)) return;
      next.delete(chatNodeId);
    } else {
      const prev = next.get(chatNodeId);
      if (
        prev &&
        prev.x === viewport.x &&
        prev.y === viewport.y &&
        prev.zoom === viewport.zoom
      ) {
        return; // no-op — avoid an unnecessary store update
      }
      next.set(chatNodeId, viewport);
    }
    updated.set(sessionId, { ...cur, workflowViewports: next });
    set({ sessions: updated });
  },

  // ── v0.10 lazy ChatFlow B2 + B5 polish: per-ChatNode workflow lazy load ──
  loadChatNodeWorkflows: async (sessionId, chatNodeIds) => {
    if (chatNodeIds.length === 0) return;
    const sess0 = get().sessions.get(sessionId);
    if (!sess0) return;

    // EN: Filter to ids that need a network fetch. Skip when already
    // pending (in-flight) or ready+fresh. Refetch when:
    //   - no cache entry yet (first access)
    //   - status === "error" (caller-driven retry)
    //   - status === "ready" but `staleSince` set (refreshSession
    //     marked the entry stale because summary shifted; we keep
    //     the old workflow visible meanwhile so no flicker)
    // 中: 决定哪些 id 真要发请求。已 pending 跳过；ready 且不 stale
    // 跳过；error 重试；ready+staleSince 后台刷新。
    const cache = sess0.workflowCache;
    const toFetch: string[] = [];
    for (const id of chatNodeIds) {
      const e = cache.get(id);
      if (!e) {
        toFetch.push(id);
        continue;
      }
      if (e.status === "pending") continue;
      if (e.status === "ready" && !e.staleSince) continue;
      // error OR (ready + stale) → fetch
      toFetch.push(id);
    }
    if (toFetch.length === 0) return;

    // EN: Mark to-fetch ids as `pending` synchronously so other
    // callers in the same tick see them and skip re-adding to the
    // toFetch list. For STALE entries (had ready workflow), preserve
    // the old workflow as the placeholder body — useChatNodeWorkflow
    // displays it while the fetch is in flight, no empty-canvas
    // flicker. Once the fetch lands, status flips to ready + clean.
    // 中: 同步标 pending 防同 tick 重入。stale 的 entry 保留旧
    // workflow 作占位，避免画布空白闪烁。
    {
      const sessions = new Map(get().sessions);
      const cur = sessions.get(sessionId);
      if (!cur) return;
      const next = new Map(cur.workflowCache);
      for (const id of toFetch) {
        const prev = next.get(id);
        const stalePlaceholder =
          prev?.staleSince && prev.workflow ? prev.workflow : null;
        next.set(id, {
          status: "pending",
          workflow: stalePlaceholder,
          error: null,
        });
      }
      sessions.set(sessionId, { ...cur, workflowCache: next });
      set({ sessions });
    }

    // Coalesce into the per-session microtask buffer. First caller in
    // a tick schedules the flush; subsequent callers add to the
    // existing buffer's id set and share its promise. Net effect: N
    // synchronous calls in the same tick produce 1 HTTP request (or
    // ceil(N/100) if > 100 unique ids — fetchWorkflowBatch chunks
    // for the server URL length limit).
    let buf = workflowFlushBuffers.get(sessionId);
    if (!buf) {
      let resolveFn!: () => void;
      const promise = new Promise<void>((res) => {
        resolveFn = res;
      });
      buf = { ids: new Set(toFetch), promise, resolve: resolveFn };
      workflowFlushBuffers.set(sessionId, buf);
      queueMicrotask(async () => {
        const flush = workflowFlushBuffers.get(sessionId);
        if (!flush) return;
        workflowFlushBuffers.delete(sessionId);
        const allIds = [...flush.ids];
        try {
          const map = await fetchWorkflowBatch(sessionId, allIds);
          const sessions = new Map(get().sessions);
          const cur = sessions.get(sessionId);
          if (!cur) {
            flush.resolve();
            return;
          }
          const next = new Map(cur.workflowCache);
          // Back-fill summary from the lite ChatFlow's existing
          // workflow.summary so post-load shape mirrors the old
          // pre-lazy world.
          const cnIndex = new Map(
            (cur.chatFlow?.chatNodes ?? []).map((cn) => [cn.id, cn]),
          );
          // EN: WorkFlow follow-on-leaf — when a refresh delivers a
          // newer workflow whose tail differs from the one the user
          // is currently looking at, advance `workflowSelectedNodeId`
          // to the new tail. Mirrors the ChatFlow follow-on-leaf in
          // refreshSession: only triggers when the user was sitting
          // ON the old tail (= passively watching the leaf), so
          // historic-inspection focus is never yanked. Drives the
          // WorkFlow drill's running animation + auto-scroll on the
          // newest WorkNode without user intervention. Latched in
          // commit `3ea2248`'s message but missed the v0.9.2 batch
          // — landing now as part of the v0.10 收尾 sweep.
          // 中: WorkFlow 层 follow-on-leaf。refresh 拿到新 WorkFlow
          // 后若用户原本就停在 old tail，把 workflowSelectedNodeId
          // 跟到 new tail；停在中段不动（用户在审历史，不抢焦点）。
          let nextWfSelected = cur.workflowSelectedNodeId;
          for (const id of allIds) {
            const wf = map[id];
            if (wf) {
              const existing = cnIndex.get(id);
              const summary =
                existing?.workflow.summary ?? wf.summary ?? undefined;
              if (cur.workflowSelectedNodeId) {
                const oldNodes = cur.workflowCache.get(id)?.workflow?.nodes;
                if (oldNodes && oldNodes.length > 0) {
                  const oldTail = oldNodes[oldNodes.length - 1].id;
                  if (oldTail === cur.workflowSelectedNodeId) {
                    const newTail =
                      wf.nodes.length > 0
                        ? wf.nodes[wf.nodes.length - 1].id
                        : null;
                    if (newTail && newTail !== oldTail) {
                      nextWfSelected = newTail;
                    }
                  }
                }
              }
              next.set(id, {
                status: "ready",
                workflow: { ...wf, summary },
                error: null,
              });
            } else {
              // Server omitted this id → treat as error. Client can
              // retry by calling loadChatNodeWorkflows again.
              next.set(id, {
                status: "error",
                workflow: null,
                error: "not found in batch response",
              });
            }
          }
          sessions.set(sessionId, {
            ...cur,
            workflowCache: next,
            workflowSelectedNodeId: nextWfSelected,
          });
          set({ sessions });
        } catch (err) {
          const sessions = new Map(get().sessions);
          const cur = sessions.get(sessionId);
          if (cur) {
            const next = new Map(cur.workflowCache);
            const msg = err instanceof Error ? err.message : String(err);
            for (const id of allIds) {
              next.set(id, { status: "error", workflow: null, error: msg });
            }
            sessions.set(sessionId, { ...cur, workflowCache: next });
            set({ sessions });
          }
        } finally {
          flush.resolve();
        }
      });
    } else {
      for (const id of toFetch) buf.ids.add(id);
    }

    await buf.promise;
  },

  // ── v0.5 sub-agent nesting ─────────────────────────────────────────
  loadSubAgent: async (sessionId, agentId, subdir) => {
    // Cache hit: return immediately. The render path still gets a
    // bumped lastAccess via setSubAgentCacheEntry below.
    const sessions0 = get().sessions;
    const sess0 = sessions0.get(sessionId);
    const cached = sess0?.subAgentCache.get(agentId);
    if (cached && cached.status === "ready") {
      setSubAgentCacheEntry(get, set, sessionId, agentId, {
        ...cached,
        lastAccess: Date.now(),
      });
      return cached;
    }
    // Race guard: collapse concurrent fetches for the same agent.
    const dedupeKey = `${sessionId}/${agentId}/${subdir ?? ""}`;
    const inFlight = loadInFlight.get(dedupeKey);
    if (inFlight) return inFlight;

    const loadingEntry: SubAgentCacheEntry = {
      status: "loading",
      chatFlow: null,
      meta: null,
      error: null,
      lastAccess: Date.now(),
    };
    setSubAgentCacheEntry(get, set, sessionId, agentId, loadingEntry);

    const promise = (async (): Promise<SubAgentCacheEntry> => {
      try {
        const url = `/api/sessions/${sessionId}/subagents/${agentId}${subdir ? `?subdir=${encodeURIComponent(subdir)}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          chatFlow: ChatFlow;
          meta: AgentMetadata | null;
        };
        const entry: SubAgentCacheEntry = {
          status: "ready",
          chatFlow: body.chatFlow,
          meta: body.meta,
          error: null,
          lastAccess: Date.now(),
        };
        setSubAgentCacheEntry(get, set, sessionId, agentId, entry);
        return entry;
      } catch (e) {
        const entry: SubAgentCacheEntry = {
          status: "error",
          chatFlow: null,
          meta: null,
          error: e instanceof Error ? e.message : String(e),
          lastAccess: Date.now(),
        };
        setSubAgentCacheEntry(get, set, sessionId, agentId, entry);
        return entry;
      } finally {
        loadInFlight.delete(dedupeKey);
      }
    })();
    loadInFlight.set(dedupeKey, promise);
    return promise;
  },

  enterSubWorkflow: (sessionId, parentWorkNodeId) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) {
      console.warn("[loomscope] enterSubWorkflow: no chatFlow", { sessionId });
      return;
    }
    if (cur.drillStack.length === 0) {
      console.warn(
        "[loomscope] enterSubWorkflow: drillStack empty (need a chatnode frame first)",
        { parentWorkNodeId },
      );
      return;
    }

    // Idempotent: if the top frame already targets this WorkNode,
    // skip the re-push. Avoids a stray double-double-click stacking
    // two identical frames.
    const top = cur.drillStack[cur.drillStack.length - 1];
    if (top.kind === "subworkflow" && top.parentWorkNodeId === parentWorkNodeId) {
      console.info(
        "[loomscope] enterSubWorkflow: idempotent (already on this delegate)",
        { parentWorkNodeId },
      );
      return;
    }

    // Validate: the parentWorkNodeId must resolve to a delegate
    // WorkNode in the currently visible WorkFlow. Walk the current
    // drill stack to find it; if validation fails, drop the push.
    const delegate = resolveDelegate(cur, parentWorkNodeId);
    if (!delegate) {
      // resolveDelegate already warns about WorkNode-not-found; this
      // covers "found but not a delegate" too.
      return;
    }
    const agentId = delegate.agentId;
    if (!agentId) {
      console.warn(
        "[loomscope] enterSubWorkflow: delegate has no agentId (sidecar not locatable)",
        { parentWorkNodeId, delegateId: delegate.id },
      );
      return;
    }

    const nextStack: DrillFrame[] = [
      ...cur.drillStack,
      { kind: "subworkflow", parentWorkNodeId },
    ];
    const updated = new Map(sessions);
    updated.set(sessionId, {
      ...cur,
      drillStack: nextStack,
      workflowSelectedNodeId: null,
    });
    set({ sessions: updated });

    // Kick off the lazy load — fire and forget; the UI subscribes to
    // the cache entry and re-renders when ``status`` flips.
    void get().loadSubAgent(sessionId, agentId);
  },

  // Compact-fold mutators. Validation is uniform: bail if the session
  // doesn't exist, bail if the id isn't a compact ChatNode in the
  // current chatFlow. We don't validate that the compact is "in scope"
  // (i.e. visible at the current drill depth) — the fold set is global
  // across drill frames; toggling from a sub-ChatFlow drill view should
  // affect what shows when the user pops back to top-level too.
  foldCompact: (sessionId, compactChatNodeId, opts) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) return;
    if (!isCompactChatNodeInFlow(cur.chatFlow, compactChatNodeId)) return;
    const next = new Set(cur.foldedCompactIds);
    next.add(compactChatNodeId);
    const updated = new Map(sessions);
    updated.set(sessionId, { ...cur, foldedCompactIds: next });
    set({ sessions: updated });
    // EN: hover-pan release path passes persist:false to undo a
    // transient hover-unfold without writing the in-memory state
    // back to storage. Symmetric with unfoldCompact's opts.persist.
    // 中: hover 预览结束时调本 action 重新折叠，传 persist:false
    // 避免把临时状态写回 storage。
    if (opts?.persist !== false) {
      persistUnfoldFromFolded(sessionId, next, cur.chatFlow);
    }
  },
  unfoldCompact: (sessionId, compactChatNodeId, opts) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) return;
    if (!isCompactChatNodeInFlow(cur.chatFlow, compactChatNodeId)) return;
    const next = new Set(cur.foldedCompactIds);
    next.delete(compactChatNodeId);
    const updated = new Map(sessions);
    updated.set(sessionId, { ...cur, foldedCompactIds: next });
    set({ sessions: updated });
    // EN (v0.9.1): hover-pan auto-unfold passes persist:false so
    // transient navigation doesn't leak into the user's
    // explicit-unfold set. User-explicit clicks (chatFold node card,
    // compact node fold-toggle button) leave the default true and
    // persist normally. See `feedback_canvas_gestures_unreliable`
    // memo + the v0.9.1 hover-pan fix in devlog.
    // 中: hover-pan 自动展开走 persist:false，避免临时导航污染用户
    // 显式展开偏好。用户主动点击的（chatFold 卡片、compact 节点切
    // 换按钮）默认 persist=true 正常持久化。
    if (opts?.persist !== false) {
      persistUnfoldFromFolded(sessionId, next, cur.chatFlow);
    }
  },
  toggleCompactFold: (sessionId, compactChatNodeId) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) return;
    if (!isCompactChatNodeInFlow(cur.chatFlow, compactChatNodeId)) return;
    const next = new Set(cur.foldedCompactIds);
    if (next.has(compactChatNodeId)) next.delete(compactChatNodeId);
    else next.add(compactChatNodeId);
    const updated = new Map(sessions);
    updated.set(sessionId, { ...cur, foldedCompactIds: next });
    set({ sessions: updated });
    persistUnfoldFromFolded(sessionId, next, cur.chatFlow);
  },

  // v0.8 M4: ConversationView BranchSelector picks a branch.
  // - flips selectedNodeId to leafChatNodeId so canvas + Conversation
  //   tab follow the new path immediately
  // - stores forkChildId → leafChatNodeId in branchMemory so when the
  //   user re-enters the fork point later, the path resolver (driven
  //   off selectedNodeId) can use the stored leaf as the default.
  // The "auto-restore" UX layer is consumed by the ConversationView
  // when computing the default endpoint for a fork — see M4
  // ConversationView.tsx.
  pickBranch: (sessionId, forkChildId, leafChatNodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    updated.set(sessionId, {
      ...cur,
      selectedNodeId: leafChatNodeId,
      branchMemory: { ...cur.branchMemory, [forkChildId]: leafChatNodeId },
    });
    set({ sessions: updated });
  },
});

/**
 * Resolve the current drill view — what the main canvas should render
 * given the ``drillStack`` walked against the live ``chatFlow`` plus
 * ``subAgentCache``. Returns null when the stack is empty (= top-level
 * ChatFlow view) or when a frame can't be resolved (cache miss /
 * stale id) — the canvas should treat null as "fall back to ChatFlow
 * view + suppress breadcrumb depth".
 *
 * v0.6 redo: sub-agent drill returns the FULL sub ChatFlow (rendered
 * recursively by ChatFlowCanvas) instead of collapsing to chatNodes[0].
 * The 27% multi-ChatNode sub-agents that needed the v0.5 amber banner
 * now drill into a real second-level ChatFlow canvas.
 */
export type ResolvedDrillView =
  | {
      mode: "workflow";
      // The ChatNode whose .workflow renders in WorkFlowCanvas.
      chatNode: import("@/data/types").ChatNode;
      // ChatFlow that owns chatNode (top-level main or a sub-agent).
      // DrillPanel uses this as the lookup scope for ChatNode selection.
      scopeChatFlow: ChatFlow;
      frameLabels: DrillBreadcrumbItem[];
    }
  | {
      mode: "sub-chatflow";
      // Sub-agent ChatFlow rendered recursively by ChatFlowCanvas.
      chatFlow: ChatFlow;
      frameLabels: DrillBreadcrumbItem[];
    };

export interface DrillBreadcrumbItem {
  // Frame depth (0 = first chatnode frame).
  depth: number;
  // Display label.
  label: string;
  // ``hover`` tooltip — full id / agentId etc.
  title: string;
  // Frame kind for icon selection.
  kind: "chatnode" | "subworkflow";
  // True when this frame represents an auto-compact sub-agent
  // (agentId starts with ``acompact-``).
  isAutoCompact: boolean;
}

// True when the given id refers to a compact ChatNode in the live
// flow. Used by ``foldCompact`` / ``unfoldCompact`` /
// ``toggleCompactFold`` as a defensive guard so a stale / spoofed id
// can't leak into ``foldedCompactIds`` and pollute fold projection /
// localStorage.
function isCompactChatNodeInFlow(cf: ChatFlow, id: string): boolean {
  return cf.chatNodes.some((c) => c.id === id && c.isCompactSummary);
}

// Compute the full pre-compact range for a compact ChatNode: the chain
// of ChatNodes that this compact's summary distilled from. We walk
// parentChatNodeId from ``compactMetadata.logicalParentChatNodeId``
// (= the tail ChatNode the boundary points back at) all the way to
// the session root, **including any earlier compact ChatNodes on the
// chain** — because CC's auto-compact summarises the entire current
// context window, which already has the previous compact summary at
// its head plus everything since. So compact_2's range strictly
// contains compact_1 + the segments between them.
//
// Strict containment across compacts is what makes largest-range
// attribution (M2 ``computeFoldProjection``) collapse a 131-deep
// nested chain into a single visible fold-host node by default.
//
// Returns [] when the anchor isn't a compact ChatNode, the
// logicalParentChatNodeId is missing, or the chain is empty/dangling.
// Order: time-ascending (root-most first, tail last) so callers can
// treat ``range[0]`` as "earliest" / ``range.at(-1)`` as "tail just
// before the compact host".
export function computeCompactRange(
  scope: ChatFlow,
  compactChatNodeId: string,
): ChatNode[] {
  const byId = new Map(scope.chatNodes.map((c) => [c.id, c]));
  const compactCn = byId.get(compactChatNodeId);
  if (!compactCn?.isCompactSummary) return [];
  const startId = compactCn.compactMetadata?.logicalParentChatNodeId;
  if (!startId) return [];
  const start = byId.get(startId);
  if (!start) return [];
  const collected: ChatNode[] = [];
  let cursor: ChatNode | undefined = start;
  // Cap at 5000 hops as a defensive cycle guard. Real sessions don't
  // hit this; corrupt parentChatNodeId chains from JSONL surgery
  // shouldn't lock the resolver.
  for (let hops = 0; cursor && hops < 5000; hops += 1) {
    collected.push(cursor);
    if (!cursor.parentChatNodeId) break;
    const next = byId.get(cursor.parentChatNodeId);
    if (!next) break;
    cursor = next;
  }
  return collected.reverse();
}

// EN: Render-side drill resolver. Walks drillStack and produces the
// final view shape (= which canvas to render, what the breadcrumb
// labels are, what scope the visible ChatFlow is). Mirror of
// `resolveDelegate` for the navigation-time path.
//
// Critical invariant: scope is determined by walker POSITION (have
// we crossed a subworkflow frame yet?), NOT by ChatNode ids. CC's
// Task delegation reuses parent user uuids → top-level and sub-agent
// ChatNodes routinely share `id`. Any id-based scope check produces
// wrong results — see the v0.9.1 4-bug-chain in
// `docs/devlog.md` 2026-05-06 凌晨 entry.
//
// 中: 渲染时的 drill 解析器。walker 走 drillStack 决定渲染哪个 canvas
// + breadcrumb 标签 + 当前作用域 ChatFlow。Scope 必须用 walker 位置
// 判定（是否跨过 subworkflow 帧），不能用 ChatNode id —— sub-agent
// 的 ChatNode 跟 parent 共享 uuid，id-based 判定会错。详见 v0.9.1
// 4 个 bug 链（devlog 2026-05-06 凌晨条目）。
export function resolveDrillView(state: SessionState): ResolvedDrillView | null {
  if (!state.chatFlow || state.drillStack.length === 0) return null;
  let scopeChatFlow: ChatFlow = state.chatFlow;
  let chatNode: import("@/data/types").ChatNode | null = null;
  // EN: True once the walker has crossed any subworkflow frame. From
  // that point on, scope is sub-agent (chatFlow loaded via /subagents
  // is full-fat → inline workflow.nodes is authoritative). Before
  // that, scope is top-level (lite mode → read from workflowCache).
  // 中: walker 跨过 subworkflow 后，scope 进入 sub-agent（/subagents
  // 端点返 full-fat，inline workflow.nodes 可用）；之前是 top-level
  // （lite 模式，需要读 workflowCache）。
  let crossedSubWorkflow = false;
  const labels: DrillBreadcrumbItem[] = [];
  for (let depth = 0; depth < state.drillStack.length; depth += 1) {
    const frame = state.drillStack[depth];
    if (frame.kind === "chatnode") {
      const cn = scopeChatFlow.chatNodes.find((c) => c.id === frame.chatNodeId);
      if (!cn) return null;
      chatNode = cn;
      labels.push({
        depth,
        kind: "chatnode",
        label: `ChatNode (${cn.id.slice(0, 8)})`,
        title: `ChatNode ${cn.id}`,
        isAutoCompact: false,
      });
      continue;
    }
    // subworkflow: previous frame's chatNode owns the delegate WorkNode
    // whose agentId names the sub-agent ChatFlow. The scope advances
    // to that ChatFlow; chatNode resets so the next chatnode frame (if
    // any) picks one out of the sub scope.
    if (!chatNode) return null;
    // v0.10 lazy: top-level chatNode's `workflow.nodes` is empty in
    // lite mode → must read workflowCache. Once we've crossed a
    // subworkflow descend, scope is sub-agent → inline nodes are
    // authoritative (full-fat from /subagents). Position-based check
    // is reliable; id-based is NOT (sub-agent ChatNodes can share
    // ids with top-level via parent-uuid reuse).
    let nodes: import("@/data/types").WorkNode[];
    if (!crossedSubWorkflow) {
      const cached = state.workflowCache.get(chatNode.id);
      nodes =
        cached?.status === "ready" && cached.workflow
          ? cached.workflow.nodes
          : chatNode.workflow.nodes;
    } else {
      nodes = chatNode.workflow.nodes;
    }
    const delegate = nodes.find(
      (n) => n.id === frame.parentWorkNodeId && n.kind === "delegate",
    ) as DelegateNode | undefined;
    if (!delegate?.agentId) return null;
    const cached = state.subAgentCache.get(delegate.agentId);
    if (cached?.status !== "ready" || !cached.chatFlow) return null;
    scopeChatFlow = cached.chatFlow;
    chatNode = null;
    crossedSubWorkflow = true;
    const isAutoCompact = delegate.agentId.startsWith("acompact-");
    const agentLabel =
      cached.meta?.agentType ??
      delegate.agentType ??
      delegate.agentId.slice(0, 8);
    labels.push({
      depth,
      kind: "subworkflow",
      label: `🤖 ${isAutoCompact ? "auto-compact" : `Agent (${agentLabel})`}`,
      title: `agentId ${delegate.agentId}`,
      isAutoCompact,
    });
  }
  const last = state.drillStack[state.drillStack.length - 1];
  if (last.kind === "chatnode") {
    if (!chatNode) return null;
    return { mode: "workflow", chatNode, scopeChatFlow, frameLabels: labels };
  }
  // subworkflow at the top → render the sub-agent ChatFlow recursively
  // via ChatFlowCanvas. App.tsx doesn't need a new viewMode.
  return { mode: "sub-chatflow", chatFlow: scopeChatFlow, frameLabels: labels };
}

// Resolve the delegate WorkNode whose id matches parentWorkNodeId,
// walking the current drill stack (so subworkflow frames look in the
// cached sub-agent's first ChatNode workflow). Returns null if not
// found OR not a delegate kind.
function resolveDelegate(
  state: SessionState,
  parentWorkNodeId: string,
): DelegateNode | null {
  // Walk frames, tracking scope. We CAN'T use chatNodeId as a "is this
  // top-level?" signal because CC's Task delegation reuses parent
  // user uuids → top-level and sub-agent ChatNodes routinely share
  // ids. Use the walker's POSITION (whether we've crossed a
  // subworkflow frame) instead. Pre-cross = top-level (lazy, read
  // workflowCache); post-cross = sub-agent scope (full-fat, read
  // inline workflow.nodes from the cached sub ChatFlow).
  let scopeChatFlow: ChatFlow | null = state.chatFlow;
  let crossedSubWorkflow = false;
  let nodes: unknown[] = [];
  for (const frame of state.drillStack) {
    if (frame.kind === "chatnode") {
      if (!crossedSubWorkflow) {
        // Top-level: workflow.nodes is empty in lite mode → cache.
        const cached = state.workflowCache.get(frame.chatNodeId);
        if (cached?.status === "ready" && cached.workflow) {
          nodes = cached.workflow.nodes;
        } else {
          const cn = scopeChatFlow?.chatNodes.find(
            (c) => c.id === frame.chatNodeId,
          );
          nodes = cn?.workflow.nodes ?? [];
        }
      } else {
        // Sub-agent scope: chatFlow is full-fat from /subagents.
        const cn = scopeChatFlow?.chatNodes.find(
          (c) => c.id === frame.chatNodeId,
        );
        nodes = cn?.workflow.nodes ?? [];
      }
    } else {
      // subworkflow: descend into sub-agent's first ChatNode workflow.
      const delegate = nodes.find(
        (n) =>
          (n as { kind?: string }).kind === "delegate" &&
          (n as { id: string }).id === frame.parentWorkNodeId,
      ) as DelegateNode | undefined;
      if (!delegate?.agentId) return null;
      const cached = state.subAgentCache.get(delegate.agentId);
      if (cached?.status !== "ready" || !cached.chatFlow) return null;
      scopeChatFlow = cached.chatFlow;
      crossedSubWorkflow = true;
      // nodes gets re-set by the next chatnode frame from new scope.
      // For v0.5 we descend into the FIRST ChatNode of the sub-agent
      // (73% of sub-agents have only 1 ChatNode); multi-ChatNode is
      // v0.5.1 backlog. Pre-fill nodes here so that consecutive
      // subworkflow frames (without a chatnode between) still work.
      const firstCn = cached.chatFlow.chatNodes[0];
      nodes = firstCn?.workflow.nodes ?? [];
    }
  }
  const wn = nodes.find(
    (n) => (n as { id: string }).id === parentWorkNodeId,
  );
  if (!wn) {
    if (typeof console !== "undefined") {
      console.warn(
        "[loomscope] resolveDelegate: WorkNode not found",
        { parentWorkNodeId, scannedNodes: nodes.length },
      );
    }
    return null;
  }
  if ((wn as { kind?: string }).kind !== "delegate") return null;
  return wn as DelegateNode;
}

// Helper: write one cache entry without churning the rest of the
// SessionState shape. Always materialises a fresh outer Map so
// Zustand subscribers see a new reference.
function setSubAgentCacheEntry(
  get: () => LoomscopeStore,
  set: (
    partial:
      | Partial<LoomscopeStore>
      | ((s: LoomscopeStore) => Partial<LoomscopeStore>),
  ) => void,
  sessionId: string,
  agentId: string,
  entry: SubAgentCacheEntry,
) {
  const sessions = new Map(get().sessions);
  const cur = sessions.get(sessionId) ?? blankSessionState();
  const cache = new Map(cur.subAgentCache);
  cache.set(agentId, entry);
  sessions.set(sessionId, { ...cur, subAgentCache: cache });
  set({ sessions });
}
