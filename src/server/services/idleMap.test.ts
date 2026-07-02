// v2.6: tests for the idle-evicting stash map (leak fix — see
// idleMap.ts docblock for why unsubscribe-time cleanup was not an
// option).
import { describe, expect, it } from "vitest";

import { createIdleMap } from "./idleMap";

function withClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createIdleMap", () => {
  it("round-trips get/set/delete like a plain Map", () => {
    const m = createIdleMap<string>({ ttlMs: 1000, maxEntries: 10 });
    m.set("a", "1");
    expect(m.get("a")).toBe("1");
    expect(m.size).toBe(1);
    expect(m.delete("a")).toBe(true);
    expect(m.get("a")).toBeUndefined();
  });

  it("evicts entries idle past the TTL on the next write", () => {
    const clock = withClock();
    const m = createIdleMap<string>({
      ttlMs: 1000,
      maxEntries: 10,
      now: clock.now,
    });
    m.set("stale", "x");
    clock.advance(1500);
    m.set("fresh", "y"); // opportunistic sweep runs here
    expect(m.keys()).toEqual(["fresh"]);
  });

  it("get() refuses to revive an entry that outlived the TTL", () => {
    const clock = withClock();
    const m = createIdleMap<string>({
      ttlMs: 1000,
      maxEntries: 10,
      now: clock.now,
    });
    m.set("a", "x");
    clock.advance(1500);
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it("touching via get() keeps an entry alive across sweeps (D5: reconnect blips survive)", () => {
    const clock = withClock();
    const m = createIdleMap<string>({
      ttlMs: 1000,
      maxEntries: 10,
      now: clock.now,
    });
    m.set("hot", "x");
    for (let i = 0; i < 5; i += 1) {
      clock.advance(600); // never a full TTL of silence
      expect(m.get("hot")).toBe("x");
    }
    m.set("other", "y");
    expect(m.get("hot")).toBe("x");
  });

  it("caps entries at maxEntries, evicting the least-recently-touched", () => {
    const m = createIdleMap<string>({ ttlMs: 60_000, maxEntries: 3 });
    m.set("a", "1");
    m.set("b", "2");
    m.set("c", "3");
    m.get("a"); // bump "a" — "b" is now the coldest
    m.set("d", "4");
    expect(m.keys().sort()).toEqual(["a", "c", "d"]);
  });

  it("re-setting an existing key updates in place without eviction", () => {
    const m = createIdleMap<string>({ ttlMs: 60_000, maxEntries: 2 });
    m.set("a", "1");
    m.set("b", "2");
    m.set("a", "1'");
    expect(m.get("a")).toBe("1'");
    expect(m.size).toBe(2);
  });

  it("clear() empties everything", () => {
    const m = createIdleMap<string>({ ttlMs: 60_000, maxEntries: 5 });
    m.set("a", "1");
    m.set("b", "2");
    m.clear();
    expect(m.size).toBe(0);
    expect(m.keys()).toEqual([]);
  });
});
