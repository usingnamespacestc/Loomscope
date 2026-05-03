// `/api/sessions/:id`             — parsed ChatFlow JSON
// `/api/sessions/:id/tool-results/:refId`
//                                   — chunked overflow tool_result text
//
// Session JSONL is located by scanning project subdirs (no sessionId→path
// index yet; v0.2 scan is fast enough). The sidecar directory mirrors
// the JSONL filename without the extension, per design-data-model.md
// "Sidecar 文件机制".

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { parseJsonlFile } from "@/parse/jsonl";

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
    async (c) => {
      const { id } = c.req.valid("param");
      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);
      const result = await parseJsonlFile(jsonlPath);
      return c.json(result.chatFlow);
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

  return app;
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

// Re-export the chunk byte size so frontend / tests share a single
// source of truth (avoids drift between server & client).
export { TOOL_RESULT_CHUNK_BYTES };
