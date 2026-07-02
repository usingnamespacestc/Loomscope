// Server-side LRU cache for parsed ChatFlow.
//
// Why: parsing a 25 MB session JSONL takes ~250-300 ms (parse + merge
// + workflow build). For users who cycle between a handful of sessions
// — the typical workflow — re-parsing the same file every click is
// wasteful. Caching the merged ChatFlow keyed on (sessionId, mtime
// fingerprint) gives near-instant second-and-subsequent opens, and
// invalidates automatically when the underlying jsonl(s) change.
//
// Cache key includes mtimes of EVERY closure member (entry + all
// merged-in fork siblings/ancestors/descendants), so editing any
// closure member invalidates the cache. mtime is millisecond-resolution
// from fs.stat — same source v0.9 file-tail will use for change
// detection later.
//
// Eviction: simple insertion-order LRU (Map preserves insertion, and
// re-insertion-on-hit moves an entry to the most-recently-used end).
// Bounded by MAX_ENTRIES count rather than bytes; each ChatFlow is
// 5-25 MB in V8 representation, so 8 entries ≈ 100 MB upper bound.
// Size-based eviction would be more precise but harder to estimate
// accurately without sizeof()-equivalent.
//
// Lifetime: in-memory only. Cleared on process restart. That's fine —
// user reopens browser → first session click re-warms the cache.

import { promises as fs } from "node:fs";

import type { ChatFlow } from "@/data/types";
import type { IncrementalParseState } from "@/parse/jsonl";
import {
  readDiskCache,
  writeDiskCache,
} from "@/server/services/chatFlowDiskCache";
import type { ClosureMember } from "@/server/services/forkTree";
import { createIdleMap } from "@/server/services/idleMap";

const MAX_ENTRIES = 8;

// Map preserves insertion order, so the iteration's first entry is the
// least-recently-used. We re-insert on hit (delete + set) to bump it
// to the end.
const cache = new Map<string, ChatFlow>();

// v0.10 收尾 / v0.11 prep: per-session incremental-parse state stash.
// Independent from the LRU above — LRU is keyed by full closure mtime
// signature so any append produces a cache miss; the stash survives
// that miss so the next loader call can reuse the prior records[]
// instead of re-reading the whole jsonl.
//
// Keyed by sessionId only (not by entry jsonl path or closure
// signature). Multiple closures pointing at the same sessionId would
// collide, but the only path that calls into the stash is the
// closure ≤ 1 (single-jsonl) case in `loadMergedChatFlow`, so
// closure-signature collisions don't matter in practice.
//
// `invalidateSession` does NOT touch the stash — that's the whole
// point. The stash represents what we knew at byteSize N; the next
// reader picks it up and reads [N, current size).
//
// v2.6 leak fix: each entry holds a full records[] + ChatFlow (up to
// ~25 MB for big sessions) and nothing ever cleared it — unsubscribe
// cleanup was removed in PR D5 and no eviction replaced it, so a
// long-lived server kept one footprint per session ever browsed.
// Idle-evicting map bounds it; an evicted session just pays one full
// reparse on its next visit (identical to a server restart).
//
// 中: 增量 parse state 旁路 stash，跟 LRU 解耦。LRU 因为 mtime 进 key
// append 必 miss；stash 不参与 key，下一次 loader 直接拿来当 prevState
// 喂给 parseJsonlFileIncremental，省掉重读老内容。
// v2.6: 换 idleMap 堵泄漏,被淘汰的 session 下次访问多付一次全量重读。
const stateStash = createIdleMap<IncrementalParseState>({
  ttlMs: 30 * 60_000,
  maxEntries: 16,
});

// Public for tests; production callers should go through getOrLoad.
export function _resetForTests(): void {
  cache.clear();
  stateStash.clear();
}

export function _peekKeysForTests(): string[] {
  return [...cache.keys()];
}

export function _peekStashKeysForTests(): string[] {
  return stateStash.keys();
}

/** v0.10 收尾: read the stashed incremental-parse state for `sessionId`,
 * if any. Caller is expected to feed it into
 * `parseJsonlFileIncremental` and call `setStashedState` with the
 * fresh state on success. Returns undefined when no stash exists
 * (first visit / cache reset / cleared by `clearStashedState`). */
export function getStashedState(
  sessionId: string,
): IncrementalParseState | undefined {
  return stateStash.get(sessionId);
}

/** v0.10 收尾: replace the stashed state for `sessionId`. */
export function setStashedState(
  sessionId: string,
  state: IncrementalParseState,
): void {
  stateStash.set(sessionId, state);
}

/** v0.10 收尾: drop the stashed state for `sessionId`. Called when the
 * loader can't produce a state worth keeping — e.g. a closure-merge
 * (>1 jsonl) ChatFlow whose records[] doesn't correspond to a single
 * jsonl's tail. Force-fall-back-to-full on the next call. */
export function clearStashedState(sessionId: string): void {
  stateStash.delete(sessionId);
}

/**
 * Build a stable cache key for a session + its fork closure. Includes
 * mtimes so any underlying JSONL change → key change → cache miss →
 * re-parse.
 *
 * Closure is BFS-ordered (per findForkClosure), so the resulting key
 * is deterministic for the same set of files.
 */
export async function buildCacheKey(
  sessionId: string,
  closure: ClosureMember[],
  fallbackJsonlPath: string,
): Promise<string> {
  // Closure can be empty when forkTree didn't locate the entry (rare —
  // usually means a malformed jsonl). Fall back to the entry path's
  // mtime alone.
  const paths =
    closure.length > 0 ? closure.map((m) => m.jsonlPath) : [fallbackJsonlPath];
  const mtimes = await Promise.all(
    paths.map((p) =>
      fs.stat(p).then(
        (s) => `${s.mtimeMs}`,
        () => "0", // unreadable path: treat as mtime 0 so any change re-keys
      ),
    ),
  );
  return `${sessionId}:${mtimes.join(",")}`;
}

/** Returns the cached ChatFlow + bumps it to the most-recently-used
 * end of the LRU. Returns null on miss. */
export function getCached(key: string): ChatFlow | null {
  const cf = cache.get(key);
  if (!cf) return null;
  // Move to MRU end.
  cache.delete(key);
  cache.set(key, cf);
  return cf;
}

/**
 * v0.9 file-tail: drop every cached entry whose key starts with
 * ``${sessionId}:`` — i.e. the same session under any closure mtime.
 * Called from the file watcher when an underlying jsonl appends so the
 * next request re-parses the now-larger file.
 */
export function invalidateSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Insert and apply LRU eviction if we exceed MAX_ENTRIES. */
export function setCached(key: string, chatFlow: ChatFlow): void {
  // If key already exists, delete first so the re-insert puts it at
  // the MRU end (same behaviour as `getCached`).
  if (cache.has(key)) cache.delete(key);
  cache.set(key, chatFlow);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Default convenience wrapper used by route handlers. Computes the
 * cache key, returns cached if hit, otherwise consults the persistent
 * disk cache, otherwise calls `loader` and stores the result.
 *
 * Cache layering (top = fastest):
 *   1. In-memory LRU (sub-ms)
 *   2. Persistent disk cache `~/.loomscope/cache/<sid>.json` —
 *      gated to `closure.length <= 1` (single-jsonl sessions).
 *      Read pays one fs.stat + JSON.parse (50-300 ms regardless
 *      of underlying jsonl size).
 *   3. Cold parse via `loader` (full pipeline; 300 ms - 30+ s).
 *
 * Disk cache is opt-in per call: pass `useDisk: false` to skip
 * (e.g. for fork-merge load paths whose ChatFlow depends on
 * multiple jsonls in a closure-specific dedupe order — the disk
 * cache schema is keyed on a single sessionId + sourcePath only).
 */
export async function getOrLoad(args: {
  sessionId: string;
  closure: ClosureMember[];
  fallbackJsonlPath: string;
  loader: () => Promise<ChatFlow>;
  /** v0.10 收尾: opt-in disk cache (default true). Set false when
   * the loader's input depends on more than just the entry jsonl
   * (= fork closure with > 1 member). */
  useDisk?: boolean;
}): Promise<{ chatFlow: ChatFlow; cacheHit: boolean }> {
  const key = await buildCacheKey(
    args.sessionId,
    args.closure,
    args.fallbackJsonlPath,
  );
  const hit = getCached(key);
  if (hit) return { chatFlow: hit, cacheHit: true };

  // Disk-cache layer. Best-effort — failures fall through to the
  // loader. Gate to closure ≤ 1 by default; caller can also force
  // off via `useDisk: false`.
  const useDisk =
    (args.useDisk ?? true) && (args.closure.length <= 1);
  if (useDisk) {
    const onDisk = await readDiskCache({
      sessionId: args.sessionId,
      sourcePath: args.fallbackJsonlPath,
    });
    if (onDisk) {
      setCached(key, onDisk);
      return { chatFlow: onDisk, cacheHit: true };
    }
  }

  const chatFlow = await args.loader();
  setCached(key, chatFlow);
  if (useDisk) {
    // Fire-and-forget — never block the request on disk write.
    // Errors logged inside `writeDiskCache`.
    void writeDiskCache({
      sessionId: args.sessionId,
      sourcePath: args.fallbackJsonlPath,
      chatFlow,
    });
  }
  return { chatFlow, cacheHit: false };
}
