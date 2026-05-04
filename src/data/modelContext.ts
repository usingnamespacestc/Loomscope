// Shared model→context-window mapping. Lives in `src/data/` so both
// the server-side parser (computeWorkflowSummary) and the client
// canvas (TokenBar) can read it without crossing the parse/canvas
// boundary.
//
// Default table reflects Loomscope author's actual usage (Opus 4.7
// usually runs 1M context window via /model). External users with
// non-Opus defaults get the 200k floor; future v0.4-style settings
// override would prepend overrides here. CC strips the [1m] suffix
// before writing the model string to jsonl, so we can't read the
// runtime 1M opt-in directly — defaults assume it.
//
// Order matters: longest-prefix-first (specific over general).

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

export const MODEL_CONTEXT_WINDOW: Array<[RegExp, number]> = [
  [/claude-opus/i, 1_000_000],
  [/claude-sonnet/i, 200_000],
  [/claude-haiku/i, 200_000],
];

export function maxContextForModel(model?: string): number {
  if (!model) return DEFAULT_MAX_CONTEXT_TOKENS;
  for (const [pattern, max] of MODEL_CONTEXT_WINDOW) {
    if (pattern.test(model)) return max;
  }
  return DEFAULT_MAX_CONTEXT_TOKENS;
}

export const TOKEN_BAR_DEFAULT_MAX = DEFAULT_MAX_CONTEXT_TOKENS;
