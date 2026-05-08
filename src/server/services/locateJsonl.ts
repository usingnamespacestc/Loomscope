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
// Returns `null` for "session not found" (root dir missing OR
// no `<sid>.jsonl` exists in any subdir).

import { promises as fsp } from "node:fs";
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
