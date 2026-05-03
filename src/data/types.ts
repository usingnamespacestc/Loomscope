// Core data model for Loomscope.
//
// Two-layer DAG (preserved from v0.1-v0.5; v0.6 redo unifies on a
// shared ``NodeBase`` interface but does NOT collapse the visual
// layers — see `handoff-v0.6-redo-node-base-interop.md` for why):
//   ChatFlow → ChatNode[] → WorkFlow → WorkNode[]
//
// **v0.6 redo**: ChatNode and the 5 WorkNode kinds all ``extends
// NodeBase`` so shared chrome (TokenBar, NodeIdLine, kind-aware
// selectors) can read common fields (id / kind / model / usage / etc.)
// without per-shape branching. The visual ChatFlow/WorkFlow split
// stays — App.tsx still flips viewMode; ChatFlowCanvas + WorkFlowCanvas
// stay separate; drill-stack model stays. `NodeBase` is data-layer
// only.
//
// First-attempt v0.6 (`handoff-v0.6-data-model-unification.md`,
// SUPERSEDED) tried to flatten the visual layers into a single Canvas
// and was reverted (commit `f9f6f03`). Don't repeat that.
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

// Every Node kind that a card can render — both ChatFlow-layer and
// WorkFlow-layer combined. Used by shared chrome utilities so they
// don't have to duplicate the WorkNodeKind union with a ``"chat"``
// alternative.
export type AnyNodeKind = "chat" | WorkNodeKind;

export type ChatNodeTrigger = "user" | "scheduled";
export type ChatFlowTrigger = "user" | "cron-fired";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

// ─── Shared block / value types ─────────────────────────────────────

export interface ThinkingBlock {
  text: string;
  signature?: string;
}

// Canonical shape of `usage` on assistant records + sub-agent
// totals. CC's jsonl actually stores a Record<string, unknown>; this
// alias gives the shared chrome (TokenBar) one place to look up the
// commonly-used numeric fields. Unknown extra keys pass through.
export interface UsageRecord {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

// ─── NodeBase (v0.6 redo shared interface) ──────────────────────────
//
// Fields on every node, regardless of which layer (ChatFlow / WorkFlow)
// it belongs to. Pulled out so chrome atoms — TokenBar, NodeIdLine,
// selection-aware borders — can read them without per-kind branching.
//
// Naming: ``id`` is the canonical Node identifier (= promptId for
// ChatNode, = tool_use block id / record uuid for WorkNode). ``kind``
// is the discriminator. ``parentUuid`` is the raw record-level
// ancestry pointer (legacy field; ChatNode renamed it
// ``parentChatNodeId`` for clarity but the **id-space** is different
// — keep parentUuid only on WorkNode subtypes; ChatNode has its own
// ``parentChatNodeId``).
//
// What's NOT on NodeBase (and why):
//   - parentUuid / parentChatNodeId — different id spaces between layers;
//     fields stay on the concrete subtypes
//   - WorkFlow / inner sub-graph — only meaningful for ChatNode
//   - kind-specific payloads (toolName, summaryText, etc.) — concrete
//     subtypes carry them
export interface NodeBase {
  id: string;
  kind: AnyNodeKind;
  // Wall-clock timestamp from the underlying record; missing for some
  // synthetic nodes (e.g. compact summary derived from boundary).
  timestamp?: string;
  // Surfaced model identifier when the node represents a model call
  // (assistant_call) or aggregates one (delegate's last sub-LLM,
  // ChatNode's terminal assistant). Drives TokenBar's max-context
  // lookup for those kinds; undefined for kinds with no model
  // attribution (tool_call / attachment).
  model?: string;
  // Token usage at the granularity the kind cares about. ``llm_call``
  // = the assistant record's own usage; ``delegate`` = sub-agent
  // aggregated usage; ``compact`` synthesises from preTokens. Optional
  // because ChatNode-layer reads it through ``aggregate`` instead.
  usage?: UsageRecord;
  // Errors observed on the underlying record (api_error subtypes etc.).
  errors?: NodeError[];
}

export interface NodeError {
  type: string;
  message?: string;
}

// Backward-compat alias — v0.5 callers used ``WorkNodeError`` for the
// same shape. Keep the name available so legacy imports don't break.
export type WorkNodeError = NodeError;

// ─── WorkFlow layer (each kind extends NodeBase) ────────────────────

export interface LlmCallNode extends NodeBase {
  kind: "llm_call";
  parentUuid: string | null;
  requestId?: string;
  text: string; // joined text blocks (often "")
  thinking: ThinkingBlock[];
  stopReason?: string;
}

export interface ToolCallNode extends NodeBase {
  kind: "tool_call";
  parentUuid: string | null; // assistant record uuid that owned the block
  toolName: string;
  input: unknown;
  resultUserUuid?: string; // user record carrying the matching tool_result
  resultBlock?: unknown; // raw `tool_result` block
  toolUseResult?: unknown; // raw record-level toolUseResult
  isError?: boolean;
  durationMs?: number;
}

export interface DelegateNode extends NodeBase {
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
  // Aggregated tool usage stats from toolStats (sub-agent's tool-call
  // breakdown).
  toolStats?: Record<string, unknown>;
  toolUseResult?: unknown;
  isError?: boolean;
}

export interface CompactNode extends NodeBase {
  kind: "compact";
  parentUuid: string | null;
  boundaryUuid?: string; // matching system/compact_boundary uuid
  logicalParentUuid?: string; // pre-compact tail (raw record uuid)
  // v0.7 M3: ChatNode id (= promptId) of the ChatNode that contains
  // logicalParentUuid's record. Pre-resolved at parse time so the
  // compact-original drill resolver can walk parentChatNodeId from
  // here without re-walking parentUuid chains. null when the lookup
  // fails (rare; logicalParentUuid points at a record we couldn't
  // bucket, or the field is missing from the boundary).
  logicalParentChatNodeId?: string | null;
  trigger?: "auto" | "manual" | string;
  preTokens?: number;
  preCompactDiscoveredTools?: unknown;
  summaryText: string; // raw summary content
}

export interface AttachmentNode extends NodeBase {
  kind: "attachment";
  parentUuid: string | null;
  attachmentType: string;
  raw: unknown;
}

export type WorkNode =
  | LlmCallNode
  | ToolCallNode
  | DelegateNode
  | CompactNode
  | AttachmentNode;

export interface WorkFlow {
  nodes: WorkNode[];
  edges: Edge[];
}

// ─── ChatNode layer ──────────────────────────────────────────────────

export interface ChatNodeUserMessage {
  uuid: string;
  content: unknown; // string or block[] — preserved as-is
  timestamp?: string;
  attachments: AttachmentNode[];
}

// file-history-snapshot record (CC writes one per turn). v0.1 doc said
// these were unbinding orphans (parentUuid:null + no promptId), but
// v0.7 实测 found `snapshot.messageId` directly references a
// user/assistant record uuid — so binding goes through messageId →
// indexByUuid → resolvePromptId, not through timestamp window heuristics.
// trackedFiles is the Object.keys of `snapshot.trackedFileBackups`
// (CC's git-status snapshot of file paths the turn touched).
export interface FileHistorySnapshot {
  uuid: string;
  timestamp?: string;
  trackedFiles: string[];
  // True when this snapshot is an *update* of a prior snapshot rather
  // than the first one for the turn. Renderer can de-emphasise these
  // because they don't represent new file changes per se.
  isUpdate: boolean;
}

export interface ChatNodeMeta {
  awaySummary?: { uuid: string; content: string; timestamp?: string };
  scheduledFireUuid?: string; // system/scheduled_task_fire uuid linked to this ChatNode
  // v0.7: snapshots resolved to this ChatNode via messageId direct
  // lookup (see parse/jsonl.ts file-history-snapshot binding).
  fileHistorySnapshots?: FileHistorySnapshot[];
  permissionModeChanges?: Array<{ uuid: string; permissionMode: string }>;
  errors?: NodeError[];
}

// CC slash-command invocation (e.g. /model, /compact, /cost) does NOT go
// through the LLM — CC handles it locally. Buckets as a single ChatNode
// with no assistant turn and three user records sharing one promptId:
//   #1 isMeta=true: <local-command-caveat>System note</local-command-caveat>
//   #2: <command-name>/NAME</command-name><command-args>ARGS</command-args>...
//   #3: <local-command-stdout>OUTPUT</local-command-stdout>
// Parser extracts the structured form into this field.
export interface SlashCommandInfo {
  name: string; // e.g. "/model" (with leading slash)
  args?: string; // contents of <command-args>; "" or undefined when none
  stdout?: string; // contents of <local-command-stdout>; ANSI escapes stripped
}

export interface ChatNode extends NodeBase {
  // ``kind: "chat"`` discriminates ChatNode from WorkNode in code that
  // works against ``NodeBase``. Cards / chrome that need to switch
  // behaviour by layer use this; cards specific to ChatFlow vs
  // WorkFlow can still narrow by interface name as before.
  kind: "chat";
  // = promptId (the cluster key for v0.1 bucketing).
  id: string;
  parentChatNodeId: string | null;
  rootUserUuid: string;
  userMessage: ChatNodeUserMessage;
  workflow: WorkFlow;
  trigger: ChatNodeTrigger;
  triggerSource?: { workNodeId: string };
  isCompactSummary: boolean;
  compactMetadata?: CompactNode;
  /** When set: this ChatNode is a slash-command invocation, not a real
   * conversation turn. Render specially. */
  slashCommand?: SlashCommandInfo;
  meta: ChatNodeMeta;
}

// ─── ChatFlow layer ──────────────────────────────────────────────────

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
