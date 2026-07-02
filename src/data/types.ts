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
  // ChatNode id (= promptId) of the ChatNode that contains
  // logicalParentUuid's record. Pre-resolved at parse time so the
  // fold projection (computeCompactRange / computeFoldProjection) can
  // walk parentChatNodeId from here without re-walking parentUuid
  // chains. null when the lookup fails (rare; logicalParentUuid
  // points at a record we couldn't bucket, or the field is missing
  // from the boundary).
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
  // v0.10 polish (lazy ChatFlow): canvas card / fold projection / etc.
  // need only summary stats — they don't read individual WorkNodes —
  // so the server pre-computes this and the lite ChatFlow endpoint
  // ships it inline. ``nodes`` / ``edges`` will become optional in B3
  // when client lazy-loading lands; for B1/B2 they stay required and
  // populated by the parser as before. ``summary`` starts optional so
  // existing test fixtures (~20 sites) don't all need updating in
  // one shot — server populates it, clients fall back to a derived
  // default when absent.
  summary?: WorkflowSummary;
  nodes: WorkNode[];
  edges: Edge[];
}

// Summary stats derived once on the server. Carries everything the
// canvas card reads (so the bulky workflow.nodes can stay on the
// server). Pre-computing also means the card never has to loop
// through WorkNodes — a tiny perf win that compounds over 1500-card
// sessions.
export interface WorkflowSummary {
  // Last-llm_call's text (truncated for the card preview).
  assistantPreview: string;
  // EN (v0.9.2): full text from EVERY llm_call in DAG-array order.
  // Renders the conversation bubble's multi-round text without the
  // workflow.nodes lazy-fetch window — user message and assistant
  // message arrive together when the lite ChatFlow lands. Tool
  // pills (input/output JSON, thinking traces) still come from
  // workflow.nodes via lazy load. Cost: ~5-15% increase to lite
  // payload (200-CN session estimate +200KB-1MB), still vastly
  // smaller than the 22MB full ChatFlow.
  // 中: 每个 llm_call 的完整 text 数组（按 DAG 顺序）。让 bubble 的
  // 多轮 assistant 文本随 lite ChatFlow 一起到达，不用等 workflow
  // lazy fetch。tool pill 仍懒加载。代价 ~5-15% lite 体积增长。
  assistantText: string[];
  llmCount: number;
  // EN (v0.9.2): true when this ChatNode has any tool_call /
  // delegate WorkNode whose `resultBlock` is missing OR a final
  // llm_call without a stopReason. Server-computed at parse time;
  // drives the canvas / conversation 'running' animation. Stays
  // accurate during long-running tools (mtime doesn't tick during
  // a 30s Bash, but data-shape correctly says "still in flight"
  // because the tool_use record exists without a matching
  // tool_result yet).
  // Combined with `isLatest` chronologically and the SSE
  // sessionLive heuristic in livenessHooks.ts to gate the
  // animation: history ChatNodes with leftover unfinished tools
  // (rare orphan case) don't animate; only the latest with
  // in-flight work animates.
  // 中: ChatNode 内部有任何 tool_call/delegate 的 resultBlock 缺失，
  // 或最末 llm_call 无 stopReason 时为 true。server 解析时算好。
  // 长时工具（30s Bash 期间 mtime 不变）依然正确显示运行中，因为
  // 是按数据形态判定，不靠 mtime。
  hasInFlightWork: boolean;
  // Number of CONNECTED llm_call chains in the WorkFlow DAG. A chain
  // is a maximal run of llm_call nodes linked by continuation
  // (llm → tool → llm). chainCount=1 is the common case (one prompt
  // → one continuous back-and-forth ending in end_turn). >1 means
  // the assistant ran multiple disjoint sequences in the same
  // ChatNode — typically auto-compact mid-turn, error-retry, or
  // harness-side interruption. Surfaced on the card as a 🔗 N chip
  // when >1.
  chainCount: number;
  // tool_call + delegate combined (= 🔧 chip count).
  toolCount: number;
  // ▸N.Nk thinking-chars indicator total.
  totalThinkingChars: number;
  // TokenBar inputs.
  contextTokens: number;
  maxContextTokens: number;
  // v1.5: per-turn aggregate token usage for the persistent stat
  // line in MessageMeta (composer-bubble copy row). Sums across ALL
  // real (non-synthetic, error-free) llm_calls in this ChatNode's
  // workflow.
  //   inputTokens  = Σ (input_tokens + cache_creation_input_tokens)
  //                  ↑ "fresh stuff CC processed" — excludes
  //                  cache_read replay since that's not new work.
  //   outputTokens = Σ output_tokens
  inputTokens: number;
  outputTokens: number;
  // v1.5: total turn duration in milliseconds — last node's
  // timestamp minus the first record (first WorkNode timestamp,
  // approximating "from CC starting work to CC stopping"). Null
  // when timestamps are missing on either end (rare; all real
  // jsonl records carry timestamps). Doesn't include the user's
  // typing time since the user-message timestamp is set at submit.
  durationMs: number | null;
  // Last llm_call's model — drives the edge-hover model tooltip and
  // the model ribbon overlay.
  lastModel?: string;
  // file_path values from this turn's Edit / Write / MultiEdit /
  // NotebookEdit tool_uses. Used by ``nodeOwnFileChanges`` to compute
  // the "本节点文件改动" delta (✏️ N chip) without needing
  // workflow.nodes loaded.
  toolUseFilePaths: string[];
  // EN (v0.11): for hybrid ChatNodes (`hasInnerCompact === true`),
  // the index in `assistantText` at which the post-compact rounds
  // BEGIN. assistantText[0..idx-1] = pre-compact (already covered by
  // compactMetadata.summaryText, redundant from a downstream POV);
  // assistantText[idx..] = post-compact continuation (verbatim
  // context the next ChatNode actually sees). Populated by
  // computeWorkflowSummary when the workflow contains a `compact`
  // WorkNode; undefined for non-hybrid turns. Drives the Effective
  // Context tab's ability to render only the post-compact tail
  // without duplicating content already in the summary.
  // 中: hybrid ChatNode 的 post-compact 起点。assistantText 的
  // [0..idx-1] 是 pre-compact（已被 summary 覆盖，下游冗余），
  // [idx..] 是 post-compact（下游能 verbatim 看到的延续）。
  innerCompactLlmCallBoundaryIdx?: number;
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
  // v0.11: git commits made during this ChatNode's runtime, detected
  // by parsing Bash tool_use commands (`git commit ...`) and their
  // outputs (the `[branch sha] subject` line CC's stdout returns).
  // The `repo` is the git repo toplevel (resolved from the command's
  // `-C` flag, `cd` chain, or the record's cwd at fire time). Sha
  // stored as the short or full hash CC reported. Diffs aren't
  // captured here — fetched on demand via /api/git/diff with the
  // (repo, sha, file) tuple. Empty/absent = no commits in this
  // ChatNode.
  commits?: GitCommitRef[];
  errors?: NodeError[];
}

// Lightweight reference to a git commit detected inside a ChatNode.
// Doesn't carry diff content — that's fetched on demand by GitDiffPanel
// via `git -C <repo> show <sha>`. The `files` field can be empty here
// (parser doesn't always know which files changed without running
// git itself); the diff endpoint fills that in.
export interface GitCommitRef {
  /** Absolute path to the git repo toplevel where the commit landed. */
  repo: string;
  /** Commit SHA as CC's stdout reported it (short or long). */
  sha: string;
  /** Subject line (first line of commit message) when extractable. */
  subject?: string;
  /** Wall-clock timestamp from the parent record when the commit fired. */
  timestamp?: string;
  /** Files changed by the commit, populated by the diff endpoint on
   * first fetch. Persisted here so subsequent renders skip the round
   * trip. */
  files?: string[];
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

// v2.7: a ChatNode whose user "message" is PURELY a harness-injected
// system event, not a human prompt — e.g. a <task-notification>
// (background task finished) or a standalone <system-reminder> /
// <local-command-caveat>. These records carry the user role in the
// jsonl and DO drive a fresh assistant turn (so the node is real),
// but rendering their raw XML as a human bubble is noise. Parser
// recognises them, extracts a one-line summary, and the card /
// conversation bubble render a distinct "system event" chrome (slate,
// not the human blue/green) with the raw text available on expand.
//
// Same design as SlashCommandInfo: a structured field the renderer
// switches on, so the raw content stays queryable (transcript-viewer
// fidelity) while the DEFAULT presentation is semantic.
//
// IMPORTANT: only set when the message is ENTIRELY injection. A real
// human turn that merely CARRIES an injected <system-reminder> prefix
// (very common) is NOT a system event — those blocks are stripped at
// render time instead, leaving the human text intact.
//
// 中(v2.7): 整条 user "消息" 纯粹是 harness 注入的系统事件(而非人类
// 输入)的 ChatNode——如后台任务完成的 <task-notification>、单独的
// <system-reminder> / <local-command-caveat>。它们在 jsonl 里是 user
// 角色且确实触发了新一轮 assistant(节点是真的),但把原始 XML 当人类
// 气泡显示是噪音。parser 识别它们、提一行摘要,卡片/对话气泡用独立的
// "系统事件" 样式(石板灰,区别于人类蓝/绿),原文展开可查。
// 关键:仅当整条都是注入才标记;带 <system-reminder> 前缀的正常人类
// turn 不算(那些块在渲染时剥离,保留人类文本)。
export interface SystemEventInfo {
  /** Which injection dominates the message — drives icon + label. */
  variant:
    | "task-notification"
    | "system-reminder"
    | "caveat"
    | "generic";
  /** One-line summary for the card / bubble headline. Derived from
   *  the injection's structured fields (task-notification's
   *  <summary>) or the first meaningful line, trimmed. */
  summary: string;
  /** task-notification only: the background task's terminal status,
   *  mapped to a ✅/❌ affordance by the renderer. */
  status?: "completed" | "failed";
}

// ⚠ SHAPE-CHANGE CONTRACT: adding / removing / re-meaning ANY field on
// ChatNode (or WorkNode / WorkFlow / WorkflowSummary / ChatFlow) MUST
// bump `SCHEMA_VERSION` in server/services/chatFlowDiskCache.ts.
// Otherwise sessions cached under the old version keep being served
// stale — the parser never re-runs and the new field is invisible for
// existing sessions until their jsonl next changes. This bit v2.7
// (systemEvent was added without a bump; old sessions kept showing raw
// XML). 中: 改 ChatNode 等形状必须同步 bump diskcache SCHEMA_VERSION,
// 否则旧 session 命中 stale 缓存不重新解析(v2.7 就踩了)。
export interface ChatNode extends NodeBase {
  // ``kind: "chat"`` discriminates ChatNode from WorkNode in code that
  // works against ``NodeBase``. Cards / chrome that need to switch
  // behaviour by layer use this; cards specific to ChatFlow vs
  // WorkFlow can still narrow by interface name as before.
  kind: "chat";
  // = promptId (the cluster key for v0.1 bucketing).
  id: string;
  /** PR-1 (2026-05-18, convergence rework §9.2): Loomscope-minted
   *  correlation id, server-bound to this node's `promptId`.
   *  PARALLEL, NON-KEY field in PR-1 — carried end-to-end but the
   *  dedup/identity key is still `id` (=promptId). It becomes the
   *  primary identity in a later PR (§9.7). Optional: present only
   *  once the server binding table has resolved it; absent on
   *  fixtures / pre-binding signals. Never displayed. */
  loomId?: string;
  parentChatNodeId: string | null;
  rootUserUuid: string;
  userMessage: ChatNodeUserMessage;
  workflow: WorkFlow;
  trigger: ChatNodeTrigger;
  triggerSource?: { workNodeId: string };
  isCompactSummary: boolean;
  /** True when this ChatNode's bucket carried a compact_summary user
   * record AND a real user prompt — i.e. CC fired auto-compact mid-
   * turn and continued the same promptId after the boundary. The
   * ChatNode is a hybrid: regular turn that *also* contains an
   * inline compact. The card stays the normal ChatNode chrome (real
   * work was done here) and surfaces an inner-compact chip as a
   * marker. Optional so existing test fixtures stay valid; parser
   * always populates explicitly. */
  hasInnerCompact?: boolean;
  compactMetadata?: CompactNode;
  /** When set: this ChatNode is a slash-command invocation, not a real
   * conversation turn. Render specially. */
  slashCommand?: SlashCommandInfo;
  /** v2.7: when set, this ChatNode's user message is purely a harness-
   * injected system event (task-notification / system-reminder /
   * caveat), not a human prompt. Render with the "system event"
   * chrome. See SystemEventInfo. Mutually exclusive with slashCommand
   * (slash has its own kind). 中: 系统事件 turn,见 SystemEventInfo。 */
  systemEvent?: SystemEventInfo;
  /** v0.8: cross-session fork pointer. CC `/branch` writes this on
   * every record copied into the new fork session; parser hoists it to
   * the ChatNode (multiple records inside one ChatNode share the same
   * forkedFrom by construction — they all originate from the same
   * source ChatNode in the original session). null when the ChatNode
   * isn't part of a /branch-created fork session. */
  forkedFrom?: { sessionId: string; messageUuid: string };
  /** Which jsonls' records contributed to this ChatNode bucket.
   *
   * CC's forkSession assigns NEW record uuids but PRESERVES promptId
   * across the copied prefix. The closure-merge parser groups records
   * by promptId, so the shared prefix lands in ONE ChatNode whose
   * records came from BOTH the entry session's jsonl AND a sibling
   * fork's jsonl. Post-fork buckets (records exclusive to one jsonl)
   * carry just that one sessionId.
   *
   * Used by canvas + composer to distinguish the active session's
   * writable chain from sibling-fork side branches:
   *   - viewing session X, ChatNode is on X's chain
   *     ⇔ contributingSessions includes X
   *   - off-chain ChatNodes render gray (read-only). Composing from
   *     them is blocked at the composer; the user uses the right-click
   *     menu to fork-from-here or jump-to-source-session (PR 2).
   *
   * Optional in the type (not all callers / fixtures populate it);
   * parser fills it deterministically. Empty array = legacy / unknown
   * provenance (treat as "on every chain" for safety). */
  contributingSessions?: string[];
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
  /** v0.8: customTitle from the `{type:"custom-title"}` record CC
   * `/branch` appends to fork sessions (e.g. `"<原 firstPrompt> (Branch)"`).
   * null when the session isn't a /branch fork. */
  customTitle?: string;
  /** v0.8: when this ChatFlow was produced by merging multiple jsonl
   * files (fork closure), records the sessionIds in BFS order from
   * the entry session. Single-element list (just the loaded
   * sessionId) when the session has no fork relations. Server fills
   * this in when computing the closure (M2). */
  linkedSessions?: string[];
  chatNodes: ChatNode[];
  // Records that couldn't be placed into any ChatNode (no promptId, not a known
  // ChatFlow-level event). Kept for debugging / future passes.
  orphans: OrphanRecord[];
  // Top-level events not bound to a single ChatNode. ScheduleWakeup fires,
  // standalone permission-mode flips, etc.
  flowEvents: FlowEvent[];
  /** PR-1 (2026-05-18, convergence rework §9): server-authoritative
   *  monotonic version (= chatFlowDeltaEngine snapshot seq) at the
   *  time this lite payload was built. PLUMBING ONLY in PR-1 — the
   *  client records it (`SessionState.serverVersion`) but NOTHING
   *  consumes it for control flow yet; the gap detector still uses
   *  the unchanged `appliedVersion` null-seeding contract.
   *  Consumption is PR-2. Optional so older payloads / fixtures
   *  stay valid. */
  version?: number;
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
