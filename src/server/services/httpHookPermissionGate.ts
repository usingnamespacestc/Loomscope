// EN (v2.3 PR F1): server-side long-poll permission gate for the
// settings.json HTTP hook path. When CC's terminal session fires
// PreToolUse, the hook POST is held on a Promise until either:
//
//   • Browser POSTs /api/cc-hook/decision with the user's choice
//     (allow / deny — optionally with `saveAsRule`).
//   • SDK / CC aborts the request (axios cancels on tool cancel /
//     Ctrl-C in terminal). The Request's AbortSignal fires → we
//     resolve with `ask` so the route returns a sane response.
//   • 9-min internal cap elapses (CC's hard timeout is 10 min default
//     in DEFAULT_HTTP_HOOK_TIMEOUT_MS) → resolve with `ask` so CC
//     falls back to its built-in terminal prompt. Picking 9 min gives
//     us a ~60 s safety margin before CC kills the connection.
//
// The resolution shape is the JSON body CC honors as
// `hookSpecificOutput.permissionDecision` ∈ {allow, deny, ask}, plus
// optional `permissionDecisionReason` and `updatedInput`. The route
// wraps our resolution into the full envelope CC expects.
//
// Why a separate module from sessionRegistry's
// `pendingPermissionPrompts`: the SDK programmatic path resolves via
// the SDK callback's return value (inline to the sessionRegistry's
// promise-resolver), while HTTP-hook path resolves by HTTP response.
// Lifetimes differ — HTTP path's promise lives in the route handler
// scope and must auto-resolve on connection close to prevent
// dangling axios timeouts on the CC side.
//
// 中: HTTP hook 路径的等待门，跟 sessionRegistry 的 SDK 等待门并列
// 但独立——一个返 promise resolver、一个返 HTTP body。9-min 内部上限
// 给 CC 留 1 分钟兜底，超时回 ask 让 CC 走 terminal 原生提示。

import * as crypto from "node:crypto";

/** EN: shape the route uses to build the final hook-response JSON.
 *  `updatedInput` carries AskUserQuestion-style answer data; for plain
 *  allow/deny tools it stays undefined.
 *  中: route 拼最终 JSON 用的内部 shape。 */
export interface HttpHookDecision {
  decision: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

/** EN: data the browser banner needs to render the prompt + the
 *  promise resolver/timeout state. The `id` is the promptId broadcast
 *  on SSE; clients POST it back on /decision.
 *  中: banner 渲染所需 + promise 控制状态。promptId 经 SSE 广播。 */
interface PendingHttpHookPrompt {
  id: string;
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
  /** Resolved by /decision OR connection abort OR internal timeout.
   *  Always called exactly once; `cleanup()` is idempotent. */
  resolve: (d: HttpHookDecision) => void;
  cleanup: () => void;
}

const pending = new Map<string, PendingHttpHookPrompt>();

/** EN: 9 minutes — see module docblock for why this beat's CC's 10 min.
 *  中: 9 分钟兜底，留 1 分钟给 CC fallback。 */
const INTERNAL_TIMEOUT_MS = 9 * 60 * 1000;

export interface RequestDecisionArgs {
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  toolInput: Record<string, unknown>;
  /** AbortSignal from the HTTP request — fires when CC aborts axios
   *  (e.g. user Ctrl-C'd terminal, CC interrupted a tool). When this
   *  fires we resolve with `ask` and let CC handle the fallback. */
  signal?: AbortSignal;
  /** Side-effect: invoked synchronously inside requestDecision after
   *  the pending entry is registered but BEFORE the promise is
   *  awaited. Used to broadcast the `permission-prompt` SSE event so
   *  the browser banner appears. Keeping the broadcast as a callback
   *  (rather than importing sseHub here) keeps this module a pure
   *  in-memory state machine — easier to unit test.
   *  中: 注册完 pending 后调，发 SSE 让 banner 出现。 */
  onRegistered?: (promptId: string) => void;
}

/** EN: register a pending prompt + return a Promise that resolves
 *  to the user's decision. The promptId is generated internally; the
 *  caller broadcasts it via the `onRegistered` callback (this module
 *  doesn't import sseHub so it stays test-friendly).
 *  中: 注册等待 + 返 promise。promptId 内部生成，caller 通过
 *  onRegistered 拿到去广播 SSE。 */
export function requestDecision(args: RequestDecisionArgs): Promise<HttpHookDecision> {
  const promptId = `httpperm-${crypto.randomUUID()}`;
  return new Promise<HttpHookDecision>((resolve) => {
    let settled = false;
    const settle = (decision: HttpHookDecision): void => {
      if (settled) return;
      settled = true;
      pending.delete(promptId);
      clearTimeout(timer);
      if (args.signal) {
        try {
          args.signal.removeEventListener("abort", onAbort);
        } catch {
          // older AbortSignal impls may not support removeEventListener
          // for AbortSignal — ignore.
        }
      }
      resolve(decision);
    };
    const cleanup = (): void => settle({ decision: "ask" });
    const onAbort = (): void => {
      settle({
        decision: "ask",
        reason: "Loomscope: request aborted before user decided",
      });
    };
    const timer = setTimeout(() => {
      settle({
        decision: "ask",
        reason:
          "Loomscope: 9 min decision window elapsed; falling back to terminal prompt",
      });
    }, INTERNAL_TIMEOUT_MS);
    // Don't keep the Node event loop alive just for this timer;
    // server shutdown should not block waiting for 9 min.
    // 中: 不让定时器阻塞 Node 进程退出。
    if (typeof timer.unref === "function") timer.unref();

    if (args.signal) {
      if (args.signal.aborted) {
        onAbort();
        return;
      }
      args.signal.addEventListener("abort", onAbort, { once: true });
    }

    const entry: PendingHttpHookPrompt = {
      id: promptId,
      sessionId: args.sessionId,
      toolName: args.toolName,
      toolUseId: args.toolUseId,
      toolInput: args.toolInput,
      createdAt: Date.now(),
      resolve: settle,
      cleanup,
    };
    pending.set(promptId, entry);
    if (args.onRegistered) args.onRegistered(promptId);
  });
}

/** EN: resolve a pending prompt from the browser's POST /decision
 *  call. Returns true if the promptId was found + resolved, false
 *  if the prompt is unknown (already resolved / never existed —
 *  caller should 404 in that case).
 *  中: 浏览器 POST /decision 来解决等待。promptId 不存在时返 false
 *  让 route 404。 */
export function resolveDecision(
  promptId: string,
  decision: HttpHookDecision,
): boolean {
  const entry = pending.get(promptId);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

/** EN: snapshot of currently-pending prompts for one session. Used by
 *  the SSE /events route on subscribe so a late-joining tab sees the
 *  banner instead of waiting for the next prompt.
 *  中: 给 SSE catchup 用——新订阅者上线时把当前 pending 推过去。 */
export function pendingPromptsFor(sessionId: string): Array<{
  promptId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
}> {
  const out: Array<{
    promptId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    createdAt: number;
  }> = [];
  for (const entry of pending.values()) {
    if (entry.sessionId !== sessionId) continue;
    out.push({
      promptId: entry.id,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      createdAt: entry.createdAt,
    });
  }
  return out;
}

/** EN: look up a pending prompt's metadata by id WITHOUT resolving it.
 *  The /decision route uses this to know (sessionId, toolName) for
 *  rule-save + SSE-broadcast purposes before calling resolveDecision.
 *  Returns null when promptId is unknown.
 *  中: 仅读取，不 resolve。/decision route 在 resolve 前需要拿
 *  sessionId/toolName。 */
export function peekPrompt(promptId: string): {
  sessionId: string;
  toolName: string;
  toolUseId?: string;
} | null {
  const entry = pending.get(promptId);
  if (!entry) return null;
  return {
    sessionId: entry.sessionId,
    toolName: entry.toolName,
    toolUseId: entry.toolUseId,
  };
}

/** Test helper. */
export function _resetHttpHookPermissionGateForTests(): void {
  for (const entry of [...pending.values()]) entry.cleanup();
  pending.clear();
}

/** Test helper: peek state for assertions. */
export function _peekPendingForTests(): Array<{
  promptId: string;
  sessionId: string;
  toolName: string;
}> {
  return [...pending.values()].map((e) => ({
    promptId: e.id,
    sessionId: e.sessionId,
    toolName: e.toolName,
  }));
}
