// EN (2026-05-17, P5/P2/P3): deterministic unit tests for the SSE
// staleness watchdog logic (clock injected — no fake DOM timers).
//
// v2 hardening (sse_longconv regression fix): the watchdog now
//   • ARMS on the first event (a cold open of a huge session can
//     delay the first `hello` past staleMs; that must not count as
//     "stale" — it would false-trip → heavy refresh → jank → storm),
//   • enforces a `cooldownMs` between trips so at most ONE recovery
//     runs per window even if the recovery itself janks long enough
//     to look stale again.

import { describe, expect, it } from "vitest";

import {
  SSE_STALE_MS,
  SSE_WATCHDOG_COOLDOWN_MS,
  SSE_WATCHDOG_TICK_MS,
  createSseWatchdog,
} from "@/sse/stalenessWatchdog";

describe("createSseWatchdog", () => {
  it("does not trip while events keep arriving within staleMs", () => {
    let t = 1_000;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    wd.noteEvent(); // arm
    for (let i = 0; i < 10; i++) {
      t += 90; // < staleMs each step
      wd.noteEvent();
      expect(wd.check()).toBe(false);
    }
  });

  it("trips exactly once when no event for > staleMs (no storm)", () => {
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    wd.noteEvent(); // arm + last event at t=0
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
    wd.noteEvent(); // arm at t=0
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
    wd.noteEvent(); // arm at t=0
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
    wd.noteEvent(); // arm at t=0
    t = 100;
    expect(wd.check()).toBe(false); // == staleMs, not >
    t = 101;
    expect(wd.check()).toBe(true);
  });

  // ── v2: arm-on-first-event ──────────────────────────────────────
  it("does NOT trip before the first event, no matter how long (cold open)", () => {
    // A 600-turn session's first `hello` can be delayed well past
    // staleMs by the heavy initial server build + client layout.
    // Counting that as staleness false-trips → heavy refresh → jank
    // → trip storm (the exact sse_longconv regression).
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    t = 10_000; // 100× staleMs of "silence" before the conn delivers
    expect(wd.check()).toBe(false); // not armed → never trips
    t = 50_000;
    expect(wd.check()).toBe(false);
    // First real event arrives → NOW the staleness clock starts.
    wd.noteEvent();
    t = 50_050;
    expect(wd.check()).toBe(false); // 50 since first event ≤ 100
    t = 50_201;
    expect(wd.check()).toBe(true); // 151 since first event → trips
  });

  // ── v2: cooldown storm guard ────────────────────────────────────
  it("cooldownMs bars a second trip within the window even if still stale", () => {
    // After a trip the recovery (a heavy refreshSession) can itself
    // jank long enough that the connection looks stale again the
    // instant it ends. Without a cooldown that re-trips immediately
    // → storm. With it, at most ONE recovery per window.
    let t = 0;
    const wd = createSseWatchdog({
      staleMs: 100,
      cooldownMs: 1_000,
      now: () => t,
    });
    wd.noteEvent(); // arm at t=0
    t = 200;
    expect(wd.check()).toBe(true); // trip #1 at t=200
    wd.reset(); // recovery issued a reconnect …
    // … but the heavy recovery janked: no events, instantly stale
    // again. Cooldown (1000ms since trip@200) must suppress.
    t = 350;
    expect(wd.check()).toBe(false); // 150 since trip < 1000 cooldown
    t = 900;
    expect(wd.check()).toBe(false); // still inside cooldown
    t = 1_150;
    expect(wd.check()).toBe(false); // 950 since trip — still < 1000
    // Past the cooldown AND still stale (no event since reset@200) →
    // a genuinely dead socket is finally cured on the next cycle.
    t = 1_250; // 1050 since trip@200 > cooldown; 1050 since reset>100
    expect(wd.check()).toBe(true);
  });

  it("cooldown defaults to 0 (opt-in) — back-compat behaviour", () => {
    let t = 0;
    const wd = createSseWatchdog({ staleMs: 100, now: () => t });
    wd.noteEvent();
    t = 200;
    expect(wd.check()).toBe(true);
    wd.reset();
    t = 400; // 200 since reset > 100, no cooldown → trips again
    expect(wd.check()).toBe(true);
  });

  it("ships sane production constants (trip > ~3 heartbeats; tick << stale; cooldown ≥ stale)", () => {
    // Server SSE heartbeat = 25 s. Trip must allow missing a couple
    // heartbeats + jitter; the poll must resolve well under it; the
    // cooldown must outlast a worst-case recovery so it can't storm.
    expect(SSE_STALE_MS).toBeGreaterThan(25_000 * 3);
    expect(SSE_WATCHDOG_TICK_MS).toBeLessThan(SSE_STALE_MS / 2);
    expect(SSE_WATCHDOG_COOLDOWN_MS).toBeGreaterThanOrEqual(SSE_STALE_MS / 2);
  });
});
