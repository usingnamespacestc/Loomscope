// EN (v2.6): idle-evicting Map for the per-session server stashes.
//
// Background: several server maps keyed by sessionId hold roughly a
// full jsonl's worth of parsed records or a whole ChatFlow —
// chatFlowCache.stateStash, mergedChatFlowLoader's closureMemberStash
// / mergedChatFlowSnapshot, chatFlowDeltaEngine.snapshots. Their
// unsubscribe-time cleanup was deliberately removed in v2.1 PR D5
// (resetting on reconnect blips caused 650-event re-emit floods), but
// nothing replaced it: a long-lived server retains one footprint per
// session EVER browsed. Browse N large sessions over a week without a
// restart → N × 5-25 MB held forever.
//
// This wrapper evicts by IDLE TIME + entry cap instead of by
// unsubscribe, which preserves the D5 rationale: a tab refresh or
// proxy blip reconnects within seconds, finds its stash intact, and no
// re-emit flood happens. Only a session untouched for a full TTL
// (default 30 min) is dropped — equivalent, for that session, to a
// server restart, a state every consumer already handles via its
// full-parse / cold-start fallback (at worst one full rebuild + one
// re-emit the client dedups).
//
// Sweeps run opportunistically on set() — the maps only grow on
// writes, so bounding at write time bounds growth. No timers: nothing
// to unref, nothing to leak, trivially testable.
//
// 中: per-session stash 的闲置淘汰 Map。PR-D5 拿掉了 unsubscribe 清理
// (重连风暴)但没有替代品,长驻服务浏览过的每个 session 都永久占一份
// 解析结果。改为"闲置 TTL + 条数上限":刷新页面秒级重连不受影响,
// 只有整整 TTL 没碰过的 session 才被踢——对它而言等价于服务重启,
// 所有消费方本来就能处理(全量重建兜底)。set 时机会式清扫,无定时器。
export interface IdleMap<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
  readonly size: number;
}

export function createIdleMap<V>(opts: {
  /** Entries untouched (no get/set) for this long are evicted. */
  ttlMs: number;
  /** Hard cap; beyond it the least-recently-touched entries go. */
  maxEntries: number;
  /** Clock injection for tests. */
  now?: () => number;
}): IdleMap<V> {
  const { ttlMs, maxEntries } = opts;
  const now = opts.now ?? Date.now;
  // Insertion order ≈ touch order: get() and set() re-insert, so the
  // first key is always the least-recently-touched.
  const entries = new Map<string, { value: V; touched: number }>();

  function sweep(): void {
    const cutoff = now() - ttlMs;
    for (const [k, e] of entries) {
      // Ordered by touch time — stop at the first fresh entry.
      if (e.touched > cutoff) break;
      entries.delete(k);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    get(key: string): V | undefined {
      const e = entries.get(key);
      if (!e) return undefined;
      // TTL is checked lazily on read too, so a stale entry can't be
      // revived by the very access that should have found it gone.
      if (e.touched <= now() - ttlMs) {
        entries.delete(key);
        return undefined;
      }
      e.touched = now();
      entries.delete(key);
      entries.set(key, e); // bump to MRU end
      return e.value;
    },
    set(key: string, value: V): void {
      entries.delete(key);
      entries.set(key, { value, touched: now() });
      sweep();
    },
    delete(key: string): boolean {
      return entries.delete(key);
    },
    clear(): void {
      entries.clear();
    },
    keys(): string[] {
      return [...entries.keys()];
    },
    get size(): number {
      return entries.size;
    },
  };
}
