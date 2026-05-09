// Look up the jsonl file path for a given session id by scanning
// project dirs under `rootDir` (= ~/.claude/projects).
//
// CC organizes sessions as `<rootDir>/<encoded-cwd>/<sid>.jsonl`,
// where `encoded-cwd` replaces `/` with `-`. We don't reverse-encode
// because (a) the encoding has subtle edge cases (dots, special
// chars) and (b) Loomscope often gets handed a bare sid with no cwd
// context (closure-merge, watcher events). A scan-by-id is simpler
// and bounded: ~10ms even on 100-project setups.
//
// Hoisted to a shared service in 2026-05-08 once a third caller
// appeared. Previously inlined as private helpers in `routes/
// sessions.ts` and `routes/turns.ts`; both now re-export from here.
//
// `locateSessionJsonl` returns null for "session not found" (root
// dir missing OR no `<sid>.jsonl` exists in any subdir). Mutating
// routes (POST /turns, /fork) use this — trashed sessions get a 404
// naturally, which is the correct UX (can't write to a deleted
// session).
//
// `locateSessionJsonlWithTrash` falls back to ~/.loomscope/trash/
// when the projects-tree lookup misses, so read-only routes (GET
// /api/sessions/:id, SSE invalidate, etc.) keep working for
// trashed sessions without each handler needing to know about
// trash semantics.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export async function locateSessionJsonl(
  rootDir: string,
  sessionId: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const dir of entries) {
    const candidate = path.join(rootDir, dir, `${sessionId}.jsonl`);
    const stat = await fsp.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

/** Read-path locator that also checks ~/.loomscope/trash/<sid>.jsonl
 *  when the projects-tree lookup misses. Pass an explicit `trashDir`
 *  in tests; production callers omit it and the resolver picks up
 *  ~/.loomscope/trash from the user's home. */
export async function locateSessionJsonlWithTrash(
  rootDir: string,
  sessionId: string,
  trashDir?: string,
): Promise<string | null> {
  const live = await locateSessionJsonl(rootDir, sessionId);
  if (live) return live;
  const trashPath = path.join(
    trashDir ?? path.join(os.homedir(), ".loomscope", "trash"),
    `${sessionId}.jsonl`,
  );
  const stat = await fsp.stat(trashPath).catch(() => null);
  if (stat?.isFile()) return trashPath;
  return null;
}
