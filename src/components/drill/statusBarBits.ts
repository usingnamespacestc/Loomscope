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

import type { TodoItem } from "@/store/types";

// CC-vibe spinner words. Short, idle-time-friendly, varied enough that
// rotation feels alive across a 30-60 s burst. Picked to read well in
// both English and as a flavour token; localising them would defeat the
// "this is just decoration" mood.
const SPINNER_WORDS = [
  "Pondering",
  "Brewing",
  "Cooking",
  "Baking",
  "Thinking",
  "Forging",
  "Crafting",
  "Spinning",
  "Conjuring",
  "Hatching",
  "Bubbling",
  "Whirring",
  "Tinkering",
  "Wrangling",
  "Plotting",
  "Hustling",
  "Thundering",
] as const;

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
