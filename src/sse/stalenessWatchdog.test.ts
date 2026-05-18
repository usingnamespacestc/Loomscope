// EN (2026-05-17, P5/P2/P3): deterministic unit tests for the SSE
// staleness watchdog logic (clock injected — no fake DOM timers).

import { describe, expect, it } from "vitest";

import {
  SSE_STALE_MS,
  SSE_WATCHDOG_TICK_MS,
  createSseWatchdog,
} from "@/sse/stalenessWatchdog";

describe("createSseWatchdog", () => {
  it("does not trip while events keep arriving within staleMs", () => {
    let t = 1_000;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    for (let i = 0; i < 10; i++) {
      t += 90; // < staleMs each step
      wd.noteEvent();
      expect(wd.check()).toBe(false);
    }
  });

  it("trips exactly once when no event for > staleMs (no storm)", () => {
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    wd.noteEvent(); // last event at t=0
    t = 50;
    expect(wd.check()).toBe(false); // 50 ≤ 100
    t = 101;
    expect(wd.check()).toBe(true); // 101 > 100 → trip
    // One-shot: subsequent checks during the SAME stale episode stay
    // false so we don't reconnect-storm every tick.
    t = 500;
    expect(wd.check()).toBe(false);
    t = 5_000;
    expect(wd.check()).toBe(false);
  });

  it("re-arms after a fresh event (noteEvent) and can trip again", () => {
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    t = 200;
    expect(wd.check()).toBe(true); // first stale episode
    expect(wd.check()).toBe(false); // one-shot
    t = 210;
    wd.noteEvent(); // connection recovered, event flowing again
    t = 250;
    expect(wd.check()).toBe(false); // within grace from t=210
    t = 311;
    expect(wd.check()).toBe(true); // stale AGAIN → trips again
  });

  it("reset() gives a full fresh grace window (post-reconnect)", () => {
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    t = 500;
    expect(wd.check()).toBe(true); // stale
    wd.reset(); // caller issued a reconnect at t=500
    t = 590;
    expect(wd.check()).toBe(false); // 90 since reset ≤ 100
    t = 601;
    expect(wd.check()).toBe(true); // 101 since reset → trips
  });

  it("boundary: exactly staleMs is NOT stale (strictly greater)", () => {
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    wd.noteEvent();
    t = 100;
    expect(wd.check()).toBe(false); // == staleMs, not >
    t = 101;
    expect(wd.check()).toBe(true);
  });

  it("ships sane production constants (trip > ~3 server heartbeats; tick << stale)", () => {
    // Server SSE heartbeat = 25 s. Trip must allow missing a couple
    // heartbeats + jitter, and the poll must resolve well under it.
    expect(SSE_STALE_MS).toBeGreaterThan(25_000 * 3);
    expect(SSE_WATCHDOG_TICK_MS).toBeLessThan(SSE_STALE_MS / 2);
  });
});
