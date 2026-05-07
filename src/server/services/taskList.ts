// Reads CC's per-session task list (from TaskCreate/TaskUpdate tools).
// Tasks live at `~/.claude/tasks/<taskListId>/<taskId>.json`. By default
// CC uses sessionId as taskListId (when no team / explicit override).
//
// Schema mirrors CC's `utils/tasks.ts` TaskSchema:
//   { id, subject, description, activeForm?, owner?, status,
//     blocks[], blockedBy[], metadata? }
//
// We only read; CC owns the writes. Malformed files are skipped silently
// (CC may briefly write invalid JSON during atomic-rename windows).
//
// Path sanitization mirrors CC: any char outside [A-Za-z0-9_-] becomes
// `-`. Loomscope already gates session ids by SESSION_ID_RE upstream, so
// the sanitizer here is mostly a no-op — kept as defense-in-depth.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type CcTaskStatus = "pending" | "in_progress" | "completed";

export interface CcTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: CcTaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

function sanitizeTaskListId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

// Test seam: redirect the `~/.claude/tasks` lookup at a tmp directory.
// Production paths use `null` → derived from `os.homedir()`.
let tasksRootOverride: string | null = null;
export function _setTasksRootForTests(root: string | null): void {
  tasksRootOverride = root;
}

function tasksRoot(): string {
  return tasksRootOverride ?? path.join(os.homedir(), ".claude", "tasks");
}

export function tasksDirFor(taskListId: string): string {
  return path.join(tasksRoot(), sanitizeTaskListId(taskListId));
}

function isValidTask(o: unknown): o is CcTask {
  if (!o || typeof o !== "object") return false;
  const t = o as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.subject === "string" &&
    typeof t.description === "string" &&
    typeof t.status === "string" &&
    STATUSES.has(t.status as string) &&
    Array.isArray(t.blocks) &&
    Array.isArray(t.blockedBy)
  );
}

function compareTaskIds(a: string, b: string): number {
  const an = parseInt(a, 10);
  const bn = parseInt(b, 10);
  if (!isNaN(an) && !isNaN(bn)) return an - bn;
  return a.localeCompare(b);
}

/**
 * Read all tasks for a session's task list. Empty array when the
 * directory doesn't exist (session never used TaskCreate, or CC's
 * tasks feature gated off). Sort: numeric id ascending, fall back to
 * lexicographic. Hidden files (`.highwatermark`, `.lock`) are skipped.
 */
export async function readTasksForSession(
  taskListId: string,
): Promise<CcTask[]> {
  const dir = tasksDirFor(taskListId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: CcTask[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    try {
      const content = await fs.readFile(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(content);
      if (isValidTask(parsed)) {
        out.push(parsed);
      }
    } catch {
      // Skip — CC may have a partial write mid-flight; the next watcher
      // event will refetch.
    }
  }
  out.sort((a, b) => compareTaskIds(a.id, b.id));
  return out;
}
