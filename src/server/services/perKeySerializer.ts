// EN (v2.6): per-key async serializer with single-slot coalescing.
//
// Built for the main-jsonl change handler in app.ts, which used to be
// fire-and-forget: buildChatFlow takes 1.5-2.5s while the watcher
// throttle only guarantees ~250ms spacing, so two handler runs for the
// SAME session could overlap and mutate the shared incremental stashes
// (chatFlowCache.stateStash, mergedChatFlowLoader's closureMemberStash
// / mergedChatFlowSnapshot) concurrently — computing `newRecords`
// against a baseline another run had already advanced.
//
// Semantics:
//   - runs for the same key never overlap (chained);
//   - at most ONE run is queued behind the running one. Additional
//     fires while a run is queued are dropped: the queued run hasn't
//     started yet, so it will observe everything those fires would —
//     the task re-reads the file from scratch when it runs.
//   - different keys are fully independent;
//   - a rejected task never breaks the chain (callers are expected to
//     log their own errors; we swallow to keep the key usable).
//
// 中: per-key 串行 + 只排队一个。同 key 任务永不重叠;运行中再来的
// 触发排队一个,排队期间的更多触发直接丢弃(排队任务启动时会重读
// 文件,自然覆盖)。不同 key 互不影响;任务抛错不会断链。
export interface PerKeySerializer {
  /** Schedule `task` for `key`. Never throws; never returns a value —
   * fire-and-forget by design (matches the watcher pipeline). */
  run(key: string, task: () => Promise<void>): void;
  /** Test-only: number of keys with a live (running/queued) chain. */
  _sizeForTests(): number;
}

export function createPerKeySerializer(): PerKeySerializer {
  const running = new Map<string, Promise<void>>();
  const queued = new Set<string>();

  function run(key: string, task: () => Promise<void>): void {
    if (queued.has(key)) return; // the queued run will see this change
    const prev = running.get(key);
    let started: Promise<void>;
    if (prev) {
      queued.add(key);
      started = prev.then(() => {
        queued.delete(key);
        return task();
      });
    } else {
      // Route through a resolved promise so a synchronously-throwing
      // task becomes a rejection instead of escaping run().
      // 中: 经 resolved promise 中转,同步抛错也变成 rejection,不逃出 run()。
      started = Promise.resolve().then(() => task());
    }
    // Swallow rejections so one failed run can't wedge the key's chain.
    // 中: 吞掉 rejection,单次失败不卡死该 key 的链。
    const settled = started.then(
      () => {},
      () => {},
    );
    running.set(key, settled);
    void settled.then(() => {
      if (running.get(key) === settled) running.delete(key);
    });
  }

  return { run, _sizeForTests: () => running.size };
}
