// EN: v0.9 file-tail SSE pub/sub hub. file-tail mode pushes "this
// session's jsonl changed, refetch" events server → browsers. The
// watcher (sessionWatcher.ts) publishes; the SSE route at
// /:id/events registers a Subscriber per connected EventSource and
// hands its `send` function to the hub. Keeping pub/sub in its own
// module lets future event sources (CC settings.json hooks → POST →
// broadcast) plug in without touching the watcher.
//
// Lifetime: in-memory only, single process. Reconnects are the
// EventSource client's responsibility (browser auto-retries every
// `retry:` ms by default).
//
// Event shape (data is JSON-encoded):
//   event: hello       — sent once on connect, payload { sessionId }
//   event: invalidate  — fs change, payload { sessionId, kind, ... }
//   event: ping        — periodic heartbeat, payload {}
//
// Per-session granularity (not per-connection): multiple browser tabs
// viewing the same session share a subscriber set; all get the same
// invalidate fanout.
//
// 中: v0.9 file-tail 的 SSE 发布订阅中心。file-tail 模式让 server
// 在 jsonl 变化时把"该 session 已变，请刷新"事件推送给所有连着的
// 浏览器。watcher (sessionWatcher.ts) 是 publisher；SSE 路由
// /:id/events 给每个 EventSource 注册一个 Subscriber 并把它的 send
// 函数交给本 hub。把 pub/sub 抽出来后，未来 CC settings.json
// hooks（POST → broadcast）也能无缝接入。
export interface SseSubscriber {
  send: (msg: SseMessage) => void;
}

export interface SseMessage {
  event: string;
  data: unknown;
}

const subscribers = new Map<string, Set<SseSubscriber>>();

// PR-1 (2026-05-18, convergence rework §9.4): every outbound SSE
// signal carries a top-level `version` so the client has ONE place
// to read the server-authoritative monotonic seq regardless of event
// type (delta/raw-records/cc-hook/sdk-*/invalidate/…). Injected via a
// resolver rather than importing `getCurrentSeq` directly, because
// `chatFlowDeltaEngine` already imports `broadcast` from here — a
// direct import would be circular. Wired at `createApp`. Default 0
// so tests / pre-wire boot don't crash. PLUMBING ONLY: nothing
// consumes `version` for control flow in PR-1.
let versionResolver: (sessionId: string) => number = () => 0;
export function setSseVersionResolver(
  fn: (sessionId: string) => number,
): void {
  versionResolver = fn;
}

export function subscribe(sessionId: string, sub: SseSubscriber): () => void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(sub);
  return () => {
    const s = subscribers.get(sessionId);
    if (!s) return;
    s.delete(sub);
    if (s.size === 0) subscribers.delete(sessionId);
  };
}

export function broadcast(sessionId: string, msg: SseMessage): void {
  const set = subscribers.get(sessionId);
  if (!set) return;
  // PR-1: stamp a top-level `version` on the payload when it's an
  // object and doesn't already carry one (delta/checkpoint/drift-ping
  // already embed seq — leave their shape, just add the uniform
  // top-level field too so the client reads `version` consistently).
  // Additive; recorded-not-consumed client-side in PR-1.
  let outMsg = msg;
  if (msg.data && typeof msg.data === "object" && !Array.isArray(msg.data)) {
    const d = msg.data as Record<string, unknown>;
    // Stamp ONLY events that carry NEITHER `version` NOR `seq`.
    // delta / checkpoint / drift-ping already convey the version via
    // `seq` — leaving their shape byte-identical keeps PR-1 a true
    // zero-wire-change for every already-versioned payload (and keeps
    // their exact-shape unit tests green). Only the seq-less signals
    // (raw-records / cc-hook / sdk-* / invalidate) gain `version`.
    if (d.version === undefined && d.seq === undefined) {
      outMsg = {
        event: msg.event,
        data: { ...d, version: versionResolver(sessionId) },
      };
    }
  }
  // Snapshot — `send` may indirectly trigger unsubscribe (e.g. write
  // failure tearing down the stream); iterating the live Set would skip
  // entries.
  for (const sub of [...set]) {
    try {
      sub.send(outMsg);
    } catch (err) {
      console.error("[sseHub] subscriber send threw:", err);
    }
  }
}

export function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}

// Test/debug helper.
export function _resetForTests(): void {
  subscribers.clear();
}
