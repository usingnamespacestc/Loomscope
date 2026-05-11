// EN: v0.9 file-tail — refcounted chokidar watcher for session
// JSONLs + sidecar dirs. Single global chokidar instance; we track
// `path → sessionIds` so fork-closure overlap (sibling forks
// share most ancestor jsonls) doesn't multiply watch entries. One
// fs event fans out to every interested session.
//
// 中: v0.9 file-tail 的引用计数 chokidar watcher。整个进程一个
// chokidar 实例，按 `path → sessionIds` 反查表分发事件——fork 闭包
// 共享祖先 jsonl 路径时不会重复监听。一次 fs change 同时通知所有
// 关心这条路径的 session 订阅者。
//
// v0.9.1 extension: each watched main jsonl auto-extends to its sidecar
// `subagents/` directory. chokidar recursive watch on the dir means new
// sub-agent jsonls appearing during the watch lifetime fire `add`,
// modifications fire `change` — both translate to a sub-agent-specific
// invalidate event so the client can refresh just that sub-agent's
// cache entry rather than the whole session.
//
// Event payload kinds (broadcast via sseHub.ts → /:id/events):
//   { sessionId, kind: "main",     reason, path }
//   { sessionId, kind: "subagent", reason, path, agentId, subdir? }
//
// Lifecycle:
//   - sessions.ts /:id/events route calls `watchSessionClosure(id, paths)`
//     before subscribing the SSE stream — paths = closure jsonl paths;
//     sidecar dirs are derived per main jsonl
//   - on change/add: classify by path, invalidate LRU cache (only on
//     `main` — sub-agent route doesn't go through LRU), broadcast
//   - when the last SSE subscriber for a session disconnects, route
//     calls `unwatchSession(id)`; paths still owned by other sessions
//     stay watched
//
// chokidar config:
//   - persistent: true   — keep the event loop alive while watching
//   - ignoreInitial: true — we already have current state via the
//     initial parse; skip the synthetic `add` events on startup
//   - awaitWriteFinish: small stability window so we don't fire mid-
//     write while CC is still flushing a multi-line append. 80 ms is
//     enough headroom without making the live tail feel sluggish.
//   - usePolling: false on Linux — inotify-based watching is reliable
//     on native FS. WSL2 + Windows-mounted /mnt/c paths would need
//     polling, but ~/.claude/projects is on the Linux side, so native
//     watch wins.

import * as path from "node:path";

import { FSWatcher, watch } from "chokidar";

import { parseAgentId } from "@/parse/sidecar";
import { invalidateSession } from "@/server/services/chatFlowCache";
import { broadcast } from "@/server/services/sseHub";
import { tasksDirFor } from "@/server/services/taskList";

type WatchedPathKind = "main" | "sidecar-dir" | "tasks-dir";

let watcher: FSWatcher | null = null;

// path → set of sessionIds that care about this path
const pathToSessions = new Map<string, Set<string>>();
// sessionId → set of paths it owns (for cleanup). Includes both main
// jsonls and sidecar dirs.
const sessionToPaths = new Map<string, Set<string>>();
// path → kind (so the change/add handler routes events correctly)
const pathKind = new Map<string, WatchedPathKind>();
// Sorted list of sidecar dir prefixes — used for "is this changed file
// under any watched sidecar dir" lookup. Refreshed lazily.
let sidecarDirsCache: string[] | null = null;

function refreshSidecarDirsCache(): void {
  sidecarDirsCache = [];
  for (const [p, kind] of pathKind) {
    if (kind === "sidecar-dir") sidecarDirsCache.push(p);
  }
}

function getSidecarDirs(): string[] {
  if (!sidecarDirsCache) refreshSidecarDirsCache();
  return sidecarDirsCache!;
}

/** Convention: sidecar dir for `<sid>.jsonl` lives at `<sid>/subagents`. */
export function sidecarSubagentsDir(jsonlPath: string): string {
  return path.join(jsonlPath.replace(/\.jsonl$/, ""), "subagents");
}

// 2026-05-11 fix: chokidar's `awaitWriteFinish` waits for the file
// to be QUIET for stabilityThreshold ms before firing. Empirically,
// CC writes streaming records every <50 ms during long turns; with
// stabilityThreshold=80 ms the file is never quiet, so `change`
// events fire ZERO times during a 30 s streaming response and the
// browser sees nothing until the turn ends (or the user refreshes).
//
// Replace it with a manual rate-limit:
//   - first event in a burst: schedule fire after QUIET_MS
//     (low latency on idle activity → matches the old UX)
//   - sustained writes: rate-limit to one fire per MAX_WAIT_MS
//     keyed off the last fire time (so a 30 s streaming turn
//     produces ~30 invalidate events spaced ~1 s apart, instead
//     of zero)
//
// Parsers are line-oriented and discard partial last lines, so an
// invalidate firing mid-write is safe — the next event picks up
// whatever new full lines have been appended since.
//
// 中: chokidar 的 `awaitWriteFinish` 等"文件安静 stabilityThreshold
// ms"才 fire。实测 CC streaming 写 record 间隔 <50ms，文件全程不
// 安静 → 30s 内 chokidar 一次 change 都不报，浏览器看不到任何更
// 新直到 turn 结束（或用户手动刷新）。
//
// 改成手写 rate limiter：
//   - burst 首个 event：延迟 QUIET_MS 后 fire（idle 场景跟旧行
//     为一致）
//   - sustained writes：每次 fire 之间硬性留 MAX_WAIT_MS 冷却，
//     所以 30s streaming turn 大约产 30 个 invalidate，间距 1s
//
// parser 是行模式，最后一行 partial 会被 JSON.parse 失败丢弃，
// 所以中间 fire 安全——下次 fire 自然接上后续完整行。
// 详细推导见 docs/devlog.md 2026-05-11 entry。
const THROTTLE_QUIET_MS = 80;
const THROTTLE_MAX_WAIT_MS = 1000;

interface ThrottleState {
  pendingTimer: NodeJS.Timeout | null;
  lastFireAt: number;
  reason: "change" | "add" | "unlink";
}
const throttleState = new Map<string, ThrottleState>();

function scheduleFire(
  filePath: string,
  reason: "change" | "add" | "unlink",
): void {
  const now = Date.now();
  let s = throttleState.get(filePath);
  if (!s) {
    s = { pendingTimer: null, lastFireAt: 0, reason };
    throttleState.set(filePath, s);
  } else {
    // Upgrade reason if a stronger one arrives (unlink > add > change).
    if (reason === "unlink") s.reason = "unlink";
    else if (reason === "add" && s.reason === "change") s.reason = "add";
  }
  // Don't reset an already-pending fire — that would push the fire
  // back indefinitely during sustained writes. The first event in
  // the burst owns the timer; later events just update the reason.
  //
  // 中: 已经 schedule 了一次 fire 就不再重置 timer，否则连续 event
  // 会一直把 fire 时间推后（这就是 awaitWriteFinish 行为的本质 bug）。
  // 后续 event 只升级 reason 不动 timer。
  if (s.pendingTimer) return;
  const earliestAllowedFireAt = s.lastFireAt + THROTTLE_MAX_WAIT_MS;
  const fireAt = Math.max(now + THROTTLE_QUIET_MS, earliestAllowedFireAt);
  const delay = Math.max(0, fireAt - now);
  s.pendingTimer = setTimeout(() => {
    const cur = throttleState.get(filePath);
    if (!cur) return;
    const fireReason = cur.reason;
    cur.pendingTimer = null;
    cur.lastFireAt = Date.now();
    cur.reason = "change"; // reset for the next burst
    handleEvent(filePath, fireReason);
  }, delay);
}

function ensureWatcher(): FSWatcher {
  if (watcher) return watcher;
  watcher = watch([], {
    persistent: true,
    ignoreInitial: true,
    // No awaitWriteFinish — we throttle manually via scheduleFire.
  });
  // change = existing file modified; add = new file appeared. For
  // main jsonl, only `change` matters (file already existed when we
  // started watching). For sidecar dir, both matter — a brand-new
  // sub-agent shows up as `add`, subsequent appends as `change`.
  watcher.on("change", (filePath: string) => scheduleFire(filePath, "change"));
  watcher.on("add", (filePath: string) => scheduleFire(filePath, "add"));
  // Tasks under `~/.claude/tasks/<sid>/` get unlinked when CC's
  // `deleteTask` flow runs (or status "deleted"). Surface that as a
  // tasks-kind invalidate too. unlink on a main jsonl or sidecar
  // means the session was nuked — handled elsewhere; we route through
  // the same dispatcher.
  watcher.on("unlink", (filePath: string) => scheduleFire(filePath, "unlink"));
  watcher.on("error", (err) => {
    console.error("[sessionWatcher] chokidar error:", err);
  });
  return watcher;
}

function handleEvent(
  filePath: string,
  reason: "change" | "add" | "unlink",
): void {
  // Direct hit: this is a main-jsonl path we explicitly watched.
  const directOwners = pathToSessions.get(filePath);
  if (directOwners && pathKind.get(filePath) === "main") {
    for (const sessionId of directOwners) {
      invalidateSession(sessionId);
      broadcast(sessionId, {
        event: "invalidate",
        data: { sessionId, kind: "main", reason, path: filePath },
      });
    }
    return;
  }

  // Tasks-dir: any file under a watched `~/.claude/tasks/<sid>` dir
  // counts. CC writes one json file per task atomically (rename), so
  // change/add/unlink all surface as add/change events on the dir.
  // Skip hidden dotfiles (`.lock`, `.highwatermark`) — task list state
  // doesn't change for those.
  const taskFilename = path.basename(filePath);
  if (taskFilename.endsWith(".json") && !taskFilename.startsWith(".")) {
    for (const [dir, kind] of pathKind) {
      if (kind !== "tasks-dir") continue;
      if (!filePath.startsWith(dir + path.sep)) continue;
      const sessions = pathToSessions.get(dir);
      if (!sessions || sessions.size === 0) continue;
      for (const sessionId of sessions) {
        broadcast(sessionId, {
          event: "invalidate",
          data: { sessionId, kind: "tasks", reason, path: filePath },
        });
      }
      return;
    }
  }

  // Otherwise, check if `filePath` lies under any watched sidecar dir.
  // Sub-agent jsonls have shape `agent-<id>.jsonl`, optionally inside
  // a single subdir level. Anything else (e.g., meta.json files,
  // tool-results/*) is ignored — clients don't subscribe to those.
  const filename = path.basename(filePath);
  if (!filename.startsWith("agent-") || !filename.endsWith(".jsonl")) {
    return;
  }
  for (const sidecarDir of getSidecarDirs()) {
    if (!filePath.startsWith(sidecarDir + path.sep)) continue;
    const sessions = pathToSessions.get(sidecarDir);
    if (!sessions || sessions.size === 0) continue;
    const rel = path.relative(sidecarDir, filePath);
    const parts = rel.split(path.sep);
    const subdir = parts.length > 1 ? parts[0] : undefined;
    const agentId = parseAgentId(filename);
    for (const sessionId of sessions) {
      // Sub-agent doesn't touch LRU (loadSubAgent route parses fresh
      // each time). Just broadcast so the client refreshes its
      // subAgentCache entry.
      broadcast(sessionId, {
        event: "invalidate",
        data: {
          sessionId,
          kind: "subagent",
          reason,
          path: filePath,
          agentId,
          subdir: subdir ?? null,
        },
      });
    }
    return;
  }
}

function addPath(
  sessionId: string,
  p: string,
  kind: WatchedPathKind,
  ownedRef: Set<string>,
): void {
  if (ownedRef.has(p)) return;
  ownedRef.add(p);
  let seen = pathToSessions.get(p);
  if (!seen) {
    seen = new Set();
    pathToSessions.set(p, seen);
    pathKind.set(p, kind);
    if (kind === "sidecar-dir") sidecarDirsCache = null;
    // First subscriber for this path → tell chokidar to watch it.
    // chokidar tolerates non-existent paths (sidecar dirs may not
    // exist yet for sessions with no sub-agents) — when the dir
    // appears, watcher picks it up.
    watcher!.add(p);
  }
  seen.add(sessionId);
}

/**
 * Add `closurePaths` (main jsonls) to the watch set on behalf of
 * `sessionId`. For each main jsonl, also watches its sidecar
 * `subagents/` directory so sub-agent jsonl changes fire too.
 *
 * Idempotent — paths already owned by this session are skipped.
 */
export function watchSessionClosure(
  sessionId: string,
  closurePaths: string[],
): void {
  ensureWatcher();
  let owned = sessionToPaths.get(sessionId);
  if (!owned) {
    owned = new Set();
    sessionToPaths.set(sessionId, owned);
  }
  for (const p of closurePaths) {
    addPath(sessionId, p, "main", owned);
    addPath(sessionId, sidecarSubagentsDir(p), "sidecar-dir", owned);
  }
  // CC TaskList lives at `~/.claude/tasks/<sid>` (default — sessionId
  // doubles as taskListId). Watching it lets task add/edit/delete
  // surface as a `kind: "tasks"` SSE invalidate. Dir may not exist
  // for sessions that never used TaskCreate; chokidar tolerates that.
  addPath(sessionId, tasksDirFor(sessionId), "tasks-dir", owned);
}

/**
 * Drop watches owned by `sessionId`. Paths still referenced by other
 * sessions stay watched; orphaned paths are removed from chokidar.
 */
export function unwatchSession(sessionId: string): void {
  const owned = sessionToPaths.get(sessionId);
  if (!owned) return;
  for (const p of owned) {
    const seen = pathToSessions.get(p);
    if (!seen) continue;
    seen.delete(sessionId);
    if (seen.size === 0) {
      pathToSessions.delete(p);
      const kind = pathKind.get(p);
      pathKind.delete(p);
      if (kind === "sidecar-dir") sidecarDirsCache = null;
      watcher?.unwatch(p);
    }
  }
  sessionToPaths.delete(sessionId);
}

/** Test helper: tear down the global watcher + maps. */
export async function _resetForTests(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  pathToSessions.clear();
  sessionToPaths.clear();
  pathKind.clear();
  sidecarDirsCache = null;
  for (const s of throttleState.values()) {
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
  }
  throttleState.clear();
}

/** Test helper: peek state. */
export function _peekStateForTests(): {
  watchedPaths: string[];
  sessions: string[];
  kinds: Array<{ path: string; kind: WatchedPathKind }>;
} {
  return {
    watchedPaths: [...pathToSessions.keys()],
    sessions: [...sessionToPaths.keys()],
    kinds: [...pathKind.entries()].map(([p, k]) => ({ path: p, kind: k })),
  };
}
