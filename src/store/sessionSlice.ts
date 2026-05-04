import type { StateCreator } from "zustand";

import type { ChatFlow, ChatNode, DelegateNode } from "@/data/types";
import type { AgentMetadata } from "@/parse/sidecar";
import type {
  DrillFrame,
  LoomscopeStore,
  SessionSlice,
  SessionState,
  SubAgentCacheEntry,
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
  // Walk frames in order, narrowing the resolved chatNode each step.
  let chatNode: { workflow: { nodes: DelegateNode[] | unknown[] } } | null = null;
  for (const frame of state.drillStack) {
    if (frame.kind === "chatnode") {
      chatNode =
        state.chatFlow?.chatNodes.find((c) => c.id === frame.chatNodeId) ?? null;
    } else {
      // subworkflow: previous chatNode must contain a delegate w/
      // matching id whose agentId names a cached sub ChatFlow.
      if (!chatNode) return null;
      const delegate = chatNode.workflow.nodes.find(
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
      chatNode = cached.chatFlow.chatNodes[0] ?? null;
    }
  }
  if (!chatNode) return null;
  const wn = chatNode.workflow.nodes.find(
    (n) => (n as { id: string }).id === parentWorkNodeId,
  );
  if (!wn) return null;
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
