// Store slice contracts. Splitting into 4 slices mirrors `design-architecture.md`
// "前端状态管理" so future v∞ work can drop SSE / hook handlers into
// `LiveEventSlice` without rippling across the rest of the store.

import type { ChatFlow } from "@/data/types";

// ─── UI slice ────────────────────────────────────────────────────────────────

export interface UISlice {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  pinnedWorkspaces: string[];
  hiddenWorkspaces: string[];
  focusedWorkspace: string | null;

  setSidebarWidth: (w: number) => void;
  toggleSidebar: () => void;
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

export interface SessionState {
  chatFlow: ChatFlow | null;
  foldedNodeIds: Set<string>;
  viewport: { x: number; y: number; zoom: number };
  selectedNodeId: string | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: number;
}

export interface SessionSlice {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  loadSession: (id: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  toggleFold: (sessionId: string, nodeId: string) => void;
  setSelected: (sessionId: string, nodeId: string | null) => void;
  setViewport: (sessionId: string, vp: { x: number; y: number; zoom: number }) => void;
}

// ─── Live event slice (stub for v∞.0) ────────────────────────────────────────

export interface LiveEventSlice {
  ssePending: Map<string, unknown>;
  subscribeSession: (sessionId: string) => void;
  unsubscribeSession: (sessionId: string) => void;
}

export type LoomscopeStore = UISlice & WorkspaceSlice & SessionSlice & LiveEventSlice;
