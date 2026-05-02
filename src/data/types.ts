// Core data model for Loomscope.
//
// Maps Claude Code session JSONL (+ sidecar files) to a two-layer DAG:
//   ChatFlow → ChatNode[] → WorkFlow → WorkNode[]
//
// Spec: docs/design-data-model.md
// EdgeKind v0 renders the first 3; the remaining 5 are schema-only stubs.

export type EdgeKind =
  | "continuation" // v0
  | "spawn" // v0
  | "logical" // v0 (compact_boundary.logicalParentUuid → pre-compact tail)
  | "aggregation" // v0.5+ (brief / pack / sub-agent toolStats)
  | "retry" // v0.1 — pending retry-chain investigation
  | "reference" // v∞
  | "external_trigger" // v∞ (hook / external daemon)
  | "interruption"; // pending interruption-event investigation

export type WorkNodeKind =
  | "llm_call"
  | "tool_call"
  | "delegate"
  | "compact"
  | "attachment";

export type ChatNodeTrigger = "user" | "scheduled";
export type ChatFlowTrigger = "user" | "cron-fired";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

// ─── WorkFlow layer ──────────────────────────────────────────────────────────

export interface ThinkingBlock {
  text: string;
  signature?: string;
}

export interface LlmCallNode {
  id: string; // assistant record uuid
  kind: "llm_call";
  parentUuid: string | null;
  requestId?: string;
  model?: string;
  text: string; // joined text blocks (often "")
  thinking: ThinkingBlock[];
  stopReason?: string;
  usage?: Record<string, unknown>;
  timestamp?: string;
  errors?: WorkNodeError[];
}

export interface ToolCallNode {
  id: string; // tool_use block id (toolu_…)
  kind: "tool_call";
  parentUuid: string | null; // assistant record uuid that owned the block
  toolName: string;
  input: unknown;
  resultUserUuid?: string; // user record carrying the matching tool_result
  resultBlock?: unknown; // raw `tool_result` block
  toolUseResult?: unknown; // raw record-level toolUseResult
  isError?: boolean;
  durationMs?: number;
  timestamp?: string;
}

export interface DelegateNode {
  id: string; // tool_use block id
  kind: "delegate";
  parentUuid: string | null;
  toolName: "Agent" | "Task" | string;
  agentType?: string; // from tool_result toolUseResult.agentType
  agentId?: string; // join key to sidecar `subagents/agent-<agentId>.jsonl`
  description?: string;
  prompt?: string;
  resultUserUuid?: string;
  status?: "completed" | "failed" | string;
  content?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: Record<string, unknown>;
  toolStats?: Record<string, unknown>;
  toolUseResult?: unknown;
  isError?: boolean;
  timestamp?: string;
}

export interface CompactNode {
  id: string; // user record uuid (the one with isCompactSummary=true)
  kind: "compact";
  parentUuid: string | null;
  boundaryUuid?: string; // matching system/compact_boundary uuid
  logicalParentUuid?: string; // pre-compact tail
  trigger?: "auto" | "manual" | string;
  preTokens?: number;
  preCompactDiscoveredTools?: unknown;
  summaryText: string; // raw summary content
  timestamp?: string;
}

export interface AttachmentNode {
  id: string; // attachment record uuid
  kind: "attachment";
  parentUuid: string | null;
  attachmentType: string;
  raw: unknown;
  timestamp?: string;
}

export type WorkNode =
  | LlmCallNode
  | ToolCallNode
  | DelegateNode
  | CompactNode
  | AttachmentNode;

export interface WorkNodeError {
  type: string;
  message?: string;
}

export interface WorkFlow {
  nodes: WorkNode[];
  edges: Edge[];
}

// ─── ChatNode layer ──────────────────────────────────────────────────────────

export interface ChatNodeUserMessage {
  uuid: string;
  content: unknown; // string or block[] — preserved as-is
  timestamp?: string;
  attachments: AttachmentNode[];
}

export interface ChatNodeMeta {
  awaySummary?: { uuid: string; content: string; timestamp?: string };
  scheduledFireUuid?: string; // system/scheduled_task_fire uuid linked to this ChatNode
  fileHistorySnapshotUuids?: string[];
  permissionModeChanges?: Array<{ uuid: string; permissionMode: string }>;
  errors?: WorkNodeError[];
}

export interface ChatNode {
  id: string; // = promptId
  parentChatNodeId: string | null;
  rootUserUuid: string;
  userMessage: ChatNodeUserMessage;
  workflow: WorkFlow;
  trigger: ChatNodeTrigger;
  triggerSource?: { workNodeId: string };
  isCompactSummary: boolean;
  compactMetadata?: CompactNode;
  meta: ChatNodeMeta;
}

// ─── ChatFlow layer ──────────────────────────────────────────────────────────

export interface ChatFlow {
  id: string; // = sessionId
  mainJsonlPath: string;
  sidecarDir: string;
  cwd?: string;
  gitBranch?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  trigger: ChatFlowTrigger;
  triggerSource?: {
    sessionId: string;
    jsonlPath: string;
    sourceWorkNodeId: string;
  };
  chatNodes: ChatNode[];
  // Records that couldn't be placed into any ChatNode (no promptId, not a known
  // ChatFlow-level event). Kept for debugging / future passes.
  orphans: OrphanRecord[];
  // Top-level events not bound to a single ChatNode. ScheduleWakeup fires,
  // standalone permission-mode flips, etc.
  flowEvents: FlowEvent[];
}

export interface OrphanRecord {
  uuid?: string;
  type: string;
  reason: string;
}

export interface FlowEvent {
  type: "scheduled_task_fire" | "permission_mode" | "local_command" | string;
  uuid?: string;
  timestamp?: string;
  data?: unknown;
}
