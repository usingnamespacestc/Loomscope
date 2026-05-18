// EN (2026-05-17, P5/P2/P3): client-side SSE staleness watchdog.
//
// Root cause it addresses: the per-session EventSource can go
// HALF-OPEN — TCP alive but zero bytes flowing (dev proxy idle-kill,
// NAT/keepalive timeout, laptop sleep, a held upstream long-poll
// starving the proxy, …). The browser EventSource fires NO `error`
// for a half-open socket, so:
//   • no auto-reconnect → no `hello` → the #327995e hello-reconnect
//     recovery never triggers
//   • `drift-ping` (the 30 s safety net) is ITSELF an SSE event, so
//     it's silent too
// Result: delta + cc-hook + drift all go dark for that session and
// the UI freezes (stale content, banner stuck, running-time stuck)
// until a manual full-page refresh. Exactly the P5/P2/P3 report.
//
// The server already emits a `ping` heartbeat every 25 s; the client
// just never noticed its ABSENCE. This watchdog does: any SSE event
// (incl. ping/hello) calls `noteEvent()`; a periodic `check()`
// returns true once when no event has arrived for `staleMs` — the
// caller then force-reconnects + resyncs.
//
// Pure + clock-injectable so it's fully deterministic to unit test
// (no fake DOM timers needed for the logic itself).
//
// 中: SSE 半开（TCP 活着但无数据）时浏览器不报 error → 不重连 →
// #327995e 不触发，drift-ping 也是 SSE 事件同样静默 → 整个 session
// 冻结直到手动刷新。服务端每 25s 发 ping，客户端从不检测其"缺席"。
// 本 watchdog：任何事件 noteEvent()，周期 check()，超时一次性返回
// true 让调用方强制重连 + 重新同步。

export interface SseWatchdog {
  /** Call on EVERY received SSE event (including ping / hello). */
  noteEvent(): void;
  /** Periodic poll. Returns true EXACTLY ONCE per stale episode —
   *  i.e. when `now - lastEvent > staleMs` and we haven't already
   *  reported this episode. Stays false afterwards until `noteEvent`
   *  (a fresh event arrived) or `reset` (a reconnect was issued)
   *  re-arms it. The one-shot semantics prevent a reconnect storm. */
  check(): boolean;
  /** Re-arm after a (re)connect: clears the stale flag + treats now
   *  as the last-event time so a freshly-opened connection gets a
   *  full `staleMs` grace window before it can trip again. */
  reset(): void;
}

export function createSseWatchdog(opts: {
  staleMs: number;
  /** Injectable clock (defaults to Date.now) — tests pass a fake. */
  now?: () => number;
}): SseWatchdog {
  const now = opts.now ?? (() => Date.now());
  let lastEventAt = now();
  let reported = false;
  return {
    noteEvent() {
      lastEventAt = now();
      reported = false;
    },
    check() {
      if (reported) return false;
      if (now() - lastEventAt > opts.staleMs) {
        reported = true;
        return true;
      }
      return false;
    },
    reset() {
      lastEventAt = now();
      reported = false;
    },
  };
}

// Server heartbeat is SSE_HEARTBEAT_MS = 25 s (sessions.ts). Trip
// after missing ~3 heartbeats; the extra margin tolerates GC pauses,
// a busy delta burst delaying a ping, and dev-proxy jitter. Tighter
// than this risks false reconnects on a healthy-but-bursty stream.
// 中: 服务端心跳 25s；漏 ~3 拍（80s）才判定半开，留足抖动余量。
export const SSE_STALE_MS = 80_000;
// Poll cadence — cheap; resolution well under SSE_STALE_MS.
export const SSE_WATCHDOG_TICK_MS = 15_000;
