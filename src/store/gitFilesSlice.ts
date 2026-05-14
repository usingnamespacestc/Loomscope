// v0.11 Phase C — git pending-commit files derivation.
//
// Pipeline:
//   1. On Git tab first-open per session, batch-fetch every commit's
//      changed-file list via `/api/sessions/:id/git/commits-files`.
//   2. Cache `committedFilesBySession[sessionId][sha] = { repo, files }`.
//      (Earlier shape was just `files[]`; we now also keep `repo`
//       so we can absolute-ize the relative paths git emits when
//       comparing against trackedFiles in computePending.)
//   3. Recompute `pendingFilesByChatNode[sessionId][cnId] = Set<path>`
//      whenever the cache for a session changes:
//        for each ChatNode in chronological order:
//          touched = trackedFiles(N)  // CC's snapshot, session-cumulative
//          committedSoFar ∪= union(committedFiles for each sha in N.commits)
//          pending(N) = touched - committedSoFar
//   4. Card chip 📤 N reads `.size`; Git tab "Pending" section shows
//      the actual file paths.
//
// Edge cases (v1 trade-offs):
//   - Re-edit (file committed then re-edited without re-committing):
//     trackedFiles still contains it, committedSoFar also contains
//     it → counted as clean. Under-count. Acceptable given chip is
//     an indicator, not a precise list.
//   - Initial pre-existing dirty (user starts CC with a dirty work-
//     tree): we don't have visibility, treated as 0. Session-relative.
//   - Manual `git commit` in user terminal (not via CC): not in
//     `meta.commits`, won't get subtracted → over-count.
//   - Commit fetch failed (e.g., repo path stale): treated as 0
//     committed files for that sha → over-count.

import type { StateCreator } from "zustand";

import type { ChatFlow, ChatNode } from "@/data/types";
import type { LoomscopeStore } from "@/store/types";

export type GitFilesFetchStatus = "idle" | "loading" | "loaded" | "error";

export interface GitFilesSlice {
  /** sha → { repo, files }. Cleared per-session on session unload.
   *  Why store `repo` alongside files: `git show --name-status`
   *  returns paths relative to the repo root, while trackedFiles
   *  (the other side of the pending-files diff) are absolute. The
   *  slice's computePending needs repo to absolute-ize each
   *  committed file before set-comparing. Earlier shape (just files)
   *  led to the path-mismatch bug fixed 2026-05-14. */
  committedFilesBySession: Map<
    string,
    Map<
      string,
      { repo: string; files: Array<{ path: string; status: string }> }
    >
  >;
  /** Per-session fetch state (so the panel knows whether to show a
   * skeleton). */
  gitFilesFetchStatus: Map<string, GitFilesFetchStatus>;
  /** Last error message per session (only when status==='error'). */
  gitFilesFetchError: Map<string, string>;
  /** EN (2026-05-14): epoch-ms of the most recent successful commit-
   *  files fetch per session. Used by App.tsx's invalidate-driven
   *  refresh to debounce repeat triggers (don't re-fetch if last
   *  successful fetch was < N seconds ago). */
  committedFilesFetchedAt: Map<string, number>;

  /** Derived: ChatNode id → set of file paths still uncommitted as
   * of that ChatNode's end. Recomputed when committedFilesBySession
   * changes for the session. Empty Map means "not yet computed". */
  pendingFilesByChatNode: Map<string, Map<string, Set<string>>>;

  /** Fetches once per session unless `force` is true. Without
   *  `force`, returns immediately when status==='loading' or
   *  status==='loaded' (matches the lazy GitDiffPanel callsite).
   *  With `force=true`, re-fetches regardless — used by the
   *  invalidate-driven refresh so new commits get reflected in
   *  📤 pending counts without requiring a Git tab toggle.
   *  中: force=true 时跳过 "loaded" 短路，强制重拉；用于 invalidate
   *  后刷新 📤 chip。 */
  loadCommittedFiles: (
    sessionId: string,
    chatFlow: ChatFlow,
    opts?: { force?: boolean },
  ) => Promise<void>;
  /** Explicit recompute (called internally after fetch lands; exposed
   * for tests). */
  recomputePendingFiles: (sessionId: string, chatFlow: ChatFlow) => void;
}

interface BatchResp {
  ok: true;
  byKey: Record<
    string,
    | { ok: true; files: Array<{ path: string; status: string }> }
    | { ok: false; code: string }
  >;
}

async function fetchBatch(sessionId: string): Promise<BatchResp | null> {
  const res = await fetch(`/api/sessions/${sessionId}/git/commits-files`);
  if (!res.ok) return null;
  return (await res.json()) as BatchResp;
}

/** EN (2026-05-14 bug fix): tilde-expand a repo path on the client too
 *  (defense-in-depth — server.gitDiff already expands when invoking
 *  git, but the client uses repo to join with `git show` relative
 *  paths so trackedFiles' ABSOLUTE shape can match). The browser has
 *  no `os.homedir()`; CC always records `~` against the user's $HOME,
 *  so we recover it via the trackedFiles which carry the resolved
 *  absolute path (see firstFileHome helper).
 *  中: 浏览器无 os.homedir，用 trackedFiles 第一条绝对路径回推 ~。 */
function expandHomeClient(repo: string, homeDir: string | null): string {
  if (!repo) return repo;
  if (!homeDir) return repo;
  if (repo === "~") return homeDir;
  if (repo.startsWith("~/")) return `${homeDir}/${repo.slice(2)}`;
  return repo;
}

/** EN: cheapest possible $HOME recovery — find a trackedFiles entry
 *  that starts with `/home/<user>/` or `/Users/<user>/` and slice.
 *  Returns null when no such entry exists (chip stays approximate but
 *  not catastrophically wrong). */
function recoverHomeDir(allTracked: Set<string>): string | null {
  for (const p of allTracked) {
    const m = /^(\/home\/[^/]+|\/Users\/[^/]+)/.exec(p);
    if (m) return m[1];
  }
  return null;
}

function computePending(
  chatFlow: ChatFlow,
  committedBySha: Map<
    string,
    { repo: string; files: Array<{ path: string; status: string }> }
  >,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const cwd = chatFlow.cwd ?? null;
  // Gather all trackedFiles across the session so we can recover
  // $HOME for tilde-expansion of commit repo paths.
  // 中: 把所有 trackedFiles 汇总用于回推 ~。
  const allTracked = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    for (const f of latestTrackedFiles(cn)) allTracked.add(f);
  }
  const homeDir = recoverHomeDir(allTracked);
  // Chronological walk — chatNodes are stored in jsonl insertion
  // order which IS chronological (parser appends as records arrive).
  // For the touched set we use CC's session-cumulative trackedFiles
  // (latest snapshot of fileHistorySnapshots — see distinctTouchedFiles
  // in layoutDag for the rationale).
  //
  // EN (2026-05-14 bug fix): committedSoFar now stores ABSOLUTE
  // paths. `git show --name-status` returns paths relative to the
  // repo root, but trackedFiles are absolute, so the set membership
  // check needs a consistent format. We absolute-ize each committed
  // file via `<repo>/<relPath>` with repo also tilde-expanded.
  // 中: committedSoFar 存绝对路径——git show 返回相对，trackedFiles
  // 是绝对，必须先规范化到同一坐标系才能减得掉。
  const committedSoFar = new Set<string>();
  for (const cn of chatFlow.chatNodes) {
    // Add this ChatNode's commits to the running committed set.
    for (const cm of cn.meta.commits ?? []) {
      const entry = committedBySha.get(cm.sha);
      if (entry) {
        const expandedRepo = expandHomeClient(entry.repo, homeDir);
        for (const f of entry.files) {
          // Strip leading "/" on relPath defense (git show never emits
          // one but be paranoid). repo doesn't end with /.
          // 中: 拼绝对路径；防御 relPath 多余前缀 "/"。
          const rel = f.path.startsWith("/") ? f.path.slice(1) : f.path;
          committedSoFar.add(`${expandedRepo}/${rel}`);
        }
      }
    }
    const touched = latestTrackedFiles(cn);
    if (touched.size === 0) {
      // Don't carry over a stale set — empty trackedFiles means
      // CC hasn't snapshotted this turn, we have no signal. Treat
      // pending as empty (chip hidden) rather than guessing.
      out.set(cn.id, new Set());
      continue;
    }
    const pending = new Set<string>();
    for (const filePath of touched) {
      // EN (2026-05-14 bug fix): filter trackedFiles to the session
      // cwd subtree. trackedFiles includes paths CC has Read'd —
      // /tmp/* and other non-git paths drift in over a long session
      // and would be reported as "pending forever" because no commit
      // can ever subtract them. Restricting to cwd subtree is a
      // honest "未提交" semantic — files actually in the session's
      // working dir.
      // 中: 限制 trackedFiles 到 cwd 子树内；屏蔽 /tmp 等不属于本
      // session 工作区的累积索引污染。
      if (cwd && !filePath.startsWith(`${cwd}/`) && filePath !== cwd) {
        continue;
      }
      if (!committedSoFar.has(filePath)) pending.add(filePath);
    }
    out.set(cn.id, pending);
  }
  return out;
}

function latestTrackedFiles(cn: ChatNode): Set<string> {
  const snaps = cn.meta.fileHistorySnapshots ?? [];
  if (snaps.length === 0) return new Set();
  // Latest snapshot wins — same semantic the layoutDag chip uses
  // (CC writes monotonically-cumulative trackedFileBackups; last
  // entry supersets all earlier).
  return new Set(snaps[snaps.length - 1].trackedFiles);
}

export const createGitFilesSlice: StateCreator<
  LoomscopeStore,
  [],
  [],
  GitFilesSlice
> = (set, get) => ({
  committedFilesBySession: new Map(),
  gitFilesFetchStatus: new Map(),
  gitFilesFetchError: new Map(),
  committedFilesFetchedAt: new Map(),
  pendingFilesByChatNode: new Map(),

  loadCommittedFiles: async (sessionId, chatFlow, opts) => {
    const force = opts?.force === true;
    const status = get().gitFilesFetchStatus.get(sessionId) ?? "idle";
    // EN: skip when an in-flight fetch is happening regardless of
    // `force` — duplicate fetches would just race on the same response.
    // `loaded` status only short-circuits without `force` (preserves
    // the original lazy semantics for the Git tab caller; the
    // invalidate-driven caller in App.tsx passes force=true).
    // 中: in-flight 总是跳过；loaded 仅 non-force 跳过。
    if (status === "loading") return;
    if (status === "loaded" && !force) return;
    set((s) => {
      const next = new Map(s.gitFilesFetchStatus);
      next.set(sessionId, "loading");
      return { gitFilesFetchStatus: next };
    });
    const resp = await fetchBatch(sessionId);
    if (!resp || !resp.ok) {
      set((s) => {
        const stat = new Map(s.gitFilesFetchStatus);
        stat.set(sessionId, "error");
        const err = new Map(s.gitFilesFetchError);
        err.set(sessionId, "fetch failed");
        return { gitFilesFetchStatus: stat, gitFilesFetchError: err };
      });
      return;
    }
    // Build sha → { repo, files } map (drop failed entries). We
    // preserve the repo string from the key so computePending can
    // absolute-ize relative paths to compare against trackedFiles.
    // 中: 同时存 repo + files；computePending 把 relative path 跟 repo
    // 拼出绝对路径才能跟 trackedFiles 比对。
    const bySha = new Map<
      string,
      { repo: string; files: Array<{ path: string; status: string }> }
    >();
    for (const [key, val] of Object.entries(resp.byKey)) {
      // Key shape: `<repo>::<sha>`. repo may contain `:` (rare —
      // Windows drive letters) so we split on the LAST `::`.
      const idx = key.lastIndexOf("::");
      if (idx < 0) continue;
      const repo = key.slice(0, idx);
      const sha = key.slice(idx + 2);
      if (val.ok && sha) bySha.set(sha, { repo, files: val.files });
    }
    set((s) => {
      const allBySession = new Map(s.committedFilesBySession);
      allBySession.set(sessionId, bySha);
      const stat = new Map(s.gitFilesFetchStatus);
      stat.set(sessionId, "loaded");
      const fetchedAt = new Map(s.committedFilesFetchedAt);
      fetchedAt.set(sessionId, Date.now());
      return {
        committedFilesBySession: allBySession,
        gitFilesFetchStatus: stat,
        committedFilesFetchedAt: fetchedAt,
      };
    });
    // Recompute derived map
    get().recomputePendingFiles(sessionId, chatFlow);
  },

  recomputePendingFiles: (sessionId, chatFlow) => {
    const bySha =
      get().committedFilesBySession.get(sessionId) ?? new Map();
    const pending = computePending(chatFlow, bySha);
    set((s) => {
      const next = new Map(s.pendingFilesByChatNode);
      next.set(sessionId, pending);
      return { pendingFilesByChatNode: next };
    });
  },
});
