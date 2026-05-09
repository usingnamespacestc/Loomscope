// EN (v∞.0 PR 1 foundation, fully wired in PR 2): in-process
// publish / subscribe bus for CC settings.json hook events. The
// `/api/cc-hook` route validates + publishes; the SSE forwarder (PR
// 2) subscribes and pushes per-session events into the existing
// `sseHub` channel.
//
// Why a separate bus from `sseHub`: hook events arrive WITHOUT the
// session_id necessarily being in any active SSE subscriber's key.
// The bus is sessionId-agnostic; the SSE forwarder's job is to
// route on session_id. Keeping them separate also lets non-SSE
// consumers (logging, metrics, audit) attach without going through
// the SSE channel.
//
// 中: hook 事件的进程内 pub/sub。route 收到后 publish；sseHub 转发器
// (PR 2) subscribe 后按 session_id 路到对应 SSE 通道。Bus 跟
// sseHub 解耦，留接口给非 SSE 的消费者（日志、metrics）。

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "TaskCreated",
  "TaskCompleted",
  "Notification",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
  "PermissionDenied",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Common envelope every CC hook fire carries. Event-specific fields
 * land in `extras` (preserved from the raw POST body). */
export interface HookEnvelope {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  /** Event-specific fields preserved verbatim (tool_name, tool_input,
   * tool_output, compact_metadata, etc). */
  extras: Record<string, unknown>;
}

export type HookListener = (
  event: HookEventName,
  payload: HookEnvelope,
) => void;

const listeners = new Set<HookListener>();

/** Subscribe to all hook events. Returns an unsubscribe fn. */
export function subscribeHooks(fn: HookListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ────────────────────────────────────────────────────────────────────
// Dedup window
// ────────────────────────────────────────────────────────────────────
//
// Why: Loomscope keeps two parallel hook-delivery paths (settings.json
// HTTP fired by the CC binary + SDK programmatic JS callbacks fired
// by `options.hooks` for SDK-spawned CC). Both paths legitimately
// reach this bus. With both paths enabled — the default for SDK CC —
// every hook fires twice within ~50-200ms, so listeners would render
// double banners / double activity bumps.
//
// Strategy: derive a per-event dedup key, drop second arrivals within
// `DEDUP_TTL_MS` of the first.
//
// Key derivation:
//   - When `extras.tool_use_id` is present (PreToolUse / PostToolUse /
//     PostToolUseFailure) → exact key = `${sid}:${event}:${tool_use_id}`.
//     Both paths carry the same tool_use_id for the same logical tool
//     call, so this is a precise match.
//   - Otherwise (UserPromptSubmit / Stop / SessionStart / etc — these
//     have no per-fire id) → coarse-bucket key by 1-second timestamp:
//     `${sid}:${event}:${Math.floor(Date.now()/1000)}`. SDK + HTTP
//     paths are ~100ms apart so they fall in the same second the vast
//     majority of the time. Edge case: rapid genuine succession across
//     a second boundary stays distinct, which is the right call —
//     legit successive hooks shouldn't be merged.
//
// TTL: 2s. Generous enough for any conceivable HTTP-path delay; short
// enough that the recent-keys map stays small.
//
// GC: opportunistic when map size > GC_THRESHOLD; sweeps entries
// older than TTL. No timer (no event loop pressure).
const DEDUP_TTL_MS = 2000;
const GC_THRESHOLD = 1024;
const recentKeys = new Map<string, number>();
let suppressedCount = 0;

function deriveDedupKey(event: HookEventName, payload: HookEnvelope): string {
  const extras = payload.extras as Record<string, unknown> | undefined;
  const tuid = extras?.tool_use_id;
  if (typeof tuid === "string" && tuid.length > 0) {
    return `${payload.session_id}:${event}:${tuid}`;
  }
  // No tool_use_id (PermissionRequest, UserPromptSubmit, Stop,
  // SessionStart, etc.). Use tool_name + serialized tool_input for
  // content-aware match — two consecutive PermissionRequest events
  // for DIFFERENT tools within the same time bucket should both
  // fire (the original time-only key collapsed them, regression
  // caught by pendingPermissionTracker tests). 500ms time bucket
  // still bounds dup HTTP-vs-programmatic firings (typical gap
  // <200ms) without merging legit successive events (model
  // throughput + user interaction >>500ms).
  const toolName = String(extras?.tool_name ?? "");
  const toolInputJson = JSON.stringify(extras?.tool_input ?? null);
  return `${payload.session_id}:${event}:${toolName}:${toolInputJson}:${Math.floor(Date.now() / 500)}`;
}

function gcOldKeys(now: number): void {
  for (const [k, v] of recentKeys) {
    if (now - v >= DEDUP_TTL_MS) recentKeys.delete(k);
  }
}

/** Publish a hook event. Errors thrown by listeners are caught + logged
 * so a misbehaving consumer can't kill the route handler.
 *
 * Dedups against recent keys (see comment block above). When a
 * duplicate is suppressed, returns silently — no listener fires + the
 * suppressedCount metric increments.
 */
export function publishHook(event: HookEventName, payload: HookEnvelope): void {
  const key = deriveDedupKey(event, payload);
  const now = Date.now();
  const last = recentKeys.get(key);
  if (last !== undefined && now - last < DEDUP_TTL_MS) {
    suppressedCount++;
    return;
  }
  recentKeys.set(key, now);
  if (recentKeys.size > GC_THRESHOLD) gcOldKeys(now);
  for (const fn of listeners) {
    try {
      fn(event, payload);
    } catch (err) {
      console.error("[loomscope] hook listener error:", err);
    }
  }
}

/** Test helper — also useful for diagnostics if we ever want a
 *  /metrics-style endpoint to surface this count. */
export function _suppressedDupCountForTests(): number {
  return suppressedCount;
}

/** Test helper — wipe dedup state (NOT touched by
 *  `_resetHookBusForTests` since that one only clears listeners; some
 *  tests want listeners intact across runs but a clean dedup). */
export function _resetDedupForTests(): void {
  recentKeys.clear();
  suppressedCount = 0;
}

/** Test helper. Resets BOTH listeners and dedup state — pre-dedup
 *  tests that don't know about `_resetDedupForTests` would otherwise
 *  see leaked recent-keys across runs (e.g. two consecutive
 *  PermissionRequests for the same session in the same second
 *  would dedup the second). Keeping the reset surface unified
 *  matches the original "fresh bus per test" expectation. */
export function _resetHookBusForTests(): void {
  listeners.clear();
  recentKeys.clear();
  suppressedCount = 0;
}

/** Test helper: peek listener count. */
export function _hookListenerCountForTests(): number {
  return listeners.size;
}
