// EN (v0.10 收尾 / v0.11 prep): persistent disk cache for parsed
// ChatFlow. Layered between the in-memory LRU and the cold-parse
// loader: LRU → disk → cold parse.
//
// Targets the user-reported "244 MB session waits 37 s in 'parsing
// jsonl' on first open after a Loomscope restart" repro. The
// in-memory LRU resets on restart; without persistence every fresh
// process pays the full cold-parse cost again. With persistence the
// second-and-subsequent visits read the parsed shape directly from
// `~/.loomscope/cache/<sid>.json` in 50-300 ms regardless of
// underlying jsonl size.
//
// Invalidation:
// - Schema version mismatch (any ChatFlow / ChatNode / WorkNode /
//   WorkflowSummary type change) → ignore cache → re-parse.
// - Source mtime / size mismatch → ignore cache → re-parse. Append-
//   only growth is enough to invalidate; full rewrites are also
//   covered.
//
// What we DON'T cache:
// - Fork merges (closure > 1). Records depend on multiple jsonls
//   each with their own mtime; the cache key would have to be a
//   composite signature, and the merge order matters. The in-memory
//   incremental stash already skips this case for the same reason.
//   Caller (chatFlowCache.getOrLoad) must gate `useDisk` on
//   closure ≤ 1.
// - The IncrementalParseState (records[]). We could write it
//   alongside the ChatFlow but RawRecord[] re-serialised is roughly
//   100 % of the original jsonl size, so we'd be duplicating disk
//   usage. After a disk-cache hit the first append pays one full
//   reparse to rebuild the state stash; subsequent appends use the
//   in-memory M0+M1 incremental path.
//
// 中: ChatFlow 的持久化磁盘 cache，挂在 LRU 跟 loader 之间。LRU
// 重启即失效，磁盘 cache 让 244MB session 二开免再付 37 秒 cold
// parse。Schema 版本不一致 / 源 jsonl mtime 或 size 不一致 → 不命中。
// fork 合并不写盘（key 复杂、合并顺序有语义）；跳过 IncrementalParseState
// 序列化（重复源数据约 100%，太重）。

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ChatFlow } from "@/data/types";

// EN: bump this when ANY of ChatNode / WorkNode kinds / WorkflowSummary
// fields / ChatFlow envelope changes shape. Old caches with a
// different version are dropped on read. Major safety net so we
// never deserialise an older snapshot into a newer code path that
// reads a field that didn't exist back then.
//
// History:
//   v1 (2026-05-05) — initial. Per-record LlmCallNodes (one per
//                     assistant jsonl record).
//   v2 (2026-05-06) — B msg_id merge. LlmCallNodes are now
//                     per-API-call (records sharing message.id
//                     coalesce). Old v1 caches have N split
//                     LlmCallNodes for what's now N=1 merged node;
//                     forcing re-parse on next access keeps the
//                     in-memory shape aligned with the parser.
//
// 中: 任何 ChatNode / WorkNode / WorkflowSummary / ChatFlow 形状变更
// 都要 bump 这个版本号；旧 cache 自动失效，不会被新代码当合法数据
// 解开。v2 = B msg_id merge 后 LlmCallNode 粒度从 per-record 变为
// per-API-call。v3 = workflow.nodes 现在按 timestamp chronological
// 排序（之前 buildWorkflow 按 kind 分组，破坏 chain 拓扑顺序），
// 老 v2 cache 顺序不一致，强制重 parse。
const SCHEMA_VERSION = 3;

interface DiskCacheEnvelope {
  schemaVersion: number;
  sessionId: string;
  sourcePath: string;
  sourceMtimeMs: number;
  sourceSize: number;
  cachedAt: number;
  chatFlow: ChatFlow;
}

// EN: cache root. Override via env var for tests + headless CI; we
// don't assume the home dir is writable in every environment.
// 中: 默认 ~/.loomscope/cache，测试用 env 变量覆盖。
function defaultCacheRoot(): string {
  if (process.env.LOOMSCOPE_DISK_CACHE_DIR) {
    return process.env.LOOMSCOPE_DISK_CACHE_DIR;
  }
  return path.join(os.homedir(), ".loomscope", "cache");
}

let cacheRootOverride: string | null = null;

/** Test helper: pin the cache root for hermetic tests. */
export function _setCacheRootForTests(dir: string | null): void {
  cacheRootOverride = dir;
}

function cacheRoot(): string {
  return cacheRootOverride ?? defaultCacheRoot();
}

function cachePath(sessionId: string): string {
  return path.join(cacheRoot(), `${sessionId}.json`);
}

/**
 * Read a cached ChatFlow if all guards match (schema version + source
 * jsonl mtime + size). Returns null on miss / corruption / mismatch.
 * Never throws — corrupt files are best-effort: log + return null so
 * the caller falls through to a fresh parse.
 */
export async function readDiskCache(args: {
  sessionId: string;
  sourcePath: string;
}): Promise<ChatFlow | null> {
  const { sessionId, sourcePath } = args;
  const cacheFile = cachePath(sessionId);

  let raw: string;
  try {
    raw = await fsp.readFile(cacheFile, "utf8");
  } catch {
    // ENOENT / permission / etc — silent miss.
    return null;
  }

  let envelope: DiskCacheEnvelope;
  try {
    envelope = JSON.parse(raw) as DiskCacheEnvelope;
  } catch {
    // Corrupt write — likely an incomplete tmp-file rename. Best-
    // effort: drop the bad file so it doesn't poison future reads.
    void fsp.unlink(cacheFile).catch(() => {});
    return null;
  }

  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    // Older snapshot under a now-evolved schema — silently miss; the
    // next write will replace it with the current shape.
    return null;
  }

  // Source-file guard. If stat fails (file deleted), drop cache too.
  let stat;
  try {
    stat = await fsp.stat(sourcePath);
  } catch {
    return null;
  }
  if (
    envelope.sourceMtimeMs !== stat.mtimeMs ||
    envelope.sourceSize !== stat.size
  ) {
    return null;
  }
  return envelope.chatFlow;
}

/**
 * Write a parsed ChatFlow snapshot to disk. Atomic via tmp-file +
 * rename, so a partially-written cache can never be observed by a
 * concurrent reader. Errors are swallowed — caching is best-effort
 * and a failure must NOT propagate up the request path.
 */
export async function writeDiskCache(args: {
  sessionId: string;
  sourcePath: string;
  chatFlow: ChatFlow;
}): Promise<void> {
  const { sessionId, sourcePath, chatFlow } = args;

  let stat;
  try {
    stat = await fsp.stat(sourcePath);
  } catch {
    // Source went away between parse + cache write — nothing useful
    // to persist. Skip silently.
    return;
  }

  const envelope: DiskCacheEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    sourcePath,
    sourceMtimeMs: stat.mtimeMs,
    sourceSize: stat.size,
    cachedAt: Date.now(),
    chatFlow,
  };

  const root = cacheRoot();
  const finalPath = cachePath(sessionId);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;

  try {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.writeFile(tmpPath, JSON.stringify(envelope), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    // Disk full / permission / etc. Cleanup the tmp if it exists.
    void fsp.unlink(tmpPath).catch(() => {});
    console.warn(
      `[loomscope] disk cache write failed for ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Drop the cached entry for `sessionId`. Used when a session is
 * unlinked from disk (workspace SSE `reason: "remove"`); without
 * this the cache would leak entries forever.
 */
export async function dropDiskCache(sessionId: string): Promise<void> {
  try {
    await fsp.unlink(cachePath(sessionId));
  } catch {
    // ENOENT is the common case — silent.
  }
}

/** Test helper. */
export function _schemaVersionForTests(): number {
  return SCHEMA_VERSION;
}
