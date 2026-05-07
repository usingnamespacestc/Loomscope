// `/api/search/uuid?q=<prefix>` — find a session / ChatNode / WorkNode
// by its uuid (full or prefix). Powers the sidebar's 🎯 "jump by id"
// mode. Returns up to 10 candidate hits with enough context for the
// user to disambiguate (cwd, parent ChatNode preview, kind).
//
// Strategy:
//   1. Filename match: project dirs under rootDir contain `<sid>.jsonl`.
//      A prefix that matches a filename = session id hit. Cheap.
//   2. Content match: spawn `grep -lF '"uuid":"<prefix>'` across all
//      jsonl files. Returns the file paths that contain at least one
//      matching record. We then read JUST the matching lines (a second
//      `grep -F`) to extract the record type + parent context. Cheap
//      per file even for large jsonls because grep stops at the first
//      bytes after each newline that mismatch.
//
// Both steps stop early once the combined hit count reaches 10.
//
// Race handling: the request handler doesn't try to abort an in-flight
// grep when a newer request arrives. The browser-side AbortController
// drops the now-stale response; the wasted CPU on the abandoned grep
// is small (1-3 s on ~4 GB jsonl) and not worth the spawn-tracking
// complexity. See devlog.md handoff for the dual-track decision.
//
// 中: 输入 uuid 完整或 8+ 字符 prefix → grep filename + grep file
// 内容，返回 ≤10 个候选（含 type / cwd / 父节点预览）。前端 abort
// 不传播到后端，依赖浏览器 fetch abort + 后端跑完丢弃结果。

import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

export interface SearchRouteOptions {
  rootDir: string;
}

const MAX_HITS = 10;
// Minimum hex prefix length to trigger search. Shorter inputs are
// rejected because (a) every uuid contains all 16 hex digits in
// random order so a 1-3 char hex prefix would explode the result
// set, and (b) the front-end already routes shorter inputs to the
// 📁 filter mode for live sidebar narrowing.
const MIN_PREFIX_LEN = 8;

const HEX_PREFIX_RE = /^[0-9a-f]{8,}(-[0-9a-f]+)*$/i;

export type SearchHit =
  | {
      type: "session";
      sessionId: string;
      cwd: string;
      lastModified: string | null;
    }
  | {
      type: "chatnode";
      sessionId: string;
      chatNodeId: string; // promptId
      cwd: string;
      preview: string; // user message preview, ≤ 60 char
    }
  | {
      type: "worknode";
      sessionId: string;
      // workNode lives inside a ChatNode workflow; we surface the
      // parent ChatNode id so the front-end can drill in. We don't
      // compute it on the server — the front-end can resolve it on
      // demand from the loaded ChatFlow if needed.
      workNodeId: string;
      cwd: string;
      kindHint: "assistant" | "user" | "attachment" | "system" | "unknown";
      preview: string; // first 60 char of message text / attachment kind
    };

export function searchRouter(opts: SearchRouteOptions) {
  const app = new Hono();

  app.get(
    "/uuid",
    zValidator(
      "query",
      z.object({
        q: z.string().min(1),
      }),
    ),
    async (c) => {
      const { q } = c.req.valid("query");
      const trimmed = q.trim().toLowerCase();
      if (trimmed.length < MIN_PREFIX_LEN) {
        return c.json({
          hits: [],
          truncated: false,
          tooShort: true,
        });
      }
      // Reject inputs containing non-hex (besides dashes). A user that
      // wants to filter by free text should be using the 📁 mode, not
      // the 🎯 mode. We do this server-side too as a defence in depth.
      if (!HEX_PREFIX_RE.test(trimmed)) {
        return c.json({ hits: [], truncated: false, invalid: true });
      }
      const hits: SearchHit[] = [];
      let truncated = false;
      try {
        // Step 1: scan project dirs to find session id matches +
        // collect the list of files we'll need to grep.
        const candidateFiles: Array<{ path: string; cwd: string }> = [];
        const projectDirs = await fs.readdir(opts.rootDir).catch(() => [] as string[]);
        for (const dir of projectDirs) {
          const projectPath = path.join(opts.rootDir, dir);
          let entries: string[];
          try {
            entries = await fs.readdir(projectPath);
          } catch {
            continue;
          }
          // The directory name is `cwd` with `/` and `.` flattened to
          // `-`; it isn't reversible without rescanning the jsonl
          // contents. We already do that work in workspaceScanner, but
          // we don't want to take that hit on every search. Instead we
          // surface the directory name as the cwd hint and let the
          // front-end resolve the real cwd via the workspace cache (it
          // has it from the existing /api/workspaces call).
          const cwdHint = decodeProjectDirHint(dir);
          for (const f of entries) {
            if (!f.endsWith(".jsonl")) continue;
            const sessionId = f.slice(0, -".jsonl".length);
            if (sessionId.startsWith(trimmed)) {
              hits.push({
                type: "session",
                sessionId,
                cwd: cwdHint,
                lastModified: await mtime(path.join(projectPath, f)),
              });
              if (hits.length >= MAX_HITS) {
                truncated = true;
                return c.json({ hits, truncated });
              }
            }
            candidateFiles.push({ path: path.join(projectPath, f), cwd: cwdHint });
          }
        }
        // Step 2: content grep across candidate files. Two patterns
        // we care about (run as one grep with `-e` alternation):
        //   - `"uuid":"<prefix>` → record uuid hits (= WorkNode candidates,
        //     plus the root user record of a ChatNode whose uuid matches)
        //   - `"promptId":"<prefix>` → ChatNode candidates (a ChatNode's
        //     id IS the promptId and isn't equal to any record's uuid in
        //     general, so the uuid grep alone misses ChatNode lookup)
        // We dedupe at the end by (sessionId, hit type, key id) so a
        // record matching both patterns (rare) doesn't double-list.
        const remaining = MAX_HITS - hits.length;
        if (remaining > 0 && candidateFiles.length > 0) {
          const contentHits = await grepContent(
            candidateFiles,
            trimmed,
            remaining,
          );
          for (const h of contentHits.hits) {
            hits.push(h);
            if (hits.length >= MAX_HITS) {
              truncated = contentHits.truncated || truncated;
              break;
            }
          }
          truncated = truncated || contentHits.truncated;
        }
        // Dedupe: same sessionId + same id might produce both a
        // chatnode (via promptId match) and a worknode (via root user
        // uuid match) hit when a user prefix also accidentally matches
        // somewhere — keep the first appearance, drop the second.
        const seen = new Set<string>();
        const deduped = hits.filter((h) => {
          const key =
            h.type === "session"
              ? `s:${h.sessionId}`
              : h.type === "chatnode"
                ? `c:${h.sessionId}:${h.chatNodeId}`
                : `w:${h.sessionId}:${h.workNodeId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return c.json({ hits: deduped, truncated });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    },
  );

  return app;
}

// Decode CC's project-dir flattening as a best-effort cwd hint. CC
// replaces `/` and `.` with `-`, so a dir like `-home-user-Loomscope`
// becomes `/home/user/Loomscope`. Not always reversible (a real `-`
// in the cwd is indistinguishable from a separator), but accurate
// enough for a tooltip / candidate label. The front-end can still
// pull the canonical cwd from /api/workspaces if it cares.
function decodeProjectDirHint(dirName: string): string {
  if (dirName.startsWith("-")) {
    return "/" + dirName.slice(1).replace(/-/g, "/");
  }
  return dirName;
}

async function mtime(p: string): Promise<string | null> {
  try {
    const st = await fs.stat(p);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

interface ContentGrepResult {
  hits: SearchHit[];
  truncated: boolean;
}

// Run grep across the given files for two patterns simultaneously:
// `"uuid":"<prefix>` and `"promptId":"<prefix>`. Returns up to ``limit``
// matches with enough JSON parsed to surface kind + preview. Skips
// records whose actual uuid/promptId doesn't start with the prefix
// (defence against grep matching elsewhere in the line content).
async function grepContent(
  files: Array<{ path: string; cwd: string }>,
  prefix: string,
  limit: number,
): Promise<ContentGrepResult> {
  const args = [
    "-F",
    "-H",
    "-e",
    `"uuid":"${prefix}`,
    "-e",
    `"promptId":"${prefix}`,
    ...files.map((f) => f.path),
  ];
  return new Promise<ContentGrepResult>((resolve) => {
    const proc = spawn("grep", args, { stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    const out: SearchHit[] = [];
    let truncated = false;
    const fileToCwd = new Map(files.map((f) => [f.path, f.cwd]));

    proc.stdout.on("data", (chunk: Buffer) => {
      if (out.length >= limit) {
        truncated = true;
        proc.kill("SIGTERM");
        return;
      }
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const sep = rawLine.indexOf(":");
        if (sep < 0) continue;
        const filePath = rawLine.slice(0, sep);
        const jsonText = rawLine.slice(sep + 1);
        const cwd = fileToCwd.get(filePath) ?? "";
        const sessionId = path.basename(filePath, ".jsonl");
        const hit = parseHitLine(jsonText, sessionId, cwd, prefix);
        if (hit) {
          out.push(hit);
          if (out.length >= limit) {
            truncated = true;
            proc.kill("SIGTERM");
            return;
          }
        }
      }
    });
    proc.on("close", () => resolve({ hits: out, truncated }));
    proc.on("error", () => resolve({ hits: out, truncated }));
  });
}

interface RawLineRecord {
  uuid?: string;
  type?: string;
  promptId?: string;
  parentUuid?: string | null;
  message?: { content?: unknown };
  attachment?: { type?: string };
}

function parseHitLine(
  jsonText: string,
  sessionId: string,
  cwd: string,
  expectedPrefix: string,
): SearchHit | null {
  let r: RawLineRecord;
  try {
    r = JSON.parse(jsonText) as RawLineRecord;
  } catch {
    return null;
  }
  const uuid = (r.uuid ?? "").toLowerCase();
  const promptId = (r.promptId ?? "").toLowerCase();
  const type = r.type ?? "";

  // Priority 1: ChatNode hit. The grep matched on `"promptId":` and
  // promptId starts with the prefix → this record belongs to a
  // ChatNode whose id matches. We synthesise the ChatNode hit from
  // any matching record (typically user records carry promptId), but
  // only return the ChatNode entry once per prompt — dedupe at the
  // caller via `seen` set.
  if (promptId.startsWith(expectedPrefix)) {
    return {
      type: "chatnode",
      sessionId,
      chatNodeId: r.promptId ?? "",
      cwd,
      // Best-effort preview: if THIS record happens to carry the
      // user's prompt text, surface it; otherwise leave blank and
      // the front-end can show the ChatNode id alone.
      preview:
        type === "user"
          ? extractUserPreview(r.message?.content)
          : "",
    };
  }

  // Priority 2: WorkNode hit. The grep matched on `"uuid":` and the
  // uuid starts with the prefix.
  if (uuid.startsWith(expectedPrefix)) {
    const kindHint =
      type === "assistant"
        ? "assistant"
        : type === "user"
          ? "user"
          : type === "attachment"
            ? "attachment"
            : type === "system"
              ? "system"
              : "unknown";
    return {
      type: "worknode",
      sessionId,
      workNodeId: r.uuid ?? "",
      cwd,
      kindHint,
      preview: extractGenericPreview(r),
    };
  }
  return null;
}

function extractUserPreview(content: unknown): string {
  if (typeof content === "string") return clamp(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return clamp((block as { text: string }).text);
      }
    }
  }
  return "";
}

function extractGenericPreview(r: RawLineRecord): string {
  // assistant: try blocks in order, skipping ones that produce empty
  // text (e.g. CC sometimes emits a thinking block with `text: ""` as
  // the first content item — we want to fall through to the next
  // block instead of returning a blank preview).
  const c = r.message?.content;
  if (typeof c === "string" && c.trim()) return clamp(c);
  if (Array.isArray(c)) {
    for (const block of c) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; text?: unknown; name?: unknown };
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        return clamp(b.text);
      }
      if (
        b.type === "thinking" &&
        typeof b.text === "string" &&
        b.text.trim()
      ) {
        return clamp(b.text);
      }
      if (b.type === "tool_use" && typeof b.name === "string") {
        return `tool_use: ${b.name}`;
      }
      if (b.type === "tool_result") return "tool_result";
    }
  }
  if (r.attachment?.type) return `attachment: ${r.attachment.type}`;
  return "";
}

function clamp(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 59) + "…";
}
