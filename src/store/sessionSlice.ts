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

  // v0.7 M3: drill into the pre-compact original turn sequence behind
  // a compact ChatNode. Push policy:
  //   top is subworkflow            → PUSH (drilling from inside a sub
  //                                    ChatFlow into one of its compacts)
  //   anything else (empty / chatnode / compact-original) → REPLACE
  //                                    with single compact-original frame
  //                                    (treats inner-workflow view and
  //                                    pre-compact view as alternative
  //                                    views of the same compact ChatNode,
  //                                    not nested layers)
  // Idempotent on the same compactChatNodeId at the top.
  enterCompactOriginal: (sessionId, compactChatNodeId) => {
    const sessions = get().sessions;
    const cur = sessions.get(sessionId);
    if (!cur || !cur.chatFlow) return;
    const top = cur.drillStack[cur.drillStack.length - 1];
    if (
      top?.kind === "compact-original" &&
      top.compactChatNodeId === compactChatNodeId
    ) {
      return;
    }
    // Validate: the compact ChatNode must live in the currently
    // visible scope (top-level if stack is empty / chatnode-only;
    // sub-agent ChatFlow if a subworkflow frame is in play).
    const view = resolveDrillView(cur);
    const scope: ChatFlow =
      view?.mode === "sub-chatflow"
        ? view.chatFlow
        : view?.mode === "workflow"
          ? view.scopeChatFlow
          : cur.chatFlow;
    const compactCn = scope.chatNodes.find((c) => c.id === compactChatNodeId);
    if (!compactCn?.isCompactSummary) return;
    if (!compactCn.compactMetadata?.logicalParentChatNodeId) return;

    const drillStack: DrillFrame[] =
      top?.kind === "subworkflow"
        ? [...cur.drillStack, { kind: "compact-original", compactChatNodeId }]
        : [{ kind: "compact-original", compactChatNodeId }];
    const updated = new Map(sessions);
    updated.set(sessionId, {
      ...cur,
      drillStack,
      workflowSelectedNodeId: null,
    });
    set({ sessions: updated });
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
  kind: "chatnode" | "subworkflow" | "compact-original";
  // True when this frame represents an auto-compact sub-agent
  // (agentId starts with ``acompact-``).
  isAutoCompact: boolean;
}

// v0.7 M3: compute the pre-compact original turn range for a compact
// ChatNode, walking parentChatNodeId from
// ``compactMetadata.logicalParentChatNodeId`` (= the tail ChatNode of
// the段 that was compacted) backward until we hit either:
//   - the session root (parentChatNodeId === null)
//   - a previous compact ChatNode (those represent earlier compactions
//     and are NOT part of this compact's pre-compact range — they're
//     already a fold marker themselves)
// Returns [] when the anchor isn't a compact ChatNode, the
// logicalParentChatNodeId is missing, or the chain is empty/dangling.
// Order: time-ascending (root-most first, tail last) so ChatFlowCanvas
// renders the段 in its natural reading order.
export function computePreCompactRange(
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
    if (next.isCompactSummary) break; // earlier compact; stop here
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
    if (frame.kind === "compact-original") {
      // The compact ChatNode anchor must live in the current scope.
      // We advance the scope to a synthetic ChatFlow holding only the
      // pre-compact range; downstream chatnode frames (rare but
      // possible) would then resolve against that synthetic scope.
      const anchor = scopeChatFlow.chatNodes.find(
        (c) => c.id === frame.compactChatNodeId,
      );
      if (!anchor?.isCompactSummary) return null;
      const range = computePreCompactRange(scopeChatFlow, frame.compactChatNodeId);
      if (range.length === 0) return null;
      // Synthetic ChatFlow: head ChatNode's parentChatNodeId rewritten
      // to null so layoutDag doesn't render a dangling edge to a
      // compacted-out ancestor that isn't in the synthetic node set.
      const head = range[0];
      scopeChatFlow = {
        ...scopeChatFlow,
        chatNodes: [{ ...head, parentChatNodeId: null }, ...range.slice(1)],
        orphans: [],
        flowEvents: [],
      };
      chatNode = null;
      labels.push({
        depth,
        kind: "compact-original",
        label: `⊞ pre-compact (${anchor.id.slice(0, 8)})`,
        title: `pre-compact original sequence behind compact ChatNode ${anchor.id}`,
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
  // subworkflow OR compact-original at the top → render the (possibly
  // synthetic) scopeChatFlow recursively via ChatFlowCanvas. App.tsx
  // doesn't need a new viewMode.
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
    } else if (frame.kind === "subworkflow") {
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
    } else {
      // compact-original frames don't expose any delegate WorkNodes
      // visible to enterSubWorkflow's lookup — bail. (In practice
      // enterSubWorkflow is never called from a compact-original view
      // because that view contains no delegate WorkNodes; this branch
      // exists to satisfy the discriminated-union exhaustiveness check.)
      return null;
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
