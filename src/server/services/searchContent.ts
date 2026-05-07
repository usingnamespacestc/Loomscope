// v0.11 Phase 2 — session-content search.
//
// Streams the session's main jsonl + sidecar sub-agent jsonls,
// matches `q` (substring, case-insensitive by default) against the
// text fields each record kind exposes, and returns up to `limit`
// hits with snippet context.
//
// Why linear scan over an FTS index for v1:
// - Most CC sessions are < 10 MB; grep takes ~50-200 ms.
// - 256 MB sessions take ~500-800 ms which is still acceptable for
//   "I just typed and hit enter" UX, especially behind the 300 ms
//   typing-debounce.
// - FTS index would add a sqlite dep + per-session build time + cache
//   invalidation logic. Not worth it until we measure pain.
//
// Search corpus per record kind:
// - user record: message.content (string OR block array's text fields)
// - assistant record: message.content[*].text (text blocks),
//   message.content[*].thinking (thinking blocks),
//   message.content[*].input (tool_use blocks — JSON.stringify),
//   tool_use blocks themselves don't carry visible text the user'd
//   search for; we DO scan input for things like file paths.
// - tool_result blocks (inside user records): up to first 500 chars
//   of the .content text. Full chunked-overflow content is NOT
//   scanned (256 MB sessions can have 5 MB single tool_results).
// - file-history-snapshot, system, attachment etc. records: skipped
//   (no human-meaningful text).
//
// Sidecar sub-agents: scanned via the SidecarLoader's sub-agent
// jsonl list. Same parser. Hits get marked with `subAgentId` so
// the UI can route the jump correctly (drill into sub-agent).

import * as fs from "node:fs/promises";
import * as fsCb from "node:fs";
import * as readline from "node:readline";

import type { RawRecord } from "@/parse/raw-record";
import { parseLine } from "@/parse/raw-record";

export type SearchRole = "user" | "assistant" | "tool" | "thinking";

export interface ContentSearchHit {
  /** uuid of the record where the match landed (jsonl record uuid). */
  recordUuid: string;
  /** promptId of the bucket = ChatNode id. */
  chatNodeId: string;
  /** Role badge for the UI hit row. */
  role: SearchRole;
  /** Optional secondary kind detail (e.g. tool name "Bash"). */
  kindDetail?: string;
  /** Snippet text with ~80 chars context on each side, suffix ellipsis
   *  if truncated. */
  snippet: string;
  /** Byte offsets of the match within the snippet (so the UI can
   *  highlight without re-running the query). */
  matchStart: number;
  matchEnd: number;
  /** When the hit lives inside a sub-agent jsonl, this is its agent
   *  id (the SidecarLoader naming `agent-<id>`). null = main jsonl. */
  subAgentId?: string;
  /** Wall-clock timestamp of the matching record. Drives the
   *  newest-first sort applied before the result is trimmed to
   *  `limit`. Empty string for records lacking timestamp (shouldn't
   *  happen in real CC jsonls but defensive). */
  timestamp: string;
}

export interface ContentSearchResult {
  hits: ContentSearchHit[];
  truncated: boolean;
  scannedRecords: number;
  /** ms */
  durationMs: number;
}

interface SearchOptions {
  q: string;
  caseSensitive?: boolean;
  limit?: number;
  /** Hard cap on bytes scanned across all jsonl files combined.
   *  Defends against pathological huge sessions. */
  maxBytes?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024; // 512 MB
const SNIPPET_CONTEXT_CHARS = 80;
const TOOL_RESULT_PREVIEW_CHARS = 500;
// Safety cap on hits collected before sorting. Without this a session
// with thousands of matches could OOM. 5000 hits × ~300 bytes/hit ≈
// 1.5 MB, comfortable.
const COLLECT_CAP = 5_000;

/** Find first match offset of `needle` in `haystack`. */
function indexOf(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): number {
  if (!needle) return -1;
  if (caseSensitive) return haystack.indexOf(needle);
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function makeSnippet(
  text: string,
  matchOffset: number,
  needleLen: number,
): { snippet: string; matchStart: number; matchEnd: number } {
  const start = Math.max(0, matchOffset - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(
    text.length,
    matchOffset + needleLen + SNIPPET_CONTEXT_CHARS,
  );
  let snippet = text.slice(start, end);
  let prefix = "";
  let suffix = "";
  if (start > 0) prefix = "…";
  if (end < text.length) suffix = "…";
  // Collapse internal whitespace runs to a single space so multi-line
  // matches stay readable in a 1-line hit row. Preserves the offsets
  // by working AFTER computing them.
  snippet = snippet.replace(/\s+/g, " ");
  const matchStart = prefix.length + (matchOffset - start);
  const matchEnd = matchStart + needleLen;
  return {
    snippet: prefix + snippet + suffix,
    matchStart,
    matchEnd,
  };
}

/** Build uuid → promptId map for parent resolution. Single pass. */
async function buildUuidToPromptId(jsonlPath: string): Promise<{
  uuidToPromptId: Map<string, string>;
  uuidToParentUuid: Map<string, string>;
}> {
  const uuidToPromptId = new Map<string, string>();
  const uuidToParentUuid = new Map<string, string>();
  let stream: NodeJS.ReadableStream;
  try {
    stream = fsCb.createReadStream(jsonlPath, { encoding: "utf8" });
  } catch {
    return { uuidToPromptId, uuidToParentUuid };
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: RawRecord | null;
    try {
      r = parseLine(line);
    } catch {
      continue;
    }
    if (!r) continue;
    const uuid = (r as { uuid?: string }).uuid;
    if (!uuid) continue;
    const pid = (r as { promptId?: string }).promptId;
    if (pid) uuidToPromptId.set(uuid, pid);
    const parent = (r as { parentUuid?: string | null }).parentUuid;
    if (parent) uuidToParentUuid.set(uuid, parent);
  }
  return { uuidToPromptId, uuidToParentUuid };
}

/** Walk parentUuid chain (≤5 hops) to find the bucket promptId. */
function resolvePromptId(
  uuid: string,
  uuidToPromptId: Map<string, string>,
  uuidToParentUuid: Map<string, string>,
  hopsBudget = 5,
): string {
  let cur: string | undefined = uuid;
  let hops = 0;
  while (cur && hops < hopsBudget) {
    const pid = uuidToPromptId.get(cur);
    if (pid) return pid;
    cur = uuidToParentUuid.get(cur);
    hops += 1;
  }
  return uuid;
}

/** Scan a single jsonl path. Yields hits as it goes. */
async function* scanJsonl(args: {
  jsonlPath: string;
  q: string;
  caseSensitive: boolean;
  bytesBudget: { remaining: number };
  subAgentId?: string;
  uuidToPromptId: Map<string, string>;
  uuidToParentUuid: Map<string, string>;
}): AsyncGenerator<ContentSearchHit> {
  if (args.bytesBudget.remaining <= 0) return;
  let stat: { size: number };
  try {
    stat = await fs.stat(args.jsonlPath);
  } catch {
    return;
  }
  // Track approx bytes; readline doesn't give exact offsets but the
  // file size minus what we've consumed is a reasonable proxy.
  args.bytesBudget.remaining -= stat.size;
  const stream = fsCb.createReadStream(args.jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: RawRecord | null;
    try {
      r = parseLine(line);
    } catch {
      continue;
    }
    if (!r) continue;
    for (const hit of matchRecord(r, args.q, args.caseSensitive, args.subAgentId)) {
      // Resolve assistant/tool hits' chatNodeId from parentUuid hint
      // up the chain to the actual bucket promptId.
      if (hit.role !== "user") {
        const resolved = resolvePromptId(
          hit.chatNodeId,
          args.uuidToPromptId,
          args.uuidToParentUuid,
        );
        if (resolved) hit.chatNodeId = resolved;
      }
      yield hit;
    }
  }
}

function* matchRecord(
  r: RawRecord,
  q: string,
  caseSensitive: boolean,
  subAgentId: string | undefined,
): Generator<ContentSearchHit> {
  const recordUuid = (r as { uuid?: string }).uuid ?? "";
  const promptId = (r as { promptId?: string }).promptId ?? "";
  const timestamp = (r as { timestamp?: string }).timestamp ?? "";
  // Resolved chatNodeId — for assistant/tool_result records that
  // lack their own promptId, the caller should resolve via
  // parentUuid hop. For v1 we only emit hits whose record carries
  // promptId directly (= user records). Other records' hits are
  // attributed via best-effort fallback to record.parentUuid (caller
  // filters/coalesces in the UI).
  if (r.type === "user") {
    yield* matchUserRecord(r, q, caseSensitive, recordUuid, promptId, subAgentId, timestamp);
    return;
  }
  if (r.type === "assistant") {
    yield* matchAssistantRecord(
      r,
      q,
      caseSensitive,
      recordUuid,
      // Assistant records don't carry promptId; we fall back to
      // parentUuid as a "search hint" — the UI's resolveParentChatNode
      // logic will refine on the click jump.
      ((r as { parentUuid?: string | null }).parentUuid ?? "") || "",
      subAgentId,
      timestamp,
    );
    return;
  }
  // attachment / file-history-snapshot / system / etc. — skip
}

function* matchUserRecord(
  r: RawRecord,
  q: string,
  caseSensitive: boolean,
  recordUuid: string,
  promptId: string,
  subAgentId: string | undefined,
  timestamp: string,
): Generator<ContentSearchHit> {
  const msg = (r as { message?: { content?: unknown } }).message;
  if (!msg) return;
  const content = msg.content;
  if (typeof content === "string") {
    const idx = indexOf(content, q, caseSensitive);
    if (idx >= 0) {
      const s = makeSnippet(content, idx, q.length);
      yield {
        recordUuid,
        chatNodeId: promptId,
        role: "user",
        snippet: s.snippet,
        matchStart: s.matchStart,
        matchEnd: s.matchEnd,
        ...(subAgentId ? { subAgentId } : {}),
        timestamp,
      };
    }
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; content?: unknown; tool_use_id?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      const idx = indexOf(b.text, q, caseSensitive);
      if (idx >= 0) {
        const s = makeSnippet(b.text, idx, q.length);
        yield {
          recordUuid,
          chatNodeId: promptId,
          role: "user",
          snippet: s.snippet,
          matchStart: s.matchStart,
          matchEnd: s.matchEnd,
          ...(subAgentId ? { subAgentId } : {}),
          timestamp,
        };
      }
    } else if (b.type === "tool_result") {
      const txt = extractToolResultText(b.content);
      if (!txt) continue;
      const preview = txt.slice(0, TOOL_RESULT_PREVIEW_CHARS);
      const idx = indexOf(preview, q, caseSensitive);
      if (idx >= 0) {
        const s = makeSnippet(preview, idx, q.length);
        yield {
          recordUuid,
          chatNodeId: promptId,
          role: "tool",
          kindDetail: "result",
          snippet: s.snippet,
          matchStart: s.matchStart,
          matchEnd: s.matchEnd,
          ...(subAgentId ? { subAgentId } : {}),
          timestamp,
        };
      }
    }
  }
}

function* matchAssistantRecord(
  r: RawRecord,
  q: string,
  caseSensitive: boolean,
  recordUuid: string,
  parentUuidHint: string,
  subAgentId: string | undefined,
  timestamp: string,
): Generator<ContentSearchHit> {
  const msg = (r as { message?: { content?: unknown } }).message;
  if (!msg) return;
  const blocks = msg.content;
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
      input?: unknown;
      id?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      const idx = indexOf(b.text, q, caseSensitive);
      if (idx >= 0) {
        const s = makeSnippet(b.text, idx, q.length);
        yield {
          recordUuid,
          chatNodeId: parentUuidHint, // search hint; UI refines
          role: "assistant",
          snippet: s.snippet,
          matchStart: s.matchStart,
          matchEnd: s.matchEnd,
          ...(subAgentId ? { subAgentId } : {}),
          timestamp,
        };
      }
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      const idx = indexOf(b.thinking, q, caseSensitive);
      if (idx >= 0) {
        const s = makeSnippet(b.thinking, idx, q.length);
        yield {
          recordUuid,
          chatNodeId: parentUuidHint,
          role: "thinking",
          snippet: s.snippet,
          matchStart: s.matchStart,
          matchEnd: s.matchEnd,
          ...(subAgentId ? { subAgentId } : {}),
          timestamp,
        };
      }
    } else if (b.type === "tool_use") {
      const inp = b.input;
      if (!inp || typeof inp !== "object") continue;
      const json = JSON.stringify(inp);
      const idx = indexOf(json, q, caseSensitive);
      if (idx >= 0) {
        const s = makeSnippet(json, idx, q.length);
        yield {
          recordUuid,
          chatNodeId: parentUuidHint,
          role: "tool",
          kindDetail: typeof b.name === "string" ? b.name : "tool_use",
          snippet: s.snippet,
          matchStart: s.matchStart,
          matchEnd: s.matchEnd,
          ...(subAgentId ? { subAgentId } : {}),
          timestamp,
        };
      }
    }
  }
}

function extractToolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as { type?: unknown; text?: unknown };
    if (blk.type === "text" && typeof blk.text === "string") {
      parts.push(blk.text);
    }
  }
  return parts.join("\n") || null;
}

/** Top-level search entrypoint. */
export async function searchSessionContent(args: {
  /** Main jsonl path. */
  mainJsonlPath: string;
  /** Sub-agent sidecar jsonl paths (relative or absolute). Empty array
   *  if not scanning sub-agents. */
  sidecarJsonlPaths: Array<{ path: string; agentId: string }>;
  options: SearchOptions;
}): Promise<ContentSearchResult> {
  const { q, caseSensitive = false, limit = DEFAULT_LIMIT, maxBytes = DEFAULT_MAX_BYTES } = args.options;
  const start = Date.now();
  const hits: ContentSearchHit[] = [];
  let scannedRecords = 0;
  const bytesBudget = { remaining: maxBytes };
  let truncated = false;

  // Pass 1: build uuid → promptId map for parent resolution. Cheap
  // (~150 KB for 1500-record sessions). Done per jsonl since each
  // jsonl is a self-contained namespace.
  // Pass 2: scan + collect ALL hits up to COLLECT_CAP. We can't
  // early-stop at `limit` because the user wants newest-first
  // ordering — that requires knowing all hits before trimming.
  const mainMaps = await buildUuidToPromptId(args.mainJsonlPath);
  for await (const hit of scanJsonl({
    jsonlPath: args.mainJsonlPath,
    q,
    caseSensitive,
    bytesBudget,
    uuidToPromptId: mainMaps.uuidToPromptId,
    uuidToParentUuid: mainMaps.uuidToParentUuid,
  })) {
    scannedRecords += 1;
    hits.push(hit);
    if (hits.length >= COLLECT_CAP) {
      truncated = true;
      break;
    }
  }
  if (!truncated) {
    for (const { path: p, agentId } of args.sidecarJsonlPaths) {
      if (truncated) break;
      const sidecarMaps = await buildUuidToPromptId(p);
      for await (const hit of scanJsonl({
        jsonlPath: p,
        q,
        caseSensitive,
        bytesBudget,
        subAgentId: agentId,
        uuidToPromptId: sidecarMaps.uuidToPromptId,
        uuidToParentUuid: sidecarMaps.uuidToParentUuid,
      })) {
        scannedRecords += 1;
        hits.push(hit);
        if (hits.length >= COLLECT_CAP) {
          truncated = true;
          break;
        }
      }
    }
  }

  // Sort newest-first by record timestamp, then trim to `limit`.
  // Truncation flag flips on if either (a) we hit COLLECT_CAP during
  // scan or (b) we collected > limit (= user can refine to see more).
  hits.sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp < b.timestamp ? 1 : -1;
  });
  const trimmedTruncated = truncated || hits.length > limit;
  const trimmed = hits.slice(0, limit);

  return {
    hits: trimmed,
    truncated: trimmedTruncated,
    scannedRecords,
    durationMs: Date.now() - start,
  };
}
