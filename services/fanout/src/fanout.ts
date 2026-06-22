// Core fanout logic, separated from the Hono server so it's unit-testable
// with a mock fetcher (no live upstreams, no listening port).
//
// Two dispatch modes:
//
//   1. Fire-and-forget (default for most hook events). Every upstream
//      gets the POST; middleware doesn't wait. CC sees 204 immediately.
//      Failures logged, not retried, not propagated. Used for
//      observability events (PostToolUse, SessionStart, etc) where
//      delivery loss is acceptable but blocking CC is not.
//
//   2. Race-with-abort (PreToolUse). Both upstreams receive the hook
//      and raise a permission banner in their UI. As soon as ONE
//      upstream returns a decisive response (allow/deny — not "ask"
//      or 204), the middleware:
//        a) returns that response to CC,
//        b) aborts every other outbound request.
//      The losing upstream's `requestDecision` already listens for
//      AbortSignal — its handler fires `cleanup()` → existing
//      `permission-prompt-resolved` SSE → loser's UI auto-clears its
//      banner. NO upstream code changes needed for this path (we keep
//      the explicit /dismiss-prompt endpoint from Phase 1 as a manual
//      cancel mechanism, but the abort path handles the steady state).
//
// 中: 两种分发。fire-and-forget 用于观测事件,即时 204;race-with-abort
// 用于 PreToolUse,首个 decisive 响应赢,abort 其余 → 上游 AbortSignal
// 处理器自动 cleanup → SSE → UI 自清。

export interface FanoutDeps {
  /** Upstream Loomscope base URLs, no trailing slash. */
  upstreams: readonly string[];
  /** X-Loomscope-Secret to put on every outbound request. */
  secret: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Max wait for any decisive PreToolUse response, ms. */
  preToolUseDecisiveTimeoutMs?: number;
  /** Optional sink for non-fatal errors. Default: console.warn. */
  onWarn?: (msg: string, err: unknown) => void;
}

export interface FanoutResult {
  status: number;
  body: string;
  contentType: string | null;
}

const ASK_FALLBACK: FanoutResult = {
  status: 204,
  body: "",
  contentType: null,
};

const DEFAULT_TIMEOUT_MS = 9 * 60 * 1000;

/** Fire-and-forget POST to every upstream. Returns synchronously after
 *  scheduling the requests; the caller can immediately 204 CC. Errors
 *  are logged but never thrown.
 *  中: 同步派发,立即返回让上层 204 CC。错误只记不抛。 */
export function fireAndForgetFanout(
  deps: FanoutDeps,
  event: string,
  body: string,
): void {
  const fetcher = deps.fetcher ?? fetch;
  const warn = deps.onWarn ?? ((m, e) => console.warn(`[fanout] ${m}`, e));
  for (const upstream of deps.upstreams) {
    void fetcher(
      `${upstream}/api/cc-hook?event=${encodeURIComponent(event)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Loomscope-Secret": deps.secret,
        },
        body,
      },
    ).catch((err: unknown) => {
      warn(`fire-and-forget to ${upstream} failed`, err);
    });
  }
}

/** Race-fanout for PreToolUse. Fans the body to every upstream and
 *  resolves with the first DECISIVE response (status != 204 and the
 *  response's `permissionDecision` field isn't "ask"). On first
 *  winner, aborts every other outbound request — the upstream's
 *  AbortSignal handler runs cleanup() → existing onSettled → SSE →
 *  UI clears banner, with no upstream code change required.
 *
 *  If all upstreams return non-decisive responses (or error / time
 *  out), resolves with ASK_FALLBACK (204) so the caller returns 204
 *  to CC and CC falls back to its default terminal behavior.
 *
 *  中: 首个 decisive 响应赢,abort 其他;全部非 decisive 时返 204 让
 *  CC 走 terminal fallback。 */
export async function racePreToolUseFanout(
  deps: FanoutDeps,
  body: string,
): Promise<FanoutResult> {
  if (deps.upstreams.length === 0) return ASK_FALLBACK;
  const fetcher = deps.fetcher ?? fetch;
  const controllers = deps.upstreams.map(() => new AbortController());
  const timeoutMs = deps.preToolUseDecisiveTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Don't keep the Node event loop alive just for the cutoff timer.
  // 中: 别让定时器阻塞退出。
  const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
    for (const c of controllers) {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    }
  }, timeoutMs);
  if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();

  try {
    // Promise.any rejects with AggregateError when ALL inputs reject.
    // Each request rejects EITHER on transport error OR on a
    // non-decisive (ask/204) response — both cases mean "this upstream
    // isn't the winner, keep waiting for another."
    const winner = await Promise.any(
      deps.upstreams.map(async (upstream, i) => {
        const r = await fetcher(
          `${upstream}/api/cc-hook?event=PreToolUse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Loomscope-Secret": deps.secret,
            },
            body,
            signal: controllers[i].signal,
          },
        );
        // 204 = upstream's gate is OFF (or matched a "never ask" rule,
        // already responded). Non-decisive — let other upstreams win.
        // 中: 204 表示对端门关 / 命中 always-allow 规则,无决策。
        if (r.status === 204) {
          throw new Error(`upstream ${upstream} returned 204 (non-decisive)`);
        }
        const text = await r.text();
        if (isAskResponse(text)) {
          throw new Error(`upstream ${upstream} returned ask (non-decisive)`);
        }
        return {
          status: r.status,
          body: text,
          contentType: r.headers.get("content-type"),
          idx: i,
        };
      }),
    );
    // Abort losers — their gates' AbortSignal handlers fire onSettled,
    // which broadcasts permission-prompt-resolved SSE, which the UI's
    // existing handler uses to drop the banner.
    // 中: abort losers → 上游 SSE → UI 自清。
    for (let i = 0; i < controllers.length; i++) {
      if (i === winner.idx) continue;
      try {
        controllers[i].abort();
      } catch {
        /* ignore */
      }
    }
    return {
      status: winner.status,
      body: winner.body,
      contentType: winner.contentType,
    };
  } catch {
    // AggregateError (all rejected) → fall back to ask. No noisy log;
    // upstream-down is a routine state, not an error.
    // 中: 全部 reject = 没人决策,正常 fallback。
    return ASK_FALLBACK;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Detect CC's "ask" permission decision in a hook response body.
 *  CC's PreToolUse response shape:
 *    { hookSpecificOutput: { hookEventName: "PreToolUse",
 *      permissionDecision: "allow" | "deny" | "ask" } }
 *  Anything not parseable / not "ask" counts as decisive — we let
 *  CC sort it out. */
function isAskResponse(body: string): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return parsed?.hookSpecificOutput?.permissionDecision === "ask";
  } catch {
    return false;
  }
}
