import type { StateCreator } from "zustand";

import type { ChatFlow, DelegateNode } from "@/data/types";
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

  // ── Drill-down navigation (v0.3) ────────────────────────────────────
  // Push a ChatNode frame and reset workflow-layer selection so the
  // drill view opens "fresh". Idempotent on the same chatNodeId.
  enterWorkflow: (sessionId, chatNodeId) => {
    const updated = new Map(get().sessions);
    const cur = updated.get(sessionId) ?? blankSessionState();
    const top = cur.drillStack[0];
    if (top && top.kind === "chatnode" && top.chatNodeId === chatNodeId) return;
    updated.set(sessionId, {
      ...cur,
      drillStack: [{ kind: "chatnode", chatNodeId }],
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
});

/**
 * Resolve the ChatNode whose WorkFlow should currently render in the
 * main canvas, walking ``drillStack`` against the live ``chatFlow``
 * and ``subAgentCache``. Returns null when the stack is empty (=
 * ChatFlow view) or when a frame can't be resolved (cache miss /
 * stale id) — the canvas should treat null as "fall back to ChatFlow
 * view + suppress breadcrumb depth".
 *
 * v0.5 picks ``chatNodes[0]`` for sub-agent ChatFlows; multi-ChatNode
 * sub-agents (27% of real data, mostly auto-compact) get a banner
 * notice from the canvas — full multi-ChatNode rendering is v0.5.1.
 */
export interface ResolvedDrillTarget {
  // The ChatNode whose .workflow renders in the canvas.
  chatNode: import("@/data/types").ChatNode;
  // Per-frame label data so the breadcrumb can render
  // ``ChatFlow / WorkFlow (CN abc) / 🤖 Agent (Explore) / …``.
  frameLabels: DrillBreadcrumbItem[];
  // True when the resolved sub-agent's ChatFlow has > 1 ChatNode and
  // we're showing only the first. Canvas surfaces this as a banner.
  multiChatNodeNotice: { totalChatNodes: number } | null;
}

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

export function resolveDrilledChatNode(
  state: SessionState,
): ResolvedDrillTarget | null {
  if (!state.chatFlow || state.drillStack.length === 0) return null;
  let chatNode: import("@/data/types").ChatNode | null = null;
  let multiChatNodeNotice: { totalChatNodes: number } | null = null;
  const labels: DrillBreadcrumbItem[] = [];
  for (let depth = 0; depth < state.drillStack.length; depth += 1) {
    const frame = state.drillStack[depth];
    if (frame.kind === "chatnode") {
      const cn = state.chatFlow.chatNodes.find((c) => c.id === frame.chatNodeId);
      if (!cn) return null;
      chatNode = cn;
      labels.push({
        depth,
        kind: "chatnode",
        label: `WorkFlow (${cn.id.slice(0, 8)})`,
        title: `ChatNode ${cn.id}`,
        isAutoCompact: false,
      });
      continue;
    }
    // subworkflow: previous chatNode owns the delegate WorkNode
    // whose agentId names the sub-agent ChatFlow.
    if (!chatNode) return null;
    const delegate = chatNode.workflow.nodes.find(
      (n) => n.id === frame.parentWorkNodeId && n.kind === "delegate",
    ) as DelegateNode | undefined;
    if (!delegate?.agentId) return null;
    const cached = state.subAgentCache.get(delegate.agentId);
    if (cached?.status !== "ready" || !cached.chatFlow) return null;
    const subFirstChatNode = cached.chatFlow.chatNodes[0];
    if (!subFirstChatNode) return null;
    chatNode = subFirstChatNode;
    if (cached.chatFlow.chatNodes.length > 1) {
      multiChatNodeNotice = { totalChatNodes: cached.chatFlow.chatNodes.length };
    }
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
  if (!chatNode) return null;
  return { chatNode, frameLabels: labels, multiChatNodeNotice };
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
