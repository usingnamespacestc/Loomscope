// "⚙️ Bash: ls /etc/hostname" chip on the currently-running ChatNode
// card. Sourced from PreToolUse hooks (HTTP-realtime, arrive ahead of
// the jsonl fsync); removed by PostToolUse / Stop / next UserPromptSubmit.
//
// Pure presentation: it never alters chatFlow. When the real tool_call
// WorkNode lands via the jsonl-driven delta a few seconds later, the
// chip is just stale UI — it disappears on the matching PostToolUse
// (or, worst case, when the next Stop / UserPromptSubmit clears the map).
//
// Visible only on the running ChatNode (the caller already gates on
// `useIsChatNodeRunning`), so it doesn't paint on past turns.
import { useStore } from "@/store/index";
import type { ActiveToolCall } from "@/store/types";

/** Best-effort one-line summary of the tool input — Bash gets the
 *  command, Read/Write/Edit get the file path, TodoWrite gets count,
 *  others fall back to "" so the chip is just the tool name. */
function summariseInput(call: ActiveToolCall): string {
  const input = call.toolInput;
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  if (typeof inp.command === "string") return inp.command;
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.path === "string") return inp.path;
  if (Array.isArray(inp.todos)) return `${inp.todos.length} todos`;
  if (typeof inp.description === "string") return inp.description;
  return "";
}

const truncate = (s: string, n = 40) =>
  s.length <= n ? s : s.slice(0, n - 1) + "…";

export function ActiveToolCallsChips({ sessionId }: { sessionId: string }) {
  // Per-card subscription: re-renders only when the active-tool map for
  // THIS session changes. Empty map = no chips, no DOM.
  const activeToolCalls = useStore((s) =>
    s.sessions.get(sessionId)?.activeToolCalls,
  );
  if (!activeToolCalls || activeToolCalls.size === 0) return null;

  // Insertion order = call order (Map preserves it). Most-recent first
  // is more useful for a multi-call placeholder strip, but stable order
  // avoids re-mount flicker during a burst. Keep insertion order.
  const calls = Array.from(activeToolCalls.values());

  return (
    <span
      className="inline-flex flex-wrap items-center gap-1"
      data-testid="active-tool-calls"
    >
      {calls.map((c) => {
        const summary = truncate(summariseInput(c));
        return (
          <span
            key={c.toolUseId}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-emerald-700 ring-1 ring-emerald-200 animate-pulse"
            title={`${c.toolName}${summary ? `: ${summary}` : ""}`}
            data-testid={`active-tool-${c.toolUseId}`}
          >
            <span aria-hidden>⚙️</span>
            <span className="font-mono font-semibold">{c.toolName}</span>
            {summary && (
              <span className="font-mono text-emerald-600 opacity-80">
                {summary}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
