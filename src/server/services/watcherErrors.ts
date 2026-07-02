// v2.6: shared chokidar error logger with EACCES/EPERM de-noising.
//
// Root-owned project dirs under ~/.claude/projects/ (created by
// running claude inside docker or via sudo) make chokidar emit an
// EACCES error on every scan pass. workspaceScanner already tolerates
// those dirs gracefully (`accessible:false` locked rows in the
// sidebar), but the watchers logged the identical error verbatim,
// forever, on a timer — pure noise. Permission errors are now logged
// ONCE per (watcher, code, path) and suppressed after; anything else
// still logs loudly every time.
//
// 中: root-owned 目录让 chokidar 周期性刷 EACCES——扫描器早已容错
// (侧边栏 🔒 行),watcher 却每轮原样打日志。改为同一 (来源,错误码,
// 路径) 只提示一次;其他错误照旧全量打印。
const seenPermissionErrors = new Set<string>();
const SEEN_CAP = 256;

export function logWatcherError(tag: string, err: unknown): void {
  const e = err as NodeJS.ErrnoException | null;
  const code = e?.code;
  if (code === "EACCES" || code === "EPERM") {
    const key = `${tag}:${code}:${e?.path ?? ""}`;
    if (seenPermissionErrors.has(key)) return;
    if (seenPermissionErrors.size < SEEN_CAP) seenPermissionErrors.add(key);
    console.warn(
      `[${tag}] ${code} on ${e?.path ?? "(unknown path)"} — unreadable ` +
        `(root-owned?) dir, watcher skips it; this message is shown once. ` +
        `To actually read those sessions: sudo chown -R $USER "${e?.path ?? ""}"`,
    );
    return;
  }
  console.error(`[${tag}] chokidar error:`, err);
}

/** Test-only. */
export function _resetWatcherErrorLogForTests(): void {
  seenPermissionErrors.clear();
}
