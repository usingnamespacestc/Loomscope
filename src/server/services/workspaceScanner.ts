// Scan `~/.claude/projects/` and reverse-decode `cwd` from JSONL records.
//
// Each project dir under `~/.claude/projects/` is named with `cwd` flattened
// via `-`-substitution, which is ambiguous (`/foo/bar` vs `/foo-bar` both map
// to `-foo-bar`). To recover the real path, read each project's first JSONL
// and pick up the first record that carries a `cwd` field. (CC writes `cwd`
// on `user` records, but not necessarily on the very first record of a file
// — eg. early `permission-mode` records lack it. Scan a bounded prefix.)

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

export interface Workspace {
  cwd: string; // real host path, e.g. "/home/user/Agentloom"
  sessionCount: number; // number of *.jsonl in the project dir
  lastModified: string; // ISO; max mtime across jsonl files
  projectDir: string; // absolute path of the encoded dir (kept for later use)
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  modified: string;
  messageCount: number;
  gitBranch: string | null;
  fileSize: number;
  isSidechain: boolean;
}

// Bounded prefix scan: most cwd-bearing records appear within the first
// handful of lines. 200 is a comfortable upper bound for v0.2.
const CWD_SCAN_LINE_BUDGET = 200;

export async function scanWorkspaces(rootDir: string): Promise<Workspace[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Workspace[] = [];
  for (const name of entries) {
    const projectDir = path.join(rootDir, name);
    const stat = await fs.stat(projectDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) continue;

    const fullPaths = files.map((f) => path.join(projectDir, f));
    let lastMtimeMs = 0;
    for (const p of fullPaths) {
      const s = await fs.stat(p).catch(() => null);
      if (s && s.mtimeMs > lastMtimeMs) lastMtimeMs = s.mtimeMs;
    }

    // Sort so the newest jsonl is read first (cwd in active sessions is
    // freshest; old archives may have stale cwd).
    const sorted = await sortByMtimeDesc(fullPaths);
    let cwd: string | null = null;
    for (const jsonlPath of sorted) {
      cwd = await firstCwdInJsonl(jsonlPath, CWD_SCAN_LINE_BUDGET);
      if (cwd) break;
    }
    if (!cwd) continue; // no usable cwd → skip; user may have a stray dir

    out.push({
      cwd,
      sessionCount: files.length,
      lastModified: new Date(lastMtimeMs).toISOString(),
      projectDir,
    });
  }
  // Sort by lastModified desc — most recent workspace first.
  out.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  return out;
}

export async function findWorkspaceByCwd(
  rootDir: string,
  cwd: string,
): Promise<Workspace | null> {
  const all = await scanWorkspaces(rootDir);
  return all.find((w) => w.cwd === cwd) ?? null;
}

// ─── Session lister (per-workspace) ──────────────────────────────────────────

export async function listSessions(projectDir: string): Promise<SessionSummary[]> {
  const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
  const out: SessionSummary[] = [];
  for (const file of files) {
    const full = path.join(projectDir, file);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    const meta = await extractSessionMeta(full);
    out.push({
      sessionId,
      title: meta.title ?? sessionId.slice(0, 8),
      modified: new Date(stat.mtimeMs).toISOString(),
      messageCount: meta.messageCount,
      gitBranch: meta.gitBranch,
      fileSize: stat.size,
      isSidechain: meta.isSidechain,
    });
  }
  out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return out;
}

// Helper for the trash service: parse a single jsonl into the
// frozen-at-trash-time fields (title / messageCount / cwd). Returns
// safe defaults when fields are missing rather than throwing — the
// trash sidecar can tolerate "Untitled" and a null cwd.
export async function readTrashSnapshotMeta(
  jsonlPath: string,
): Promise<{ title: string; messageCount: number; cwd: string | null }> {
  const meta = await extractSessionMeta(jsonlPath);
  const cwd = await firstCwdInJsonl(jsonlPath, CWD_SCAN_LINE_BUDGET);
  return {
    title: meta.title ?? "Untitled",
    messageCount: meta.messageCount,
    cwd,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function sortByMtimeDesc(paths: string[]): Promise<string[]> {
  const stamped: Array<{ p: string; m: number }> = [];
  for (const p of paths) {
    const s = await fs.stat(p).catch(() => null);
    stamped.push({ p, m: s?.mtimeMs ?? 0 });
  }
  stamped.sort((a, b) => b.m - a.m);
  return stamped.map((x) => x.p);
}

async function firstCwdInJsonl(jsonlPath: string, lineBudget: number): Promise<string | null> {
  const stream = fsSync.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let read = 0;
  try {
    for await (const line of rl) {
      if (++read > lineBudget) break;
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as { cwd?: unknown };
        if (typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
      } catch {
        // malformed line — skip
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

interface ExtractedSessionMeta {
  title: string | null;
  messageCount: number;
  gitBranch: string | null;
  isSidechain: boolean;
}

// Read the JSONL once and pick up:
//   - first 'summary' record's `summary` field (CC writes one near top)
//   - first user record's text content (truncated) as fallback title
//   - first non-empty gitBranch
//   - any record with isSidechain=true → flag the session
//   - total line count = messageCount (cheap proxy; not 100% = turn count)
async function extractSessionMeta(jsonlPath: string): Promise<ExtractedSessionMeta> {
  const stream = fsSync.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let summary: string | null = null;
  let firstUserPrompt: string | null = null;
  let agentName: string | null = null;
  let customTitle: string | null = null;
  let gitBranch: string | null = null;
  let isSidechain = false;
  let messageCount = 0;

  try {
    for await (const line of rl) {
      if (!line) continue;
      messageCount += 1;
      // Cheap fast-path: skip parse if we already have everything we need
      // and just keep counting.
      if (summary && firstUserPrompt && gitBranch && isSidechain) continue;

      let rec: Record<string, unknown> | null = null;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object") continue;

      if (rec.isSidechain === true) isSidechain = true;
      if (typeof rec.gitBranch === "string" && !gitBranch && rec.gitBranch) {
        gitBranch = rec.gitBranch;
      }
      if (rec.type === "summary" && typeof rec.summary === "string" && !summary) {
        summary = rec.summary;
      }
      // Sidecar jsonl files store agent metadata; the main jsonl normally
      // doesn't carry agentName/customTitle directly, but if a future CC
      // version adds them at top-level we'll pick them up gracefully.
      if (typeof rec.agentName === "string" && !agentName) agentName = rec.agentName;
      if (typeof rec.customTitle === "string" && !customTitle) customTitle = rec.customTitle;

      if (!firstUserPrompt && rec.type === "user") {
        const message = rec.message as { content?: unknown } | undefined;
        const content = message?.content ?? rec.content;
        const text = stringifyUserContent(content);
        if (text) firstUserPrompt = text;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // CC's getLogDisplayTitle fallback chain.
  const title =
    agentName ?? customTitle ?? summary ?? truncate(firstUserPrompt, 80) ?? null;

  return { title, messageCount, gitBranch, isSidechain };
}

function stringifyUserContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          return b.text.trim();
        }
      }
    }
  }
  return null;
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
