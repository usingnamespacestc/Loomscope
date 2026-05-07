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
  "TaskCompleted",
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

/** Publish a hook event. Errors thrown by listeners are caught + logged
 * so a misbehaving consumer can't kill the route handler. */
export function publishHook(event: HookEventName, payload: HookEnvelope): void {
  for (const fn of listeners) {
    try {
      fn(event, payload);
    } catch (err) {
      console.error("[loomscope] hook listener error:", err);
    }
  }
}

/** Test helper. */
export function _resetHookBusForTests(): void {
  listeners.clear();
}

/** Test helper: peek listener count. */
export function _hookListenerCountForTests(): number {
  return listeners.size;
}
