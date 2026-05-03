// Store slice contracts. Splitting into 4 slices mirrors `design-architecture.md`
// "前端状态管理" so future v∞ work can drop SSE / hook handlers into
// `LiveEventSlice` without rippling across the rest of the store.

import type { ChatFlow } from "@/data/types";
import type { AgentMetadata } from "@/parse/sidecar";

// ─── UI slice ────────────────────────────────────────────────────────────────

export interface UISlice {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  // v0.4 drill panel width (right-side resizable). 0 = collapsed.
  drillPanelWidth: number;
  drillPanelCollapsed: boolean;
  pinnedWorkspaces: string[];
  hiddenWorkspaces: string[];
  focusedWorkspace: string | null;

  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
  setDrillPanelWidth: (w: number) => void;
  toggleDrillPanel: () => void;
  pinWorkspace: (cwd: string) => void;
  unpinWorkspace: (cwd: string) => void;
  hideWorkspace: (cwd: string) => void;
  unhideWorkspace: (cwd: string) => void;
  setFocusedWorkspace: (cwd: string | null) => void;
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
// v0.7 adds ``compact-original`` frames for drilling into the
// pre-compact original turn sequence behind a compact ChatNode.
// Keeping the union open now means future drill kinds slot in without
// retrofitting all consumers.
export type DrillFrame =
  | { kind: "chatnode"; chatNodeId: string }
  | { kind: "subworkflow"; parentWorkNodeId: string }
  | { kind: "compact-original"; compactChatNodeId: string };

// Cached sub-agent ChatFlow plus its AgentMetadata. Stored per
// ``(sessionId, agentId)`` and dropped on session unload — sub-agents
// from a different session would have stale parentChatNodeId / uuid
// references anyway, so cross-session sharing isn't valuable.
export interface SubAgentCacheEntry {
  status: "loading" | "ready" | "error";
  chatFlow: ChatFlow | null;
  meta: AgentMetadata | null;
  error: string | null;
  // Last access timestamp (ms). Reserved for future LRU eviction —
  // current implementation keeps everything until session switch.
  lastAccess: number;
}

export interface SessionState {
  chatFlow: ChatFlow | null;
  // ChatFlow-layer fold state. v0.5 used this for the drill-down
  // ChatFlow→WorkFlow toggle (membership keyed on ChatNode id).
  foldedNodeIds: Set<string>;
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
  // ``agentId → entry`` cache for sub-agent ChatFlows loaded via the
  // ``/api/sessions/:id/subagents/:agentId`` endpoint. v0.5 keeps
  // everything in memory; eviction policy (LRU / max-size) is v0.10
  // backlog.
  subAgentCache: Map<string, SubAgentCacheEntry>;
  isLoading: boolean;
  error: string | null;
  lastUpdated: number;
}

export interface SessionSlice {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  loadSession: (id: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  setSelected: (sessionId: string, nodeId: string | null) => void;
  setViewport: (sessionId: string, vp: { x: number; y: number; zoom: number }) => void;
  // ── Drill-down navigation (v0.3 inner WorkFlow) ──
  enterWorkflow: (sessionId: string, chatNodeId: string) => void;
  exitWorkflow: (sessionId: string) => void;
  truncateDrillStack: (sessionId: string, depth: number) => void;
  setWorkflowSelected: (sessionId: string, nodeId: string | null) => void;
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
  // ── v0.7 compact-original drill ──
  // Push a ``compact-original`` drill frame for the given compact
  // ChatNode. The current top frame must be ``chatnode`` (i.e. the
  // user is currently viewing this compact ChatNode's workflow) OR
  // empty (drill straight from ChatFlow canvas). The compact ChatNode
  // must have a resolvable ``compactMetadata.logicalParentChatNodeId``
  // so the resolver can compute the pre-compact range. Idempotent on
  // the same compactChatNodeId at the top.
  enterCompactOriginal: (sessionId: string, compactChatNodeId: string) => void;
  // Legacy v0.5 fold toggle — keyed on a ChatNode id, manipulates
  // ``foldedNodeIds`` membership. Used by the drill-down chat-flow
  // fold UX (currently dormant in production but kept for future
  // ChatFlow-layer fold features). v0.6 redo deliberately does NOT
  // introduce a unified expand/collapse model — that was the v0.6
  // first-attempt mistake. See `handoff-v0.6-redo-node-base-interop.md`
  // hard constraint #4.
  toggleFold: (sessionId: string, nodeId: string) => void;
}

// ─── Live event slice (stub for v∞.0) ────────────────────────────────────────

export interface LiveEventSlice {
  ssePending: Map<string, unknown>;
  subscribeSession: (sessionId: string) => void;
  unsubscribeSession: (sessionId: string) => void;
}

export type LoomscopeStore = UISlice & WorkspaceSlice & SessionSlice & LiveEventSlice;
