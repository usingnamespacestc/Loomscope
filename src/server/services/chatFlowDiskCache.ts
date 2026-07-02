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

import * as crypto from "node:crypto";
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
// 排序。v4 = workflow.nodes 现在包含所有 attachment kinds（之前
// 只白名单了 6 类，task_reminder / deferred_tools_delta 等 chain
// participant 被丢掉，导致前端 chain walk 在它们处 dead-end）。
// v5 = ChatNodeMeta.commits 新增（per-ChatNode git commit refs from
// detectGitCommits — Bash tool_use → `[branch sha] subject` parse）。
// v6 = git commit repo extraction now slices off command body past
// the first `commit` keyword (heredoc message bodies were polluting
// the -C flag / cd chain detection — fixed in commit a few above).
// v7 = WorkflowSummary.innerCompactLlmCallBoundaryIdx added — index
// in `assistantText` where post-compact rounds begin for hybrid
// ChatNodes (drives the Effective Context tab's pre/post split).
const SCHEMA_VERSION = 7;

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
  // pid + ms alone leave a sub-millisecond race window: two writers
  // for the same session firing in the same tick share the tmp path,
  // overwrite each other's writeFile, and the loser hits ENOENT on
  // rename because the winner already moved the file. Random suffix
  // makes the tmp uniquely owned by this writer.
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString("hex")}`;

  try {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.writeFile(tmpPath, JSON.stringify(envelope), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tmpPath, finalPath);
    // v2.6: opportunistic size sweep. Entries were previously only
    // removed via dropDiskCache on jsonl unlink — a user who never
    // deletes sessions grew ~/.loomscope/cache/ without bound (each
    // entry is up to ~100% of its jsonl's size). Best-effort, after
    // the write so the fresh entry is never the one swept.
    // 中: 写后顺手清扫总量,老 mtime 先走;不删 session 的用户以前
    // 缓存只增不减。
    await sweepDiskCache(root, finalPath);
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

/** v2.6: total-size budget for the disk cache directory. Generous —
 * the point is "bounded", not "small": at the documented ~100%-of-
 * jsonl entry size this is roughly 40 large sessions' worth.
 * 中: 缓存目录总量预算。目标是"有界"而非"省":约等于 40 个大
 * session 的量。 */
const DISK_CACHE_BUDGET_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB

let budgetOverride: number | null = null;
/** Test-only: shrink the sweep budget so tests don't need GiB files. */
export function _setBudgetForTests(bytes: number | null): void {
  budgetOverride = bytes;
}
function budgetBytes(): number {
  return budgetOverride ?? DISK_CACHE_BUDGET_BYTES;
}

/** Delete oldest-mtime cache entries until the directory fits the
 * budget. Never touches `justWrote` (the entry that triggered the
 * sweep) or in-flight `.tmp.*` files. Best-effort: any fs error just
 * ends the sweep — next write retries.
 * 中: 按 mtime 从最老开始删到预算以内;不碰刚写入的条目和 .tmp;
 * 任何 fs 错误直接结束本轮,下次写入再试。 */
async function sweepDiskCache(
  root: string,
  justWrote: string,
): Promise<void> {
  try {
    const names = await fsp.readdir(root);
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skip tmp + strays
      const p = `${root}/${name}`;
      if (p === justWrote) continue;
      try {
        const st = await fsp.stat(p);
        files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Raced with a concurrent drop — ignore.
      }
    }
    let total = files.reduce((acc, f) => acc + f.size, 0);
    try {
      total += (await fsp.stat(justWrote)).size;
    } catch {
      // justWrote already replaced/dropped — its size no longer counts.
    }
    if (total <= budgetBytes()) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    for (const f of files) {
      if (total <= budgetBytes()) break;
      try {
        await fsp.unlink(f.path);
        total -= f.size;
      } catch {
        // Concurrent removal — fine, it's gone either way.
      }
    }
  } catch {
    // readdir failed (dir vanished etc.) — best-effort, skip.
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
