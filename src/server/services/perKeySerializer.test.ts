// v2.6: unit tests for the per-key serializer that guards the
// main-jsonl change handler against overlapping runs (shared-stash
// race — see perKeySerializer.ts docblock).
// 中: per-key 串行器单测——同 key 不重叠、突发合并只排队一个、
// 异 key 独立、抛错不断链。
import { describe, expect, it } from "vitest";

import { createPerKeySerializer } from "./perKeySerializer";

/** A task whose completion the test controls. */
function gate(): { task: () => Promise<void>; open: () => void } {
  let release!: () => void;
  const p = new Promise<void>((res) => {
    release = res;
  });
  return { task: () => p, open: release };
}

const tick = () => new Promise<void>((res) => setTimeout(res, 0));

describe("createPerKeySerializer", () => {
  it("runs for the same key never overlap", async () => {
    const s = createPerKeySerializer();
    const events: string[] = [];
    const g1 = gate();
    s.run("a", async () => {
      events.push("start1");
      await g1.task();
      events.push("end1");
    });
    s.run("a", async () => {
      events.push("start2");
    });
    await tick();
    // Second run must NOT have started while the first is in flight.
    expect(events).toEqual(["start1"]);
    g1.open();
    await tick();
    expect(events).toEqual(["start1", "end1", "start2"]);
  });

  it("coalesces: at most one run queued — intermediate fires dropped", async () => {
    const s = createPerKeySerializer();
    let ran = 0;
    const g1 = gate();
    s.run("a", async () => {
      await g1.task();
    });
    // Three fires while the first run is in flight → exactly ONE
    // queued run (it re-reads the file, so the drops lose nothing).
    s.run("a", async () => {
      ran += 1;
    });
    s.run("a", async () => {
      ran += 1;
    });
    s.run("a", async () => {
      ran += 1;
    });
    g1.open();
    await tick();
    await tick();
    expect(ran).toBe(1);
  });

  it("different keys run independently (no cross-key blocking)", async () => {
    const s = createPerKeySerializer();
    const events: string[] = [];
    const g1 = gate();
    s.run("a", async () => {
      await g1.task();
      events.push("a");
    });
    s.run("b", async () => {
      events.push("b");
    });
    await tick();
    // "b" completes while "a" is still gated.
    expect(events).toEqual(["b"]);
    g1.open();
    await tick();
    expect(events).toEqual(["b", "a"]);
  });

  it("a rejected task does not wedge the key's chain", async () => {
    const s = createPerKeySerializer();
    const events: string[] = [];
    s.run("a", async () => {
      throw new Error("boom");
    });
    await tick();
    s.run("a", async () => {
      events.push("after-failure");
    });
    await tick();
    expect(events).toEqual(["after-failure"]);
  });

  it("a synchronously-throwing task does not escape run()", async () => {
    const s = createPerKeySerializer();
    expect(() =>
      s.run("a", () => {
        throw new Error("sync boom");
      }),
    ).not.toThrow();
    await tick();
    const events: string[] = [];
    s.run("a", async () => {
      events.push("ok");
    });
    await tick();
    expect(events).toEqual(["ok"]);
  });

  it("cleans up its running map once the chain drains", async () => {
    const s = createPerKeySerializer();
    s.run("a", async () => {});
    s.run("b", async () => {});
    await tick();
    await tick();
    expect(s._sizeForTests()).toBe(0);
  });
});
