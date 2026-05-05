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
    isLoading: false,
    error: null,
    lastUpdated: 0,
  };
}

// localStorage helpers for compact-fold persistence. Key shape mirrors
// Agentloom's ``${app}:fold:${id}`` convention (see feedback memory
// `feedback_localstorage_ui_pattern.md`). Values are JSON arrays of
// folded compact-ChatNode ids; the in-memory ``Set`` is the source of
// truth at runtime — localStorage is purely for cross-reload restore.
//
// Reconciliation (drop ids that no longer exist as compact ChatNodes
// in the live chatFlow) is the responsibility of the caller — see
// ``hydrateFoldedCompactIds``. This separates "did the user fold X
// last session" from "is X still a thing now". Storage failures are
// swallowed: SSR / privacy mode / quota will surface as "default-fold
// behaviour" rather than crashing the app.
const FOLD_STORAGE_PREFIX = "loomscope:fold:";

function foldStorageKey(sessionId: string): string {
  return `${FOLD_STORAGE_PREFIX}${sessionId}`;
}

function readFoldStorage(sessionId: string): string[] | null {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(foldStorageKey(sessionId))
        : null;
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

function writeFoldStorage(sessionId: string, ids: Set<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      foldStorageKey(sessionId),
      JSON.stringify([...ids]),
    );
  } catch {
    // quota exceeded / privacy mode — silently fall through; the
    // in-memory set still works for the current page lifetime.
  }
}

// Compute the initial foldedCompactIds set for a freshly-loaded
// chatFlow. Hydrate from localStorage when present (intersected with
// the live compact ids, so deleted / renamed compacts get dropped);
// otherwise default-fold every compact ChatNode (pre-compact range
// hidden by default — the v0.x rework's primary UX choice, also a
// sizeable initial-render perf win for sessions with many compacts).
export function hydrateFoldedCompactIds(
  sessionId: string,
  chatFlow: ChatFlow,
): Set<string> {
  const liveCompactIds = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    if (cn.isCompactSummary) liveCompactIds.add(cn.id);
  }
  const stored = readFoldStorage(sessionId);
  if (stored) {
    const reconciled = new Set<string>();
    for (const id of stored) {
      if (liveCompactIds.has(id)) reconciled.add(id);
    }
    return reconciled;
  }
  return liveCompactIds;
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

  // v0.9 file-tail: live re-fetch on SSE `invalidate`. Differs from
  // loadSession in two ways:
  //   1. No isLoading flag flip — the user shouldn't see a full-screen
  //      "Parsing JSONL…" spinner just because the session ticked over;
  //      cards get briefly stale until the network round-trip lands,
  //      which is fine.
  //   2. Reconciliation rather than overwrite: keeps selectedNodeId,
  //      workflowSelectedNodeId, viewport, drillStack, branchMemory.
  //      foldedCompactIds is re-hydrated against the new chatFlow so
  //      newly-appeared compacts default-fold and disappeared ones drop
  //      out (same intersection logic as initial load).
  // The workflowCache is cleared because lite ChatFlow's per-cn summary
  // may have shifted (turn count, contextTokens, etc.) — we want lazy
  // hooks to refetch on next visibility. ChatNodes that weren't being
  // viewed pay nothing; visible cards briefly re-enter `pending` then
  // swap back to `ready` once the batch lands.
  refreshSession: async (id) => {
    try {
      const cf = await fetchJson<ChatFlow>(`/api/sessions/${id}`);
      const updated = new Map(get().sessions);
      const cur = updated.get(id) ?? blankSessionState();
      updated.set(id, {
        ...cur,
        chatFlow: cf,
        foldedCompactIds: hydrateFoldedCompactIds(id, cf),
        workflowCache: new Map<string, WorkflowCacheEntry>(),
        // subAgentCache stays — sub-agent ids are sidecar-rooted; if the
        // user has a sub-agent drill frame open, we'd rather they keep
        // seeing the cached content than flicker to a loading state on
        // an unrelated parent-jsonl tick. v0.9.1 will subscribe to
        // sidecar paths too and only invalidate the specific sub-agent.
        isLoading: false,
        error: null,
        lastUpdated: Date.now(),
      });
      set({ sessions: updated });
    } catch (err) {
      // Failure on a refresh is non-fatal — the previous chatFlow is
      // still valid; we just log and let the next SSE invalidate try
      // again. Don't surface as session-level error (that's reserved
      // for initial-load failures).
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

  // ── v0.10 lazy ChatFlow B2 + B5 polish: per-ChatNode workflow lazy load ──
  loadChatNodeWorkflows: async (sessionId, chatNodeIds) => {
    if (chatNodeIds.length === 0) return;
    const sess0 = get().sessions.get(sessionId);
    if (!sess0) return;

    // Filter to ids that are NOT already ready or pending. ``error``
    // entries get retried — caller decides retry policy.
    const cache = sess0.workflowCache;
    const toFetch: string[] = [];
    for (const id of chatNodeIds) {
      const e = cache.get(id);
      if (!e) {
        toFetch.push(id);
        continue;
      }
      if (e.status === "ready") continue;
      if (e.status === "pending") continue;
      toFetch.push(id); // error → retry
    }
    if (toFetch.length === 0) return;

    // Mark to-fetch ids as `pending` synchronously so other callers
    // in the same tick (typically: 50 child useEffects firing before
    // the parent's batch effect) see them and skip re-adding to the
    // toFetch list. This is the visible signal `useChatNodeWorkflow`
    // reads.
    {
      const sessions = new Map(get().sessions);
      const cur = sessions.get(sessionId);
      if (!cur) return;
      const next = new Map(cur.workflowCache);
      for (const id of toFetch) {
        next.set(id, { status: "pending", workflow: null, error: null });
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
          for (const id of allIds) {
            const wf = map[id];
            if (wf) {
              const existing = cnIndex.get(id);
              const summary =
                existing?.workflow.summary ?? wf.summary ?? undefined;
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
          sessions.set(sessionId, { ...cur, workflowCache: next });
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
    if (!cur || !cur.chatFlow) return;
    if (cur.drillStack.length === 0) return; // need an existing chatnode frame

    // Idempotent: if the top frame already targets this WorkNode,
    // skip the re-push. Avoids a stray double-double-click stacking
    // two identical frames.
    const top = cur.drillStack[cur.drillStack.length - 1];
    if (top.kind === "subworkflow" && top.parentWorkNodeId === parentWorkNodeId) return;

    // Validate: the parentWorkNodeId must resolve to a delegate
    // WorkNode in the currently visible WorkFlow. Walk the current
    // drill stack to find it; if validation fails, drop the push
    // silently — same defensive policy as Agentloom's enterSubWorkflow.
    const delegate = resolveDelegate(cur, parentWorkNodeId);
    if (!delegate) return;
    const agentId = delegate.agentId;
    if (!agentId) return; // a delegate without agentId can't be drilled

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
  foldCompact: (sessionId, compactChatNodeId) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) return;
    if (!isCompactChatNodeInFlow(cur.chatFlow, compactChatNodeId)) return;
    const next = new Set(cur.foldedCompactIds);
    next.add(compactChatNodeId);
    const updated = new Map(sessions);
    updated.set(sessionId, { ...cur, foldedCompactIds: next });
    set({ sessions: updated });
    writeFoldStorage(sessionId, next);
  },
  unfoldCompact: (sessionId, compactChatNodeId) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) return;
    if (!isCompactChatNodeInFlow(cur.chatFlow, compactChatNodeId)) return;
    const next = new Set(cur.foldedCompactIds);
    next.delete(compactChatNodeId);
    const updated = new Map(sessions);
    updated.set(sessionId, { ...cur, foldedCompactIds: next });
    set({ sessions: updated });
    writeFoldStorage(sessionId, next);
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
    writeFoldStorage(sessionId, next);
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

export function resolveDrillView(state: SessionState): ResolvedDrillView | null {
  if (!state.chatFlow || state.drillStack.length === 0) return null;
  let scopeChatFlow: ChatFlow = state.chatFlow;
  let chatNode: import("@/data/types").ChatNode | null = null;
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
    const delegate = chatNode.workflow.nodes.find(
      (n) => n.id === frame.parentWorkNodeId && n.kind === "delegate",
    ) as DelegateNode | undefined;
    if (!delegate?.agentId) return null;
    const cached = state.subAgentCache.get(delegate.agentId);
    if (cached?.status !== "ready" || !cached.chatFlow) return null;
    scopeChatFlow = cached.chatFlow;
    chatNode = null;
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
  // Walk frames in order, narrowing the resolved (chatNode, nodes)
  // pair each step. v0.10 lazy ChatFlow: top-level `chatFlow.chatNodes
  // [i].workflow.nodes` is EMPTY in lite mode (the per-cn workflow
  // lives in `workflowCache` instead). We MUST read from workflowCache
  // first; falling back to the inline list keeps test fixtures and
  // any pre-lazy paths working. Sub-agent ChatFlows (loaded via
  // /subagents) come back full-fat so their inline nodes are
  // authoritative — no cache lookup needed for subworkflow frames.
  let nodes: unknown[] = [];
  for (const frame of state.drillStack) {
    if (frame.kind === "chatnode") {
      const cached = state.workflowCache.get(frame.chatNodeId);
      if (cached?.status === "ready" && cached.workflow) {
        nodes = cached.workflow.nodes;
      } else {
        const cn = state.chatFlow?.chatNodes.find(
          (c) => c.id === frame.chatNodeId,
        );
        nodes = cn?.workflow.nodes ?? [];
      }
    } else {
      // subworkflow: the previous frame's nodes must contain a
      // delegate with matching id; descend into its sub-agent's first
      // ChatNode's workflow.nodes (full-fat, from /subagents).
      const delegate = nodes.find(
        (n) =>
          (n as { kind?: string }).kind === "delegate" &&
          (n as { id: string }).id === frame.parentWorkNodeId,
      ) as DelegateNode | undefined;
      if (!delegate?.agentId) return null;
      const cached = state.subAgentCache.get(delegate.agentId);
      if (cached?.status !== "ready" || !cached.chatFlow) return null;
      // For v0.5 we descend into the FIRST ChatNode of the sub-agent
      // (see handoff: 73% of sub-agents have only 1 ChatNode). Multi-
      // ChatNode rendering is v0.5.1 backlog.
      const firstCn = cached.chatFlow.chatNodes[0];
      nodes = firstCn?.workflow.nodes ?? [];
    }
  }
  const wn = nodes.find(
    (n) => (n as { id: string }).id === parentWorkNodeId,
  );
  if (!wn) {
    // Loud-bail in dev so a future "click does nothing" tells us where
    // it actually died instead of silently returning. Production noise
    // is acceptable — fires only when the WorkNode tree is unexpectedly
    // empty (typically: lazy fetch hadn't landed when the user clicked).
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
