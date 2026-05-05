// `/api/sessions/:id`                          — parsed ChatFlow JSON
// `/api/sessions/:id/tool-results/:refId`      — chunked overflow tool_result text
// `/api/sessions/:id/subagents/:agentId`       — parsed sub-agent ChatFlow JSON
//                                                (?subdir=<name> for grouped runs)
//
// Session JSONL is located by scanning project subdirs (no sessionId→path
// index yet; v0.2 scan is fast enough). The sidecar directory mirrors
// the JSONL filename without the extension, per design-data-model.md
// "Sidecar 文件机制".

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import readline from "node:readline";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { buildChatFlow, parseJsonlFile } from "@/parse/jsonl";
import { parseLine, type RawRecord } from "@/parse/raw-record";
import { SidecarLoader, type AgentMetadata } from "@/parse/sidecar";
import { getOrLoad as getOrLoadCachedChatFlow } from "@/server/services/chatFlowCache";
import { findForkClosure, type ClosureMember } from "@/server/services/forkTree";
import {
  sidecarSubagentsDir,
  watchSessionClosure,
  unwatchSession,
} from "@/server/services/sessionWatcher";
import {
  subscribe,
  subscriberCount,
  type SseSubscriber,
} from "@/server/services/sseHub";
import type { ChatFlow } from "@/data/types";

// Heartbeat cadence. Two reasons it exists:
//   1) Reverse proxies (nginx default 60s) close idle SSE — sub-60s
//      pings keep the connection warm.
//   2) Lets us notice a half-open socket: writeSSE rejects, the catch
//      tears down. Without ping a dead client could linger until next
//      real broadcast.
// 25 s is the conventional value (well under typical 60 s proxy
// timeouts, infrequent enough that overhead is negligible).
const SSE_HEARTBEAT_MS = 25_000;

export interface SessionsRouteOptions {
  rootDir: string;
}

const SESSION_ID_RE = /^[a-f0-9-]{8,}$/i;
// Tool-result overflow refIds (CC's ContentReplacementRecord IDs) are
// safe filename chars only — letters, digits, dash, underscore. The
// regex blocks dot / slash / backslash / null up front so a malformed
// ``..%2F`` payload can't even reach the path joiner. We additionally
// guard with a resolved-prefix check below — defense in depth.
const TOOL_RESULT_REF_ID_RE = /^[A-Za-z0-9_-]+$/;
// Sub-agent IDs follow CC's recordSidechainTranscript() naming:
// hex string (regular sub-agents) or ``acompact-<hex>`` /
// ``aside_question-<hex>`` for harness-spawned variants. Same safe-
// charset constraint applies; subdir (optional) is a folder name and
// gets the same treatment.
const SUB_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

// Default chunk size for tool-result overflow streaming (200 KB). The
// frontend reads the first chunk synchronously into the panel and
// fetches subsequent chunks as the user scrolls. 200 KB is the size
// that comfortably fits a typical Read-tool result without a paint
// pause and matches the ``handoff-v0.4-drill-panel.md`` size budget.
const TOOL_RESULT_CHUNK_BYTES = 200 * 1024;

export interface ToolResultChunkResponse {
  refId: string;
  // The decoded UTF-8 chunk. Multi-byte characters at the chunk
  // boundary are handled by reading on byte offsets; the chunk may
  // end mid-character — the reader emits invalid byte sequences as
  // U+FFFD replacement. The frontend should re-parse on chunk join.
  content: string;
  // Byte offsets of the chunk within the file.
  start: number;
  end: number; // exclusive, == start + content.byteLength
  totalSize: number;
  hasMore: boolean;
}

export function sessionsRouter(opts: SessionsRouteOptions) {
  const app = new Hono();

  app.get(
    "/:id",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    zValidator(
      "query",
      z.object({
        // v0.10 polish (lazy ChatFlow B1): `?full=true` opts back into
        // the historical full-fat response (workflow.nodes inline).
        // Default is the lite shape — workflow.nodes / workflow.edges
        // stripped, summary inlined; client lazy-fetches workflow on
        // demand via /chatnodes/workflows. Escape hatch stays through
        // v0.10 stabilisation; remove before v1.0.
        full: z.enum(["true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      const { full } = c.req.valid("query");
      const wantsFull = full === "true";
      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);
      const projectDir = path.dirname(jsonlPath);
      const closure = await findForkClosure({
        projectDir,
        entrySessionId: id,
      });
      // LRU cache stores the FULL ChatFlow internally; both the lite
      // and full responses are derived views of the same cached
      // object. Cache key = (sessionId, closure mtimes), invalidating
      // on any underlying jsonl change (v0.9 file-tail will piggyback
      // on this same signal).
      const { chatFlow } = await getOrLoadCachedChatFlow({
        sessionId: id,
        closure,
        fallbackJsonlPath: jsonlPath,
        loader: () =>
          loadMergedChatFlow({
            entryJsonlPath: jsonlPath,
            entrySessionId: id,
            closure,
          }),
      });
      return c.json(wantsFull ? chatFlow : stripChatFlowToLite(chatFlow));
    },
  );

  // v0.10 polish (lazy ChatFlow B1): batch fetch of workflow.nodes /
  // workflow.edges for a set of ChatNode ids. Read-only data lookup
  // — keeping it as GET both matches HTTP semantics and bypasses
  // CSRF (which is intended for mutations). IDs travel as a
  // comma-separated query param (`?ids=uuid1,uuid2,...`); typical URL
  // budget is 8 KB which fits ~200 36-char uuids. Clients with more
  // should batch in chunks of ~100 to leave headroom.
  //
  // Response shape: `{ workflows: { "uuid1": { nodes, edges }, ... } }`.
  // Missing ids (typo / stale) are silently omitted — client should
  // treat absence as "not found, don't retry". Reads from the same
  // LRU cache the lite endpoint uses, so typically zero parse cost.
  app.get(
    "/:id/chatnodes/workflows",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    zValidator(
      "query",
      z.object({
        ids: z.string().min(1),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid("param");
      const { ids: idsStr } = c.req.valid("query");
      const ids = idsStr.split(",").filter(Boolean);
      if (ids.length === 0) return c.json({ error: "no ids" }, 400);
      if (ids.length > 200) return c.json({ error: "too many ids (max 200)" }, 400);
      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);
      const projectDir = path.dirname(jsonlPath);
      const closure = await findForkClosure({
        projectDir,
        entrySessionId: id,
      });
      const { chatFlow } = await getOrLoadCachedChatFlow({
        sessionId: id,
        closure,
        fallbackJsonlPath: jsonlPath,
        loader: () =>
          loadMergedChatFlow({
            entryJsonlPath: jsonlPath,
            entrySessionId: id,
            closure,
          }),
      });
      const wanted = new Set(ids);
      const workflows: Record<
        string,
        { nodes: ChatFlow["chatNodes"][number]["workflow"]["nodes"]; edges: ChatFlow["chatNodes"][number]["workflow"]["edges"] }
      > = {};
      for (const cn of chatFlow.chatNodes) {
        if (!wanted.has(cn.id)) continue;
        workflows[cn.id] = {
          nodes: cn.workflow.nodes,
          edges: cn.workflow.edges,
        };
      }
      return c.json({ workflows });
    },
  );

  // v0.9 file-tail spike: SSE stream for live invalidation.
  //
  // Connect → server resolves the session's fork closure, asks the
  // watcher to monitor every closure jsonl path, subscribes this
  // connection to the SSE hub. On any underlying file `change`, the
  // watcher invalidates the LRU cache + broadcasts an `invalidate`
  // event; this stream forwards it as `event: invalidate`. Client
  // reacts by re-fetching the lite ChatFlow and clearing the
  // workflowCache so lazy hooks refetch.
  //
  // Heartbeat every 25 s; client treats it as a no-op.
  //
  // Disconnect: stream.onAbort tears down the subscriber. If this was
  // the last subscriber for this session, we also drop the session's
  // path watches (other sessions sharing the same paths via fork
  // closure keep them alive).
  //
  // GET-only ⇒ skips CSRF middleware; safe because the endpoint is
  // read-only data delivery (no state mutation beyond the watcher
  // refcount, which is server-internal).
  app.get(
    "/:id/events",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);
      const projectDir = path.dirname(jsonlPath);
      const closure = await findForkClosure({
        projectDir,
        entrySessionId: id,
      });
      const closurePaths =
        closure.length > 0 ? closure.map((m) => m.jsonlPath) : [jsonlPath];
      // Watcher auto-extends each main jsonl to its sidecar `subagents/`
      // dir — caller doesn't have to enumerate sub-agents.
      watchSessionClosure(id, closurePaths);
      const sidecarDirs = closurePaths.map(sidecarSubagentsDir);
      return streamSSE(c, async (stream) => {
        const sub: SseSubscriber = {
          send: (msg) => {
            void stream
              .writeSSE({
                event: msg.event,
                data: JSON.stringify(msg.data),
              })
              .catch(() => {
                // If the write fails the stream is already gone; the
                // onAbort handler will run shortly.
              });
          },
        };
        const unsubscribe = subscribe(id, sub);
        stream.onAbort(() => {
          unsubscribe();
          if (subscriberCount(id) === 0) unwatchSession(id);
        });
        await stream.writeSSE({
          event: "hello",
          data: JSON.stringify({
            sessionId: id,
            watching: { main: closurePaths, sidecar: sidecarDirs },
          }),
        });
        // Heartbeat loop. stream.sleep is abort-aware; the while-loop
        // exits on disconnect and the onAbort handler fires.
        while (!stream.aborted) {
          await stream.sleep(SSE_HEARTBEAT_MS);
          if (stream.aborted) break;
          await stream
            .writeSSE({ event: "ping", data: "{}" })
            .catch(() => {});
        }
      });
    },
  );

  // Chunked tool-result overflow loader. Default returns the first
  // 200 KB starting at byte 0. The frontend can paginate through the
  // file by passing ``?start=<byte-offset>`` to fetch the next slice
  // (matches the lazy-load-on-scroll pattern in DrillPanel).
  //
  // Two-layer path-traversal guard:
  //   1. zod regex on refId rejects anything outside [A-Za-z0-9_-]
  //   2. resolved path must live under ``<sidecarDir>/tool-results/``
  //      — if path.resolve gives something outside, return 400
  app.get(
    "/:id/tool-results/:refId",
    zValidator(
      "param",
      z.object({
        id: z.string().regex(SESSION_ID_RE),
        refId: z.string().regex(TOOL_RESULT_REF_ID_RE),
      }),
    ),
    zValidator(
      "query",
      z.object({
        start: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .transform((v) => (v == null ? 0 : Number(v))),
      }),
    ),
    async (c) => {
      const { id, refId } = c.req.valid("param");
      const { start } = c.req.valid("query");

      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);

      // Sidecar dir = the directory next to <sid>.jsonl named <sid>.
      const sidecarDir = jsonlPath.replace(/\.jsonl$/, "");
      const toolResultsDir = path.join(sidecarDir, "tool-results");
      const candidate = path.join(toolResultsDir, `${refId}.txt`);
      const resolved = path.resolve(candidate);
      // Path traversal guard 2: the resolved absolute path MUST start
      // with the resolved tool-results dir + path separator. Catches
      // any ``..`` games the regex might have missed (it shouldn't
      // — but belt and suspenders).
      const resolvedDir = path.resolve(toolResultsDir) + path.sep;
      if (!resolved.startsWith(resolvedDir)) {
        return c.json({ error: "invalid refId" }, 400);
      }

      let stat;
      try {
        stat = await fsp.stat(resolved);
      } catch {
        return c.json({ error: "tool-result not found" }, 404);
      }
      if (!stat.isFile()) {
        return c.json({ error: "tool-result not found" }, 404);
      }

      const totalSize = stat.size;
      if (start < 0 || start > totalSize) {
        return c.json({ error: "start out of range" }, 416);
      }

      const end = Math.min(start + TOOL_RESULT_CHUNK_BYTES, totalSize);
      const buf = Buffer.alloc(end - start);
      const fh = await fsp.open(resolved, "r");
      try {
        await fh.read(buf, 0, end - start, start);
      } finally {
        await fh.close();
      }

      const body: ToolResultChunkResponse = {
        refId,
        // toString('utf8') replaces invalid byte sequences at chunk
        // boundary with U+FFFD; acceptable for a viewer (worst case is
        // one corrupted char per chunk join).
        content: buf.toString("utf8"),
        start,
        end,
        totalSize,
        hasMore: end < totalSize,
      };
      return c.json(body);
    },
  );

  // Sub-agent sidecar loader. Returns the parsed ChatFlow JSON for one
  // sub-agent jsonl, plus its meta.json (when available). Used by v0.5
  // right-click-to-drill into sub-agent's WorkFlow.
  //
  // Same two-layer path-traversal guard as tool-results:
  //   1. zod regex restricts agentId / subdir to [A-Za-z0-9_-]
  //   2. resolved jsonl path must live under <sidecarDir>/subagents/
  app.get(
    "/:id/subagents/:agentId",
    zValidator(
      "param",
      z.object({
        id: z.string().regex(SESSION_ID_RE),
        agentId: z.string().regex(SUB_AGENT_ID_RE),
      }),
    ),
    zValidator(
      "query",
      z.object({
        // Optional grouping subdir (CC's setAgentTranscriptSubdir for
        // workflow-runs etc.). Same charset limit as agentId.
        subdir: z.string().regex(SUB_AGENT_ID_RE).optional(),
      }),
    ),
    async (c) => {
      const { id, agentId } = c.req.valid("param");
      const { subdir } = c.req.valid("query");

      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);

      const sidecarDir = jsonlPath.replace(/\.jsonl$/, "");
      const loader = new SidecarLoader(sidecarDir);
      const jsonlAbs = path.resolve(loader.subAgentJsonlPath(agentId, subdir));
      const subagentsRoot = path.resolve(path.join(sidecarDir, "subagents")) + path.sep;
      // Path traversal guard 2: resolved path must sit under subagents/.
      if (!jsonlAbs.startsWith(subagentsRoot)) {
        return c.json({ error: "invalid agentId" }, 400);
      }

      const stat = await fsp.stat(jsonlAbs).catch(() => null);
      if (!stat?.isFile()) {
        return c.json({ error: "sub-agent not found" }, 404);
      }

      let chatFlow: ChatFlow;
      try {
        const result = await parseJsonlFile(jsonlAbs);
        chatFlow = result.chatFlow;
      } catch (err) {
        return c.json(
          { error: "parse failed", message: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
      // meta.json is optional — fall through silently when absent.
      const meta: AgentMetadata | null = await loader
        .loadAgentMetadata(agentId, subdir)
        .catch(() => null);

      const body: SubAgentResponse = { agentId, subdir: subdir ?? null, chatFlow, meta };
      return c.json(body);
    },
  );

  return app;
}

export interface SubAgentResponse {
  agentId: string;
  subdir: string | null;
  chatFlow: ChatFlow;
  meta: AgentMetadata | null;
}

async function locateSessionJsonl(rootDir: string, sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const dir of entries) {
    const candidate = path.join(rootDir, dir, `${sessionId}.jsonl`);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

// v0.8: load + merge a fork closure into a single ChatFlow.
//
// Strategy: read each closure jsonl's records, concatenate in BFS
// closure order (= entry first, then BFS members), dedupe by `uuid`
// keeping the FIRST occurrence — the entry session's records win when
// the entry IS the original (its records have no forkedFrom marker);
// when the entry is a fork session, its forkedFrom-marked copies win
// over the original's plain records (per "first wins"). Either way
// the merged ChatFlow keeps each uuid exactly once.
//
// CustomTitle policy: hoisted from the ENTRY session's parsed
// chatFlow.customTitle — semantically "the title of the session you
// clicked." linkedSessions = all closure sessionIds in BFS order.
//
// When closure is empty (= no fork relations, single jsonl), this
// degenerates to v0.7's parseJsonlFile behavior with linkedSessions
// kept undefined to signal "non-merged."
async function loadMergedChatFlow(args: {
  entryJsonlPath: string;
  entrySessionId: string;
  closure: ClosureMember[];
}): Promise<ChatFlow> {
  const { entryJsonlPath, entrySessionId, closure } = args;
  // Single-session shortcut: closure either empty (entry not located by
  // forkTree, shouldn't happen here since we just resolved the path)
  // or exactly [entry] with no other members. Still go through merge
  // path so linkedSessions / customTitle handling stays uniform.
  if (closure.length <= 1) {
    const result = await parseJsonlFile(entryJsonlPath);
    // linkedSessions stays undefined when the session has no fork
    // relations — signals "single-session, not a merge product."
    return result.chatFlow;
  }
  // Read all closure jsonls' records in BFS order (entry first).
  const recordsByMember: Array<{ sessionId: string; records: RawRecord[] }> = [];
  for (const m of closure) {
    const records = await readAllRecords(m.jsonlPath);
    recordsByMember.push({ sessionId: m.sessionId, records });
  }
  // uuid-dedup, keep first occurrence — implicit by walking in order.
  const seenUuids = new Set<string>();
  const merged: RawRecord[] = [];
  for (const { records } of recordsByMember) {
    for (const r of records) {
      if (r.uuid && seenUuids.has(r.uuid)) continue;
      if (r.uuid) seenUuids.add(r.uuid);
      merged.push(r);
    }
  }
  const chatFlow = buildChatFlow(merged, entryJsonlPath);
  // Override the parser's choices: the merge is keyed off the entry
  // session, so:
  //   - id stays as the entry sessionId (parser may have picked another
  //     by accident if records are out of order)
  //   - linkedSessions = closure BFS order
  //   - customTitle stays as whatever parser found (first-wins on the
  //     merged record stream — entry session's title wins when present)
  chatFlow.id = entrySessionId;
  chatFlow.linkedSessions = closure.map((m) => m.sessionId);
  return chatFlow;
}

// Read every record from a jsonl as parsed RawRecord[]. Used by the
// merge step instead of parseJsonlFile (which would invoke the parser
// per-file then we'd need to re-merge ChatFlows — not faithful to
// uuid-dedup semantics). Streaming avoids buffering the whole file in
// memory at once.
async function readAllRecords(jsonlPath: string): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = parseLine(line);
    if (r) records.push(r);
  }
  return records;
}

// Re-export the chunk byte size so frontend / tests share a single
// source of truth (avoids drift between server & client).
export { TOOL_RESULT_CHUNK_BYTES };

// v0.10 polish (lazy ChatFlow B1): clone a parsed ChatFlow with each
// ChatNode's workflow stripped of nodes / edges. The summary stays
// inline so canvas card / fold projection still have everything they
// need; nodes/edges arrive lazily via /chatnodes/workflows. Object
// identity is preserved for everything except chatNodes (and within
// each ChatNode, the workflow object) — keeps GC pressure low and
// lets the LRU cache hand out the original chatNodes without
// worrying about clients mutating them.
export function stripChatFlowToLite(chatFlow: ChatFlow): ChatFlow {
  return {
    ...chatFlow,
    chatNodes: chatFlow.chatNodes.map((cn) => ({
      ...cn,
      workflow: {
        // Summary may be undefined for a freshly-parsed ChatFlow whose
        // computeWorkflowSummary call hasn't run (test fixtures, hand-
        // built flows, etc.). Default to a zero-shaped summary so the
        // wire format is always well-formed.
        summary: cn.workflow.summary ?? {
          assistantPreview: "",
          llmCount: 0,
          chainCount: 0,
          toolCount: 0,
          totalThinkingChars: 0,
          contextTokens: 0,
          maxContextTokens: 200_000,
          toolUseFilePaths: [],
        },
        // Empty arrays signal "lite" without introducing a separate
        // discriminant; client checks `nodes.length === 0` alongside
        // `summary.llmCount > 0` to detect "needs lazy load." Keeping
        // them as required arrays avoids cascading optional-types
        // through every existing consumer in B1; B3 will fully
        // optional-ize once consumers migrate.
        nodes: [],
        edges: [],
      },
    })),
  };
}
