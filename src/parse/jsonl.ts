// Top-level parser: JSONL bytes → ChatFlow.
//
// Two entry points:
//   parseJsonlText(text, paths) — sync, suitable for fixtures and small files
//   parseJsonlFile(path)        — async, streams the file via readline
//
// Algorithm (docs/design-data-model.md "解析算法"):
//   pass 1: index records (uuid → light summary; pair compact_boundary with
//           its isCompactSummary user record; collect ScheduleWakeup tool_use
//           ids by uuid for trigger source lookup).
//   pass 2: bucket records by promptId; skip records w/o promptId into orphans
//           or flowEvents according to type.
//   pass 3: per bucket, build a ChatNode (pick rootUserUuid + WorkFlow).
//   pass 4: link parentChatNodeId by walking parentUuid back across non-prompt
//           records; attach awaySummary / scheduledFire metadata.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import type {
  AttachmentNode,
  ChatFlow,
  ChatNode,
  ChatNodeMeta,
  ChatNodeUserMessage,
  FileHistorySnapshot,
  FlowEvent,
  OrphanRecord,
} from "@/data/types";
import {
  blocksOf,
  extractToolResultBlock,
  isToolResultRecord,
  parseLine,
  type RawRecord,
} from "@/parse/raw-record";
import { computeWorkflowSummary } from "@/parse/workflow-summary";
import { buildWorkflow } from "@/parse/workflow-builder";

// Records flagged with these are dropped from the canvas data model entirely.
const SKIP_TYPES = new Set([
  "last-prompt", // metadata snapshot
  "messages_changed",
  "system_changed",
  "queue-operation", // timing detail; not on v0 canvas
  // v0.8: hoisted to chatFlow.customTitle in the first-pass scan above;
  // skip the bucketing step so it doesn't end up as an orphan.
  "custom-title",
]);

interface IndexedRecord {
  uuid: string;
  parentUuid: string | null;
  logicalParentUuid?: string | null;
  type: string;
  subtype?: string;
  promptId?: string;
  isCompactSummary?: boolean;
  timestamp?: string;
}

interface PromptBucket {
  promptId: string;
  records: RawRecord[];
}

export interface ParseResult {
  chatFlow: ChatFlow;
  // Per-line parse failures, kept for debugging.
  parseFailures: number;
}

export interface ParseOptions {
  // Strip the trailing `.jsonl` from `mainJsonlPath` to derive the sidecar
  // dir. Override only if you have a non-standard layout.
  sidecarDir?: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function parseJsonlText(
  text: string,
  mainJsonlPath: string,
  options: ParseOptions = {},
): ParseResult {
  const records: RawRecord[] = [];
  let parseFailures = 0;
  // Split on \n preserves blank trailing line; parseLine guards.
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const r = parseLine(line);
    if (r) records.push(r);
    else parseFailures += 1;
  }
  const chatFlow = buildChatFlow(records, mainJsonlPath, options);
  return { chatFlow, parseFailures };
}

export async function parseJsonlFile(
  jsonlPath: string,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const records: RawRecord[] = [];
  let parseFailures = 0;
  const stream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = parseLine(line);
    if (r) records.push(r);
    else parseFailures += 1;
  }
  const chatFlow = buildChatFlow(records, jsonlPath, options);
  return { chatFlow, parseFailures };
}

// ─── Core builder ────────────────────────────────────────────────────────────

export function buildChatFlow(
  records: RawRecord[],
  mainJsonlPath: string,
  options: ParseOptions = {},
): ChatFlow {
  const sidecarDir =
    options.sidecarDir ??
    (mainJsonlPath.endsWith(".jsonl")
      ? mainJsonlPath.slice(0, -".jsonl".length)
      : path.join(path.dirname(mainJsonlPath), path.basename(mainJsonlPath, ".jsonl")));

  const indexByUuid = new Map<string, IndexedRecord>();
  // For pairing: compact_boundary uuid → boundary record; isCompactSummary
  // user records track via their parentUuid (= boundary uuid).
  const boundariesByUuid = new Map<string, RawRecord>();
  const awaySummaryByUuid = new Map<string, RawRecord>();
  const scheduledFireByUuid = new Map<string, RawRecord>();
  // ScheduleWakeup tool_use id → toolu_… (for triggerSource lookup later).
  const scheduleWakeupToolUseIds = new Set<string>();

  // First, gather session-level metadata + uuid index.
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let createdAt: string | undefined;
  let lastUpdatedAt: string | undefined;
  // v0.8: customTitle from `{type: "custom-title"}` records (CC `/branch`
  // appends one per fork session). First-write wins — multiple in one
  // file is malformed but we don't crash.
  let customTitle: string | undefined;

  for (const r of records) {
    if (r.uuid) {
      indexByUuid.set(r.uuid, {
        uuid: r.uuid,
        parentUuid: r.parentUuid ?? null,
        logicalParentUuid: r.logicalParentUuid ?? null,
        type: r.type,
        subtype: r.subtype,
        promptId: r.promptId,
        isCompactSummary: r.isCompactSummary,
        timestamp: r.timestamp,
      });
    }
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    if (r.cwd && !cwd) cwd = r.cwd;
    if (r.gitBranch && !gitBranch) gitBranch = r.gitBranch;
    if (r.timestamp) {
      if (!createdAt || r.timestamp < createdAt) createdAt = r.timestamp;
      if (!lastUpdatedAt || r.timestamp > lastUpdatedAt) lastUpdatedAt = r.timestamp;
    }
    if (r.type === "system") {
      if (r.subtype === "compact_boundary" && r.uuid) boundariesByUuid.set(r.uuid, r);
      else if (r.subtype === "away_summary" && r.uuid) awaySummaryByUuid.set(r.uuid, r);
      else if (r.subtype === "scheduled_task_fire" && r.uuid) scheduledFireByUuid.set(r.uuid, r);
    }
    if (r.type === "custom-title" && customTitle === undefined) {
      // CC `/branch` appends one custom-title record per fork session.
      // The field name is `customTitle` per design-data-model.md "Fork
      // 机制" §1 step 4. First-write wins; we don't crash on duplicates.
      const title = (r as { customTitle?: unknown }).customTitle;
      if (typeof title === "string" && title.length > 0) customTitle = title;
    }
    if (r.type === "assistant") {
      for (const b of blocksOf(r)) {
        if (b.type === "tool_use" && (b as { name?: string }).name === "ScheduleWakeup") {
          const id = (b as { id?: string }).id;
          if (id) scheduleWakeupToolUseIds.add(id);
        }
      }
    }
  }

  // Bucket by promptId; collect orphans / flow events for the rest.
  const bucketsByPid = new Map<string, PromptBucket>();
  const orphans: OrphanRecord[] = [];
  const flowEvents: FlowEvent[] = [];
  // file-history-snapshot 通过 messageId → resolvePromptId 绑到 ChatNode；
  // 这里暂存，buildChatNode 时按 promptId 取出。
  const snapshotsByPid = new Map<string, FileHistorySnapshot[]>();

  // ⚠ Reality check: in real CC sessions only `type=user` records carry a
  // `promptId`. Everything else (assistant / attachment / file-history-snapshot
  // / system) inherits a promptId by walking parentUuid back to the nearest
  // user record. (Memoized for O(1) amortized lookup.)
  const inheritedPromptId = new Map<string, string | null>(); // uuid → pid or null
  const resolvePromptId = (uuid: string | null | undefined): string | null => {
    if (!uuid) return null;
    if (inheritedPromptId.has(uuid)) return inheritedPromptId.get(uuid) ?? null;
    // Defend against cycles.
    inheritedPromptId.set(uuid, null);
    const node = indexByUuid.get(uuid);
    if (!node) return null;
    let resolved: string | null = node.promptId ?? null;
    if (!resolved) {
      // Hop across compact_boundary via logicalParentUuid (its parentUuid is null).
      const next =
        node.type === "system" &&
        node.subtype === "compact_boundary" &&
        !node.parentUuid &&
        node.logicalParentUuid
          ? node.logicalParentUuid
          : node.parentUuid;
      resolved = resolvePromptId(next);
    }
    inheritedPromptId.set(uuid, resolved);
    return resolved;
  };

  const promptIdOf = (r: RawRecord): string | null => {
    if (r.promptId) return r.promptId;
    if (r.type === "user") return null; // a user record without promptId is data-poor; treat as orphan
    return resolvePromptId(r.parentUuid ?? null);
  };

  for (const r of records) {
    if (r.isMeta && !r.isCompactSummary && r.type !== "user") {
      // skip pure meta records (UI-only)
      continue;
    }
    if (SKIP_TYPES.has(r.type)) continue;

    // Carve out ChatFlow-layer system events *before* trying to bucket them.
    // These records sit between ChatNodes; assigning them to a bucket would
    // pollute the WorkFlow with cross-node noise.
    if (r.type === "system") {
      if (r.subtype === "scheduled_task_fire") {
        flowEvents.push({
          type: "scheduled_task_fire",
          uuid: r.uuid,
          timestamp: r.timestamp,
          data: { content: r.content, parentUuid: r.parentUuid },
        });
        continue;
      }
      if (r.subtype === "compact_boundary") {
        // Boundary alone has no promptId; the paired isCompactSummary user
        // *does*. We attach it via boundariesByUuid in buildChatNode.
        continue;
      }
      if (r.subtype === "away_summary") {
        // Attached as the next ChatNode's brief via awaySummaryByUuid.
        continue;
      }
      if (r.subtype === "bridge_status" || r.subtype === "informational") continue;
      if (r.subtype === "local_command") {
        flowEvents.push({
          type: "local_command",
          uuid: r.uuid,
          timestamp: r.timestamp,
          data: r.content,
        });
        continue;
      }
      // turn_duration / api_error / etc fall through and get bucketed via
      // parentUuid inheritance below.
    }

    const pid = promptIdOf(r);
    if (pid) {
      let bucket = bucketsByPid.get(pid);
      if (!bucket) {
        bucket = { promptId: pid, records: [] };
        bucketsByPid.set(pid, bucket);
      }
      bucket.records.push(r);
      continue;
    }

    // No promptId reachable: orphan classification.
    if (r.type === "system") {
      orphans.push({
        uuid: r.uuid,
        type: r.subtype ? `system/${r.subtype}` : "system",
        reason: "no promptId reachable",
      });
      continue;
    }

    if (r.type === "permission-mode") {
      flowEvents.push({
        type: "permission_mode",
        uuid: r.uuid,
        timestamp: r.timestamp,
        data: { permissionMode: r.permissionMode },
      });
      continue;
    }

    if (r.type === "file-history-snapshot") {
      // v0.7 binding via messageId direct lookup. Prior v0.1 doc claimed
      // these were unbinding orphans (parentUuid:null + no promptId), but
      // every snapshot carries `messageId` (top-level or nested under
      // `snapshot.messageId`) that resolves to a user/assistant record by
      // uuid — and that record resolves to a promptId via the existing
      // resolvePromptId() chain (parentUuid hop for assistant records).
      // Cross-user real-data sample (3059 snapshots): 100% have messageId,
      // 99.97% resolve to a record, 67% directly carry promptId, the rest
      // need parentUuid hop. Falls back to orphan only when both lookups
      // fail. See design-data-model.md "file-history-snapshot binding".
      const sn = (r.snapshot ?? {}) as {
        messageId?: string;
        trackedFileBackups?: Record<string, unknown>;
        timestamp?: string;
      };
      const messageId =
        (typeof (r as { messageId?: unknown }).messageId === "string"
          ? ((r as { messageId?: string }).messageId as string)
          : undefined) ?? sn.messageId;
      const isUpdate = (r as { isSnapshotUpdate?: unknown }).isSnapshotUpdate === true;
      const trackedFiles = sn.trackedFileBackups ? Object.keys(sn.trackedFileBackups) : [];
      const snapshotPid = messageId ? resolvePromptId(messageId) : null;
      if (snapshotPid) {
        const list = snapshotsByPid.get(snapshotPid) ?? [];
        list.push({
          uuid: r.uuid ?? "",
          timestamp: sn.timestamp ?? r.timestamp,
          trackedFiles,
          isUpdate,
        });
        snapshotsByPid.set(snapshotPid, list);
        continue;
      }
      orphans.push({
        uuid: r.uuid,
        type: "file-history-snapshot",
        reason: messageId
          ? `messageId ${messageId} did not resolve to a promptId`
          : "no messageId on snapshot record",
      });
      continue;
    }

    orphans.push({
      uuid: r.uuid,
      type: r.type + (r.subtype ? `/${r.subtype}` : ""),
      reason: "no promptId",
    });
  }

  // Build ChatNodes.
  const chatNodes: ChatNode[] = [];
  for (const bucket of bucketsByPid.values()) {
    const cn = buildChatNode(
      bucket,
      indexByUuid,
      boundariesByUuid,
      awaySummaryByUuid,
      scheduledFireByUuid,
      snapshotsByPid.get(bucket.promptId),
    );
    if (cn) chatNodes.push(cn);
  }

  // Sort ChatNodes by their root user record timestamp for stable ordering.
  chatNodes.sort((a, b) => {
    const ta = a.userMessage.timestamp ?? "";
    const tb = b.userMessage.timestamp ?? "";
    if (ta === tb) return a.id.localeCompare(b.id);
    return ta < tb ? -1 : 1;
  });

  // Link parentChatNodeId + scheduled trigger.
  linkChatNodeParents(chatNodes, indexByUuid, scheduledFireByUuid);

  // Backfill compactMetadata.logicalParentChatNodeId. The raw
  // CompactNode (built in workflow-builder) only has the record-level
  // logicalParentUuid; resolving it to a ChatNode id requires the
  // indexByUuid + resolvePromptId chain, which only lives here in
  // buildChatFlow. Pre-compute so the fold projection
  // (computeCompactRange) can walk parentChatNodeId from a known
  // ChatNode without any uuid chain walk at runtime.
  for (const cn of chatNodes) {
    if (!cn.isCompactSummary || !cn.compactMetadata) continue;
    const lpu = cn.compactMetadata.logicalParentUuid;
    if (!lpu) {
      cn.compactMetadata.logicalParentChatNodeId = null;
      continue;
    }
    cn.compactMetadata.logicalParentChatNodeId = resolvePromptId(lpu);
  }

  // Attach scheduled triggerSource (workNodeId = the ScheduleWakeup tool_use
  // block id of the most-recent ScheduleWakeup before the fire). We resolve
  // by walking the fire.parentUuid chain to find a tool_use we know about.
  for (const cn of chatNodes) {
    if (cn.trigger !== "scheduled" || !cn.meta.scheduledFireUuid) continue;
    const wid = findScheduleWakeupAncestor(
      cn.meta.scheduledFireUuid,
      indexByUuid,
      records,
      scheduleWakeupToolUseIds,
    );
    if (wid) cn.triggerSource = { workNodeId: wid };
  }

  return {
    id: sessionId ?? "",
    mainJsonlPath,
    sidecarDir,
    cwd,
    gitBranch,
    createdAt,
    lastUpdatedAt,
    trigger: "user", // cron-fired needs cross-session metadata; v0 default
    customTitle, // v0.8: from `{type: "custom-title"}` record (CC `/branch`)
    // v0.8: linkedSessions stays undefined for non-merged ChatFlows.
    // The server (M2) will set this when forming a merge闭包 from
    // multiple jsonl files; standalone parseJsonlFile / parseJsonlText
    // never sets it.
    chatNodes,
    orphans,
    flowEvents,
  };
}

function buildChatNode(
  bucket: PromptBucket,
  index: Map<string, IndexedRecord>,
  boundariesByUuid: Map<string, RawRecord>,
  awaySummaryByUuid: Map<string, RawRecord>,
  scheduledFireByUuid: Map<string, RawRecord>,
  fileHistorySnapshots?: FileHistorySnapshot[],
): ChatNode | null {
  // Root user record preference (highest → lowest):
  //   1. Non-meta user record (the actual user prompt or slash-command body)
  //   2. isMeta user record (sentinel like <<autonomous-loop-dynamic>> for
  //      ScheduleWakeup fires; or <local-command-caveat> for slash commands
  //      when there's nothing better. Picked when no non-meta exists.)
  //   3. compactSummary user record (compact ChatNodes — fallback only)
  //
  // Why: slash command invocations (e.g. /model) bucket as 3 user records:
  //   #1 isMeta=true: <local-command-caveat>… (system-injected warning)
  //   #2 isMeta=undef: <command-name>/model</command-name>…
  //   #3 isMeta=undef: <local-command-stdout>Set model to …
  // Without preferring non-meta, #1 wins and the card shows the caveat
  // text instead of the actual command. Same hazard for any future CC
  // feature that injects an isMeta prefix at the head of a turn.
  let nonMetaUser: RawRecord | undefined;
  let metaUser: RawRecord | undefined;
  let compactUser: RawRecord | undefined;
  for (const r of bucket.records) {
    if (r.type !== "user") continue;
    if (isToolResultRecord(r)) continue;
    if (r.isCompactSummary) {
      compactUser ??= r;
      continue;
    }
    if (r.isMeta) {
      metaUser ??= r;
      continue;
    }
    nonMetaUser ??= r;
  }
  const rootUser = nonMetaUser ?? metaUser ?? compactUser;
  if (!rootUser) {
    // No usable root — bucket is data-only (e.g. tool_result-only). Skip.
    return null;
  }

  // Attachments referencing this prompt's user message.
  const attachments: AttachmentNode[] = [];
  const permissionModeChanges: Array<{ uuid: string; permissionMode: string }> = [];
  for (const r of bucket.records) {
    if (r.type === "attachment") {
      const a = r.attachment;
      if (a && typeof a.type === "string") {
        // Don't double-emit attachment WorkNodes here; that happens inside
        // buildWorkflow. We *do* surface file/edited_text_file/queued_command
        // on the ChatNode user message for quick badging.
        if (a.type === "file" || a.type === "edited_text_file" || a.type === "queued_command") {
          attachments.push({
            id: r.uuid ?? "",
            kind: "attachment",
            parentUuid: r.parentUuid ?? null,
            attachmentType: a.type,
            raw: r.attachment,
            timestamp: r.timestamp,
          });
        }
      }
    } else if (r.type === "permission-mode" && r.uuid && typeof r.permissionMode === "string") {
      permissionModeChanges.push({ uuid: r.uuid, permissionMode: r.permissionMode });
    }
    // file-history-snapshot is bound separately via snapshotsByPid (see
    // buildChatFlow); the records never enter a bucket because their
    // promptId is resolved from messageId, not by promptId field.
  }

  const userMessage: ChatNodeUserMessage = {
    uuid: rootUser.uuid ?? "",
    content: rootUser.message?.content ?? rootUser.content ?? "",
    timestamp: rootUser.timestamp,
    attachments,
  };

  // Compact pairing.
  let isCompact = false;
  let boundaryRec: RawRecord | undefined;
  if (compactUser) {
    isCompact = true;
    const pUuid = compactUser.parentUuid ?? "";
    boundaryRec = boundariesByUuid.get(pUuid);
  }

  const workflow = buildWorkflow(bucket.records, {
    compactRecord: compactUser,
    boundaryRecord: boundaryRec,
  });
  // v0.10 polish (lazy ChatFlow B1): pre-compute summary stats so the
  // lite ChatFlow endpoint can ship them inline. ~100-200B per
  // ChatNode — negligible against the workflow.nodes payload.
  workflow.summary = computeWorkflowSummary(workflow.nodes, workflow.edges);

  // Determine trigger by walking the user record's parentUuid back across
  // system records (away_summary, scheduled_task_fire, turn_duration).
  let trigger: ChatNode["trigger"] = "user";
  let scheduledFireUuid: string | undefined;
  let awaySummaryAttached: ChatNodeMeta["awaySummary"] | undefined;

  let cursor: string | null = rootUser.parentUuid ?? null;
  let hops = 0;
  while (cursor && hops < 20) {
    const ancestor = index.get(cursor);
    if (!ancestor) break;
    if (ancestor.type === "system" && ancestor.subtype === "scheduled_task_fire") {
      trigger = "scheduled";
      scheduledFireUuid = ancestor.uuid;
      cursor = ancestor.parentUuid;
    } else if (ancestor.type === "system" && ancestor.subtype === "away_summary") {
      const rec = awaySummaryByUuid.get(ancestor.uuid);
      if (rec) {
        awaySummaryAttached = {
          uuid: ancestor.uuid,
          content: typeof rec.content === "string" ? rec.content : "",
          timestamp: rec.timestamp,
        };
      }
      cursor = ancestor.parentUuid;
    } else {
      break;
    }
    hops += 1;
  }

  // Sanity: if the user record _is_ a fire, capture it directly.
  if (rootUser.parentUuid && scheduledFireByUuid.has(rootUser.parentUuid)) {
    scheduledFireUuid = rootUser.parentUuid;
    trigger = "scheduled";
  }

  const meta: ChatNodeMeta = {
    awaySummary: awaySummaryAttached,
    scheduledFireUuid,
    fileHistorySnapshots:
      fileHistorySnapshots && fileHistorySnapshots.length
        ? fileHistorySnapshots
        : undefined,
    permissionModeChanges: permissionModeChanges.length ? permissionModeChanges : undefined,
  };

  const compactWorkNode = workflow.nodes.find((n) => n.kind === "compact");
  const slashCommand = detectSlashCommand(bucket.records);
  // v0.8: hoist forkedFrom onto the ChatNode. CC `/branch` writes
  // forkedFrom on every record copied into the new fork session, but
  // `messageUuid` is the COPIED RECORD'S OWN uuid (different per
  // record). Only `sessionId` is uniform across the bucket. Hoist:
  //   - sessionId  : from rootUser.forkedFrom (sanity-checked equal
  //                  across bucket; warn on mismatch)
  //   - messageUuid: from rootUser.forkedFrom — points at the source
  //                  bucket's rootUser, the canonical "source ChatNode
  //                  identifier" in the original session
  // Non-fork buckets (no forkedFrom on rootUser) → undefined.
  const forkedFrom = detectForkedFrom(rootUser, bucket);
  return {
    kind: "chat",
    id: bucket.promptId,
    timestamp: rootUser.timestamp,
    parentChatNodeId: null, // filled in linkChatNodeParents
    rootUserUuid: rootUser.uuid ?? "",
    userMessage,
    workflow,
    trigger,
    isCompactSummary: isCompact,
    compactMetadata:
      compactWorkNode && compactWorkNode.kind === "compact" ? compactWorkNode : undefined,
    slashCommand,
    forkedFrom,
    meta,
  };
}

function detectForkedFrom(
  rootUser: RawRecord,
  bucket: PromptBucket,
): { sessionId: string; messageUuid: string } | undefined {
  // The root user record's forkedFrom is the canonical hoist source:
  // its messageUuid (= the record's own preserved uuid) uniquely
  // identifies the source bucket's root in the original session.
  const root = rootUser.forkedFrom;
  if (
    !root ||
    typeof root !== "object" ||
    typeof root.sessionId !== "string" ||
    typeof root.messageUuid !== "string"
  ) {
    return undefined;
  }
  // Sanity-check sessionId consistency across the bucket. CC `/branch`
  // copies all records from one source session, so every record in a
  // copied bucket should share forkedFrom.sessionId. (messageUuid
  // legitimately differs per record — that's the per-record uuid.)
  for (const r of bucket.records) {
    const ff = r.forkedFrom;
    if (
      ff &&
      typeof ff === "object" &&
      typeof ff.sessionId === "string" &&
      ff.sessionId !== root.sessionId
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[parser] inconsistent forkedFrom.sessionId inside bucket ${bucket.promptId}: ` +
          `root=${root.sessionId} vs record=${ff.sessionId} — keeping rootUser's`,
      );
      break;
    }
  }
  return { sessionId: root.sessionId, messageUuid: root.messageUuid };
}

// Detect a slash-command invocation by scanning the bucket's user records
// for <command-name>...</command-name>. Extract args and stdout when
// present; strip ANSI escape codes from stdout.
function detectSlashCommand(records: RawRecord[]) {
  let name: string | undefined;
  let args: string | undefined;
  let stdout: string | undefined;
  for (const r of records) {
    if (r.type !== "user") continue;
    const c = r.message?.content;
    if (typeof c !== "string") continue;
    if (!name) {
      const m = c.match(/<command-name>([^<]*)<\/command-name>/);
      if (m) {
        name = m[1].trim();
        const a = c.match(/<command-args>([^<]*)<\/command-args>/);
        if (a) args = a[1].trim();
      }
    }
    if (!stdout) {
      const so = c.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (so) stdout = stripAnsi(so[1]).trim();
    }
  }
  if (!name) return undefined;
  return { name, args: args || undefined, stdout: stdout || undefined };
}

// Strip CSI / SGR escape sequences (e.g. [1m, [22m, etc.).
// CC's local-command-stdout often embeds these for terminal styling.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function linkChatNodeParents(
  chatNodes: ChatNode[],
  index: Map<string, IndexedRecord>,
  scheduledFireByUuid: Map<string, RawRecord>,
): void {
  // Build uuid → ChatNode id (via root user record) for fast resolution.
  const userUuidToCnId = new Map<string, string>();
  for (const cn of chatNodes) {
    userUuidToCnId.set(cn.rootUserUuid, cn.id);
  }
  // Walk parentUuid backwards from each ChatNode's rootUser.parentUuid until
  // we hit either: (a) a record whose promptId is a different ChatNode id,
  // or (b) null. Bound the walk to defend against malformed chains.
  for (const cn of chatNodes) {
    let cursor: string | null = null;
    const ancestor0 = index.get(cn.rootUserUuid);
    if (!ancestor0) continue;
    cursor = ancestor0.parentUuid;
    let hops = 0;
    while (cursor && hops < 200) {
      const node = index.get(cursor);
      if (!node) break;
      // If we land on a different ChatNode's record, that ChatNode is parent.
      if (node.promptId && node.promptId !== cn.id) {
        cn.parentChatNodeId = node.promptId;
        break;
      }
      // compact_boundary breaks the parentUuid chain (parentUuid=null) but
      // logicalParentUuid points at the pre-compact tail; hop across it so
      // compact ChatNodes resolve a parent.
      if (
        node.type === "system" &&
        node.subtype === "compact_boundary" &&
        !node.parentUuid &&
        node.logicalParentUuid
      ) {
        cursor = node.logicalParentUuid;
        hops += 1;
        continue;
      }
      cursor = node.parentUuid;
      hops += 1;
    }
    // If walk fell off without finding a promptId-bearing ancestor, leave
    // parentChatNodeId=null (root ChatNode of the session).
    void scheduledFireByUuid; // referenced for closure-scope clarity
  }
}

function findScheduleWakeupAncestor(
  fireUuid: string,
  index: Map<string, IndexedRecord>,
  records: RawRecord[],
  scheduleWakeupToolUseIds: Set<string>,
): string | undefined {
  // The fire's parentUuid chain hits some prior turn's tail. The
  // ScheduleWakeup tool_use that *caused* the fire is in some earlier
  // assistant record. Heuristic: the most recent ScheduleWakeup tool_use
  // (by timestamp) prior to the fire's timestamp.
  const fire = index.get(fireUuid);
  if (!fire?.timestamp) {
    // No timestamp, fall back to any known ScheduleWakeup id.
    return scheduleWakeupToolUseIds.values().next().value;
  }
  let bestId: string | undefined;
  let bestTs = "";
  for (const r of records) {
    if (r.type !== "assistant" || !r.timestamp) continue;
    if (r.timestamp >= fire.timestamp) continue;
    for (const b of blocksOf(r)) {
      if (b.type !== "tool_use") continue;
      const tu = b as { id?: string; name?: string };
      if (tu.name !== "ScheduleWakeup" || !tu.id) continue;
      if (!scheduleWakeupToolUseIds.has(tu.id)) continue;
      if (r.timestamp > bestTs) {
        bestTs = r.timestamp;
        bestId = tu.id;
      }
    }
  }
  return bestId;
}

// ─── Convenience: aggregate counts (used by smoke tests / scripts) ───────────

export interface ChatFlowStats {
  chatNodeCount: number;
  delegateCount: number;
  compactCount: number;
  toolCallCount: number;
  llmCallCount: number;
}

export function chatFlowStats(cf: ChatFlow): ChatFlowStats {
  let delegateCount = 0;
  let compactCount = 0;
  let toolCallCount = 0;
  let llmCallCount = 0;
  for (const cn of cf.chatNodes) {
    for (const n of cn.workflow.nodes) {
      switch (n.kind) {
        case "delegate":
          delegateCount += 1;
          break;
        case "compact":
          compactCount += 1;
          break;
        case "tool_call":
          toolCallCount += 1;
          break;
        case "llm_call":
          llmCallCount += 1;
          break;
        default:
          break;
      }
    }
  }
  return {
    chatNodeCount: cf.chatNodes.length,
    delegateCount,
    compactCount,
    toolCallCount,
    llmCallCount,
  };
}

// `extractToolResultBlock` and `isToolResultRecord` referenced by builder via
// re-export for tests' convenience.
export { extractToolResultBlock, isToolResultRecord };
