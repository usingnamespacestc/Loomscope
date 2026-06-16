// Bits the ComposerStatusBar uses to mirror CC terminal's status line:
//   ✻ Pondering...   分析数据 → 锁定瓶颈 → 出修复建议   (28s · ↓ 1.1k)
//
// Spinner word: a small rotating word ("Pondering", "Brewing", ...)
// with a leading ✻, mirroring CC's "thinking word" flair. Pure UI; no
// information conveyed — just signals "we're alive". Implemented as a
// React hook so the rotation only runs while running=true.
//
// Todo summariser: picks the most informative entry from a TodoWrite
// payload (the in_progress one; falls back to the latest pending if
// none in_progress). Returns "" when nothing to show.
import { useEffect, useState } from "react";

import { CC_SPINNER_WORDS } from "@/components/drill/spinnerWords";
import type { TodoItem } from "@/store/types";

// 1:1 with the spinner word list Claude Code's TUI rotates through —
// extracted verbatim from the bundled CLI binary (v2.1.178, 179 entries).
// Matching CC's list means our status bar reads identically to the
// terminal across the whole "Thundering / Razzmatazzing / Pondering"
// menagerie. See `spinnerWords.ts`.
const SPINNER_WORDS = CC_SPINNER_WORDS;

const ROTATE_MS = 3000;

/** Returns the current rotating spinner word, or null when not running. */
export function useSpinnerWord(running: boolean): string | null {
  const [idx, setIdx] = useState(() =>
    Math.floor(((Date.now() / ROTATE_MS) | 0) % SPINNER_WORDS.length),
  );
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % SPINNER_WORDS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [running]);
  if (!running) return null;
  return SPINNER_WORDS[idx];
}

/** Pick the most informative todo's content to show on the status bar.
 *  Preference: in_progress > pending > none. Returns "" if no todos. */
export function summariseTodos(todos: TodoItem[] | null | undefined): string {
  if (!todos || todos.length === 0) return "";
  const inProgress = todos.find((t) => t.status === "in_progress");
  if (inProgress) return inProgress.content;
  const pending = todos.find((t) => t.status === "pending");
  if (pending) return pending.content;
  return "";
}
