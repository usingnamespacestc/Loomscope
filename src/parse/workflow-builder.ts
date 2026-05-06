// Build a per-ChatNode WorkFlow from a bucket of records (all sharing a
// promptId).
//
// A WorkFlow is a DAG of WorkNodes:
//   - llm_call:  one per assistant record
//   - tool_call: one per tool_use block (Agent/Task → delegate)
//   - delegate:  Agent/Task tool_use, with sidecar agentId for v0.5 expand
//   - compact:   isCompactSummary user record (lifted from this bucket)
//   - attachment: extra metadata records (file/edited_text_file/queued_command/
//                 invoked_skills/compact_file_reference)
//
// Edge wiring:
//   - assistant.parentUuid → continuation in (from prev step)
//   - tool_use block → spawn edge from owning assistant llm_call to the
//     tool_call/delegate node
//   - tool_result user record → continuation edge from tool_call back to the
//     follow-up assistant (when present) — kept implicit via parentUuid; the
//     follow-up assistant's parentUuid points at the tool_result user record
//     so the chain is reconstructable from llm_call.parentUuid alone.
//   - compact: `logical` edge from compact node to its boundary's
//     logicalParentUuid (the pre-compact tail).

import type {
  AttachmentNode,
  CompactNode,
  DelegateNode,
  Edge,
  LlmCallNode,
  ThinkingBlock,
  ToolCallNode,
  WorkFlow,
  WorkNode,
} from "@/data/types";
import {
  blocksOf,
  extractToolResultBlock,
  isToolResultRecord,
  type InnerToolUseBlock,
  type RawRecord,
} from "@/parse/raw-record";

export const DELEGATE_TOOL_NAMES = new Set(["Agent", "Task"]);

const ATTACHMENT_RENDER_TYPES = new Set([
  "file",
  "edited_text_file",
  "queued_command",
  "invoked_skills",
  "compact_file_reference",
  "skill_listing",
]);

interface BuildContext {
  records: RawRecord[];
  // For a given assistant record uuid, the list of tool_use block ids it owns.
  assistantToToolUses: Map<string, string[]>;
  // For a given tool_use id, the user record that carries its tool_result.
  toolUseToResult: Map<string, RawRecord>;
  // For a given tool_use id, the owning tool_use block (for input/name).
  toolUseBlocks: Map<string, { block: InnerToolUseBlock; assistantUuid: string }>;
  // Compact records living in this ChatNode's bucket (rare — usually compact's
  // user record has its own promptId, in which case the entire bucket _is_ the
  // compact ChatNode and gets handled at the ChatFlow layer).
  compactRecords: RawRecord[];
}

function indexRecords(records: RawRecord[]): BuildContext {
  const assistantToToolUses = new Map<string, string[]>();
  const toolUseToResult = new Map<string, RawRecord>();
  const toolUseBlocks = new Map<
    string,
    { block: InnerToolUseBlock; assistantUuid: string }
  >();
  const compactRecords: RawRecord[] = [];

  for (const r of records) {
    if (r.type === "assistant" && r.uuid) {
      const tuIds: string[] = [];
      for (const b of blocksOf(r)) {
        if (b.type === "tool_use") {
          const tu = b as InnerToolUseBlock;
          tuIds.push(tu.id);
          toolUseBlocks.set(tu.id, { block: tu, assistantUuid: r.uuid });
        }
      }
      if (tuIds.length) assistantToToolUses.set(r.uuid, tuIds);
    } else if (isToolResultRecord(r)) {
      const blk = extractToolResultBlock(r);
      if (blk?.tool_use_id) toolUseToResult.set(blk.tool_use_id, r);
    } else if (r.type === "user" && r.isCompactSummary) {
      compactRecords.push(r);
    }
  }

  return {
    records,
    assistantToToolUses,
    toolUseToResult,
    toolUseBlocks,
    compactRecords,
  };
}

// EN (B / msg_id merge): CC writes one assistant jsonl record per
// content block. A response with [thinking, tool_use, text] becomes
// 3 records, all sharing `message.id`, each with one block in
// `message.content[]` and an internal-chain parent (record 2.parent
// = record 1.uuid, etc.). Building one LlmCallNode per record
// produced near-empty "split" nodes — drilling into a thinking-only
// or tool_use-only record's detail showed e.g. `Text: (空) +
// Thinking (1 block, internal empty) + Usage` while the SIBLING
// record had the actual content.
//
// Merging by message.id consolidates one logical API call into one
// LlmCallNode. Information is strictly preserved (union of all
// blocks across the group); intra-group parent edges collapse
// (they were CC writer-internal chains, not meaningful workflow
// edges); chainCount becomes semantic again (real chain breaks vs
// split-record artifacts).
//
// 中: 按 message.id 合并多条 split assistant records 成一个逻辑
// LlmCallNode。一次 API call 产出 N 条 record（thinking/text/
// tool_use 各一块）共享 message.id；合并后 1 API call = 1 节点，
// 内容并集，组内串行 parent 边自然 collapse。
//
// `messageId` is null for records that genuinely have no
// `message.id` (extremely old / hand-crafted fixtures); each such
// record gets its own group of size 1, so the legacy per-record
// behaviour falls out naturally.
export interface AssistantGroup {
  messageId: string | null;
  group: RawRecord[];
}

export function groupAssistantsByMessageId(
  records: RawRecord[],
): AssistantGroup[] {
  // Walk records preserving first-seen order. For each assistant
  // record, append to existing group if the messageId matches; else
  // start a new group. Records without a messageId form singleton
  // groups (so the iteration cost stays O(N) with a small Map).
  const out: AssistantGroup[] = [];
  // mid -> index into out[] (only valid for non-null messageIds; null
  // ids always create fresh singletons, never coalesce)
  const indexByMid = new Map<string, number>();
  for (const r of records) {
    if (r.type !== "assistant") continue;
    const mid = r.message?.id ?? null;
    if (mid === null) {
      out.push({ messageId: null, group: [r] });
      continue;
    }
    const existing = indexByMid.get(mid);
    if (existing !== undefined) {
      out[existing].group.push(r);
    } else {
      indexByMid.set(mid, out.length);
      out.push({ messageId: mid, group: [r] });
    }
  }
  return out;
}

export function buildMergedLlmCall(records: RawRecord[]): LlmCallNode {
  if (records.length === 0) {
    throw new Error("buildMergedLlmCall: empty records[]");
  }
  const first = records[0];
  const thinking: ThinkingBlock[] = [];
  const textParts: string[] = [];
  for (const r of records) {
    for (const b of blocksOf(r)) {
      if (b.type === "thinking") {
        thinking.push({
          text: typeof b.thinking === "string" ? b.thinking : "",
          signature: typeof b.signature === "string" ? b.signature : undefined,
        });
      } else if (b.type === "text") {
        const txt = (b as { text?: unknown }).text;
        if (typeof txt === "string") textParts.push(txt);
      }
      // tool_use / image / tool_use_reference blocks are NOT merged
      // into the LlmCallNode — they spawn separate ToolCallNodes
      // (or are filtered by buildToolCallOrDelegate). The merge here
      // only gathers content that lives ON the llm_call itself.
    }
  }
  // stop_reason: streamed responses can have transient values on
  // earlier records; the FINAL record carries the resolved one. Take
  // the last non-empty.
  let stopReason: string | undefined;
  for (const r of records) {
    if (r.message?.stop_reason) stopReason = r.message.stop_reason;
  }
  return {
    // id picks the first record's uuid — keeps cn.id stable across
    // upgrade (no disk-cache schema break beyond the SCHEMA_VERSION
    // bump that happens in step 2 anyway).
    id: first.uuid ?? "",
    kind: "llm_call",
    // Outermost parent — first record's parent points OUTSIDE the
    // group (records 2..N's parents point at sibling records inside
    // the group, which are CC-writer-internal chains we collapse).
    parentUuid: first.parentUuid ?? null,
    // Envelope fields are copied across split records (CC behavior),
    // so any record gives the same value. Use first for stable ref.
    requestId: first.requestId,
    model: first.message?.model,
    text: textParts.join(""),
    thinking,
    stopReason,
    usage: first.message?.usage,
    timestamp: first.timestamp,
  };
}

function buildToolCallOrDelegate(
  toolUseId: string,
  ctx: BuildContext,
): ToolCallNode | DelegateNode | null {
  const entry = ctx.toolUseBlocks.get(toolUseId);
  if (!entry) return null;
  const { block, assistantUuid } = entry;
  const resultRec = ctx.toolUseToResult.get(toolUseId);
  const resultBlock = resultRec ? extractToolResultBlock(resultRec) : null;
  const tur = resultRec?.toolUseResult as Record<string, unknown> | undefined;
  const isError =
    (resultBlock?.is_error === true) ||
    (typeof tur?.["status"] === "string" && tur["status"] === "failed");

  if (DELEGATE_TOOL_NAMES.has(block.name)) {
    const input = (block.input ?? {}) as Record<string, unknown>;
    const node: DelegateNode = {
      id: block.id,
      kind: "delegate",
      parentUuid: assistantUuid,
      toolName: block.name,
      description: typeof input.description === "string" ? input.description : undefined,
      prompt: typeof input.prompt === "string" ? input.prompt : undefined,
      agentType:
        typeof tur?.["agentType"] === "string"
          ? (tur["agentType"] as string)
          : typeof input["subagent_type"] === "string"
            ? (input["subagent_type"] as string)
            : undefined,
      agentId: typeof tur?.["agentId"] === "string" ? (tur["agentId"] as string) : undefined,
      resultUserUuid: resultRec?.uuid,
      status: typeof tur?.["status"] === "string" ? (tur["status"] as string) : undefined,
      content: typeof tur?.["content"] === "string" ? (tur["content"] as string) : undefined,
      totalDurationMs: numeric(tur?.["totalDurationMs"]),
      totalTokens: numeric(tur?.["totalTokens"]),
      totalToolUseCount: numeric(tur?.["totalToolUseCount"]),
      usage: (tur?.["usage"] as Record<string, unknown>) ?? undefined,
      toolStats: (tur?.["toolStats"] as Record<string, unknown>) ?? undefined,
      toolUseResult: tur,
      isError,
      timestamp: resultRec?.timestamp,
    };
    return node;
  }

  const node: ToolCallNode = {
    id: block.id,
    kind: "tool_call",
    parentUuid: assistantUuid,
    toolName: block.name,
    input: block.input,
    resultUserUuid: resultRec?.uuid,
    resultBlock: resultBlock ?? undefined,
    toolUseResult: tur,
    isError,
    timestamp: resultRec?.timestamp,
  };
  return node;
}

function numeric(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function buildAttachmentNode(r: RawRecord): AttachmentNode | null {
  const a = r.attachment;
  if (!a || typeof a.type !== "string") return null;
  if (!ATTACHMENT_RENDER_TYPES.has(a.type)) return null;
  return {
    id: r.uuid ?? "",
    kind: "attachment",
    parentUuid: r.parentUuid ?? null,
    attachmentType: a.type,
    raw: r.attachment,
    timestamp: r.timestamp,
  };
}

export interface BuildWorkflowOptions {
  // Hidden compact summary record from the *previous* segment, if this bucket
  // is being interpreted as a compact-anchored ChatNode. Optional.
  compactRecord?: RawRecord;
  boundaryRecord?: RawRecord;
}

export function buildWorkflow(
  records: RawRecord[],
  options: BuildWorkflowOptions = {},
): WorkFlow {
  const ctx = indexRecords(records);
  const nodes: WorkNode[] = [];
  const edges: Edge[] = [];
  // Track tool_use ids that we already emitted so we don't double-add.
  const seenToolUses = new Set<string>();

  // Compact node first (top of WorkFlow), if attached at bucket level.
  if (options.compactRecord) {
    nodes.push(buildCompactNode(options.compactRecord, options.boundaryRecord));
  }

  // B (msg_id merge): group assistant records by message.id so split
  // records (one content block per record, all sharing message.id)
  // produce one logical LlmCallNode per API call. Build a sideband
  // index mapping every record uuid → its group's canonical id (=
  // first record's uuid) so:
  //   - tool_use's `parentUuid` (= the assistantUuid of the record
  //     it lived in) gets remapped to the merged llm's id
  //   - continuation edges' `from` (= a prior record's uuid) gets
  //     remapped if it points at any record now collapsed into a
  //     group's interior
  //   - intra-group edges (= record N+1's parent points at record
  //     N's uuid in the same group) self-loop and get skipped
  const assistantGroups = groupAssistantsByMessageId(records);
  const recordUuidToMergedId = new Map<string, string>();
  for (const { group } of assistantGroups) {
    const mergedId = group[0]?.uuid ?? "";
    if (!mergedId) continue;
    for (const r of group) {
      if (r.uuid) recordUuidToMergedId.set(r.uuid, mergedId);
    }
  }

  for (const { group } of assistantGroups) {
    const llm = buildMergedLlmCall(group);
    nodes.push(llm);
    if (llm.parentUuid) {
      // continuation in: from prior step (tool_result user record or prior
      // assistant). Remap through merged-id index so any reference to a
      // now-collapsed record points at its group's canonical id.
      const remappedFrom =
        recordUuidToMergedId.get(llm.parentUuid) ?? llm.parentUuid;
      // Skip self-loops (would happen if a record's parent pointed at a
      // sibling within the same group — but llm.parentUuid is the FIRST
      // record's parent which by construction points outside the group,
      // so this should be unreachable in practice).
      if (remappedFrom !== llm.id) {
        edges.push({ from: remappedFrom, to: llm.id, kind: "continuation" });
      }
    }
    // Spawn tool_uses across all records in the group; they all
    // attribute to the same merged llm.id.
    for (const r of group) {
      const tuIds = ctx.assistantToToolUses.get(r.uuid ?? "") ?? [];
      for (const tuId of tuIds) {
        if (seenToolUses.has(tuId)) continue;
        seenToolUses.add(tuId);
        const child = buildToolCallOrDelegate(tuId, ctx);
        if (!child) continue;
        // Remap the child's parentUuid to point at the merged llm.id
        // — downstream consumers (chainCount, resolveDelegate's
        // record-uuid → cn.id walks, etc.) need a valid LlmCallNode
        // reference, not a now-collapsed record uuid.
        if (
          child.parentUuid &&
          recordUuidToMergedId.has(child.parentUuid)
        ) {
          child.parentUuid =
            recordUuidToMergedId.get(child.parentUuid) ?? child.parentUuid;
        }
        nodes.push(child);
        edges.push({ from: llm.id, to: child.id, kind: "spawn" });
      }
    }
  }

  // Inner-bucket compact_records (rare) — emit one node per file-line, even
  // if the record's uuid duplicates the primary compactRecord. CC's jsonl has
  // been observed to repeat isCompactSummary lines verbatim; faithfully
  // reflecting them at parse time avoids hiding signal at the data layer.
  // Duplicate ids get a `#N` suffix so downstream node-id sets stay unique.
  let dupSuffix = 0;
  for (const cr of ctx.compactRecords) {
    if (options.compactRecord && cr === options.compactRecord) continue;
    const node = buildCompactNode(cr, undefined);
    if (nodes.some((n) => n.id === node.id)) {
      dupSuffix += 1;
      node.id = `${node.id}#${dupSuffix}`;
    }
    nodes.push(node);
  }

  // Attachments rendered as their own WorkNodes (file / edited_text_file /
  // queued_command / invoked_skills / compact_file_reference / skill_listing).
  for (const r of records) {
    if (r.type !== "attachment") continue;
    const att = buildAttachmentNode(r);
    if (att) nodes.push(att);
  }

  return { nodes, edges };
}

export function buildCompactNode(
  user: RawRecord,
  boundary: RawRecord | undefined,
): CompactNode {
  const meta = boundary?.compactMetadata ?? user.compactMetadata;
  const summary =
    typeof user.message?.content === "string" ? user.message.content : "";
  // PR 2.4-C: route CompactNode.parentUuid past the (invisible)
  // boundary record. CC writes compact_boundary with parentUuid=null
  // and logicalParentUuid pointing at the pre-compact tail (the user
  // record that carried the last tool_result before compaction). The
  // synthetic compactSummary user record points its parentUuid at
  // the boundary, which is then dangling for chain-walk purposes
  // since the boundary itself isn't a WorkNode and (when its
  // parentUuid=null) doesn't even surface in chainParentByUuid.
  // Setting CompactNode.parentUuid = the resolved pre-compact tail
  // uuid lets layoutWorkflow draw a continuation edge from the prior
  // tool_call/llm_call into the CompactNode (semantically correct —
  // the compact directly continues the prior work) and lets the
  // front-end chain walk hop through into chain history without
  // needing a raw-record map.
  const preCompactTailUuid =
    boundary?.logicalParentUuid ?? user.logicalParentUuid ?? null;
  const userParent = user.parentUuid ?? null;
  return {
    id: user.uuid ?? "",
    kind: "compact",
    parentUuid: preCompactTailUuid ?? userParent,
    boundaryUuid: boundary?.uuid,
    logicalParentUuid: preCompactTailUuid ?? undefined,
    trigger: meta?.trigger,
    preTokens: typeof meta?.preTokens === "number" ? meta.preTokens : undefined,
    preCompactDiscoveredTools: meta?.preCompactDiscoveredTools,
    summaryText: summary,
    timestamp: user.timestamp,
  };
}
