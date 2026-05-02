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

function buildLlmCall(r: RawRecord): LlmCallNode {
  const thinking: ThinkingBlock[] = [];
  const textParts: string[] = [];
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
  }
  return {
    id: r.uuid ?? "",
    kind: "llm_call",
    parentUuid: r.parentUuid ?? null,
    requestId: r.requestId,
    model: r.message?.model,
    text: textParts.join(""),
    thinking,
    stopReason: r.message?.stop_reason,
    usage: r.message?.usage,
    timestamp: r.timestamp,
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

  for (const r of records) {
    if (r.type !== "assistant") continue;
    const llm = buildLlmCall(r);
    nodes.push(llm);
    if (r.parentUuid) {
      // continuation in: from prior step (tool_result user record or prior
      // assistant). The "from" node may live elsewhere — edges are best-effort
      // and ChatFlow-layer linking can stitch them.
      edges.push({ from: r.parentUuid, to: llm.id, kind: "continuation" });
    }
    const tuIds = ctx.assistantToToolUses.get(r.uuid ?? "") ?? [];
    for (const tuId of tuIds) {
      if (seenToolUses.has(tuId)) continue;
      seenToolUses.add(tuId);
      const child = buildToolCallOrDelegate(tuId, ctx);
      if (!child) continue;
      nodes.push(child);
      edges.push({ from: llm.id, to: child.id, kind: "spawn" });
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
  return {
    id: user.uuid ?? "",
    kind: "compact",
    parentUuid: user.parentUuid ?? null,
    boundaryUuid: boundary?.uuid,
    logicalParentUuid: boundary?.logicalParentUuid ?? user.logicalParentUuid ?? undefined,
    trigger: meta?.trigger,
    preTokens: typeof meta?.preTokens === "number" ? meta.preTokens : undefined,
    preCompactDiscoveredTools: meta?.preCompactDiscoveredTools,
    summaryText: summary,
    timestamp: user.timestamp,
  };
}
