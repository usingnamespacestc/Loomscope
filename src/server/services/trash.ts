// EN: Soft-delete machinery for sessions. A trashed session's jsonl
// is moved out of CC's project tree (`~/.claude/projects/<encoded-
// cwd>/<sid>.jsonl`) into a Loomscope-managed trash dir (default
// `~/.loomscope/trash/<sid>.jsonl`) plus a sidecar metadata file
// (`<sid>.trash-meta.json`) recording the original path so restore
// is exact. CC's `claude --resume` can no longer see the file, and
// Loomscope's regular workspace scanner doesn't reach into the
// trash dir, so the session disappears from the normal sidebar.
//
// Layout decision (flat, not encoded-cwd-mirrored): meta carries
// `originalPath` so restore is one move regardless of layout. Flat
// makes listing a single readdir and avoids needing to manage
// possibly-empty subdirs.
//
// Cross-fs robustness: on EXDEV (rare — only if user has
// ~/.loomscope on a different mount than ~/.claude), fall back to
// copy + unlink. Single jsonl files even at 256 MB copy in <1s.
//
// 中: session 软删机制。把 jsonl 从 CC 项目树搬到 ~/.loomscope/trash/
// 平铺存放，外加 .trash-meta.json 记原路径——CC `claude --resume` 看不
// 到，Loomscope 主 sidebar 也不扫到，但回收站面板能展示 + 还原。
// 跨 fs (EXDEV) 用 copy+unlink 兜底。

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { locateSessionJsonl } from "@/server/services/locateJsonl";

export interface TrashMeta {
  /** sid (uuid). The file at <trashDir>/<sid>.jsonl. */
  sessionId: string;
  /** Absolute path the jsonl was moved FROM. Used by restore. */
  originalPath: string;
  /** cwd parsed off the project-dir name at trash time. UI grouping. */
  originalCwd: string | null;
  /** ISO timestamp when soft-deleted. */
  trashedAt: string;
  /** Frozen at trash time so listTrash doesn't re-parse big jsonls. */
  title: string;
  /** ISO timestamp of file mtime at trash time. */
  modifiedAt: string;
  /** Bytes at trash time. */
  fileSize: number;
  /** Frozen at trash time — turn count proxy (line count). */
  messageCount: number;
}

export interface TrashedSession extends TrashMeta {
  /** Absolute path under the trash dir. Useful for clients that want
   *  to open the file read-only without restoring. */
  trashedPath: string;
}

export interface TrashServiceOptions {
  /** Override the trash dir. Defaults to ~/.loomscope/trash. Tests
   *  pass a tmpdir. */
  trashDir?: string;
  /** Provide the title/messageCount/cwd extractor from workspaceScanner
   *  so trash service stays decoupled from jsonl parsing. cwd is read
   *  off the first record carrying it; null if the jsonl never declares
   *  one (rare). */
  extractMeta: (jsonlPath: string) => Promise<{
    title: string;
    messageCount: number;
    cwd: string | null;
  }>;
}

export class TrashService {
  private readonly trashDir: string;
  private readonly extractMeta: TrashServiceOptions["extractMeta"];

  constructor(opts: TrashServiceOptions) {
    this.trashDir =
      opts.trashDir ?? path.join(os.homedir(), ".loomscope", "trash");
    this.extractMeta = opts.extractMeta;
  }

  /** Soft-delete: move <rootDir>/<encoded-cwd>/<sid>.jsonl into trash
   *  dir and write a .trash-meta.json sidecar. Throws if the sid is
   *  not found under rootDir or already in trash. */
  async trash(rootDir: string, sessionId: string): Promise<TrashedSession> {
    if (await this.has(sessionId)) {
      throw new TrashError("ALREADY_TRASHED", `${sessionId} is already in trash`);
    }
    const livePath = await locateSessionJsonl(rootDir, sessionId);
    if (!livePath) {
      throw new TrashError("NOT_FOUND", `${sessionId} not found under ${rootDir}`);
    }
    await fsp.mkdir(this.trashDir, { recursive: true });

    const stat = await fsp.stat(livePath);
    const { title, messageCount, cwd } = await this.extractMeta(livePath);
    const meta: TrashMeta = {
      sessionId,
      originalPath: livePath,
      originalCwd: cwd,
      trashedAt: new Date().toISOString(),
      title,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      fileSize: stat.size,
      messageCount,
    };

    const destJsonl = this.jsonlPath(sessionId);
    const destMeta = this.metaPath(sessionId);
    await moveFile(livePath, destJsonl);
    await fsp.writeFile(destMeta, JSON.stringify(meta, null, 2), "utf8");
    return { ...meta, trashedPath: destJsonl };
  }

  /** Restore: move <trashDir>/<sid>.jsonl back to its originalPath
   *  (creating the parent dir if needed). Removes the meta sidecar.
   *  Throws if the sid isn't in trash, or if a file already exists
   *  at the restore destination (CC may have re-created the same
   *  sid, vanishingly rare but possible). */
  async restore(sessionId: string): Promise<{ restoredPath: string }> {
    const meta = await this.readMeta(sessionId);
    const exists = await fsp.stat(meta.originalPath).catch(() => null);
    if (exists) {
      throw new TrashError(
        "RESTORE_COLLISION",
        `restore destination already exists: ${meta.originalPath}`,
      );
    }
    await fsp.mkdir(path.dirname(meta.originalPath), { recursive: true });
    await moveFile(this.jsonlPath(sessionId), meta.originalPath);
    await fsp.unlink(this.metaPath(sessionId)).catch(() => undefined);
    return { restoredPath: meta.originalPath };
  }

  /** Hard delete: remove the trashed jsonl and its meta sidecar.
   *  Throws if not in trash. */
  async purge(sessionId: string): Promise<void> {
    const exists = await this.has(sessionId);
    if (!exists) {
      throw new TrashError("NOT_FOUND", `${sessionId} not in trash`);
    }
    await fsp.unlink(this.jsonlPath(sessionId)).catch(() => undefined);
    await fsp.unlink(this.metaPath(sessionId)).catch(() => undefined);
  }

  /** List all trashed sessions, sorted newest-first by trashedAt. */
  async list(): Promise<TrashedSession[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.trashDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: TrashedSession[] = [];
    for (const name of entries) {
      if (!name.endsWith(".trash-meta.json")) continue;
      const sid = name.slice(0, -".trash-meta.json".length);
      const meta = await this.readMeta(sid).catch(() => null);
      if (!meta) continue;
      out.push({ ...meta, trashedPath: this.jsonlPath(sid) });
    }
    out.sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : -1));
    return out;
  }

  /** Empty the trash. Returns the count of sessions purged. */
  async empty(): Promise<{ count: number }> {
    const all = await this.list();
    for (const t of all) {
      await this.purge(t.sessionId).catch(() => undefined);
    }
    return { count: all.length };
  }

  /** True iff a meta sidecar exists for this sid. */
  async has(sessionId: string): Promise<boolean> {
    const stat = await fsp.stat(this.metaPath(sessionId)).catch(() => null);
    return !!stat?.isFile();
  }

  /** Path to the trashed jsonl (whether or not it exists yet). */
  jsonlPath(sessionId: string): string {
    return path.join(this.trashDir, `${sessionId}.jsonl`);
  }

  /** Path to the meta sidecar (whether or not it exists yet). */
  metaPath(sessionId: string): string {
    return path.join(this.trashDir, `${sessionId}.trash-meta.json`);
  }

  private async readMeta(sessionId: string): Promise<TrashMeta> {
    const raw = await fsp.readFile(this.metaPath(sessionId), "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          throw new TrashError("NOT_FOUND", `${sessionId} not in trash`);
        }
        throw err;
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TrashError("META_CORRUPT", `meta JSON for ${sessionId} is malformed`);
    }
    return parsed as TrashMeta;
  }
}

export class TrashError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_TRASHED"
      | "RESTORE_COLLISION"
      | "META_CORRUPT",
    message: string,
  ) {
    super(message);
    this.name = "TrashError";
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Cross-device — copy + unlink fallback.
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

