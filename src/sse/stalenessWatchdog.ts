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
  /** Call on EVERY received SSE event (including ping / hello). Also
   *  ARMS the watchdog: it cannot trip until the connection has
   *  delivered at least one event (see `armed` rationale below). */
  noteEvent(): void;
  /** Periodic poll. Returns true EXACTLY ONCE per stale episode —
   *  when `now - lastEvent > staleMs` — and never:
   *   • before the first `noteEvent` (not armed), nor
   *   • again within `cooldownMs` of the previous trip (storm guard),
   *     nor twice in the same episode (one-shot).
   *  Re-arms only via `noteEvent` (a fresh event) or `reset`. */
  check(): boolean;
  /** Re-arm after a (re)connect: clears the stale flag + treats now
   *  as the last-event time so a freshly-opened connection gets a
   *  full `staleMs` grace window. Keeps the cooldown clock so a
   *  misfire-driven reset cannot immediately re-trip. Stays armed —
   *  a reconnect we just issued is itself a live signal. */
  reset(): void;
}

export function createSseWatchdog(opts: {
  staleMs: number;
  /** Minimum wall-clock between two trips. Bounds the worst case to
   *  ONE recovery per cooldown window even if the recovery itself
   *  (a heavy refreshSession on a huge session) janks the main
   *  thread long enough to look stale again — that false re-trip
   *  was the P5 watchdog's large-session regression. Default 0
   *  (back-compat / opt-in). */
  cooldownMs?: number;
  /** Injectable clock (defaults to Date.now) — tests pass a fake. */
  now?: () => number;
}): SseWatchdog {
  const now = opts.now ?? (() => Date.now());
  const cooldownMs = opts.cooldownMs ?? 0;
  let lastEventAt = now();
  let reported = false;
  // ARM-ON-FIRST-EVENT. The clock starts at construction, but a cold
  // open of a huge session (server building a 600-turn chatflow from
  // a multi-MB jsonl on first load + the client applying/​laying out
  // 600 nodes) can block the main thread / delay the first `hello`
  // for longer than staleMs — burning the whole budget before the
  // connection has even proven dead. That false trip kicks off a
  // heavy refreshSession which janks again → trip storm (the exact
  // sse_longconv regression). So: don't count staleness until the
  // connection has delivered its first event.
  // 中: 时钟从构造起算，但大 session 冷启动会在首个 hello 前就耗光
  // 预算 → 误判 → 重 refresh → 风暴。所以首个事件到达前不计 staleness。
  let armed = false;
  let lastTripAt: number | null = null;
  return {
    noteEvent() {
      armed = true;
      lastEventAt = now();
      reported = false;
    },
    check() {
      if (!armed || reported) return false;
      if (
        cooldownMs > 0 &&
        lastTripAt !== null &&
        now() - lastTripAt < cooldownMs
      ) {
        return false;
      }
      if (now() - lastEventAt > opts.staleMs) {
        reported = true;
        lastTripAt = now();
        return true;
      }
      return false;
    },
    reset() {
      lastEventAt = now();
      reported = false;
      armed = true; // the reconnect we just issued is a live signal
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
// Storm guard. After a trip, suppress further trips for this long so
// at most ONE recovery (force-reconnect + refreshSession) runs per
// window. Generous vs. the worst-case recovery cost on a very large
// session (a full lite-chatflow GET + apply + relayout of hundreds of
// ChatNodes is seconds, not minutes) so a slow recovery can never
// re-trip mid-flight. A genuinely still-dead socket is simply cured
// on the next post-cooldown cycle (slower cadence, still self-heals).
// 中: 一次 trip 后冷却 60s；大 session 的 recovery 最多几秒，冷却
// 足以覆盖，杜绝风暴；真半开的下个周期照样自愈。
export const SSE_WATCHDOG_COOLDOWN_MS = 60_000;
