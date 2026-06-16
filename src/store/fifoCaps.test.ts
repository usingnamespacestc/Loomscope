// Regression: the per-session dedup Set (rawAppliedRecordUuids) and the
// per-ChatNode viewport Map (workflowViewports) used to grow unbounded
// for the whole session lifetime on a long live tail. They're now FIFO-
// capped. These exercise the cap helpers directly (the public store
// paths only hit the caps after tens of thousands of records).
import { describe, expect, it } from "vitest";

import {
  capMapFifo,
  capSetFifo,
  RAW_APPLIED_UUID_CAP,
  WORKFLOW_VIEWPORT_CAP,
} from "@/store/sessionSlice";

describe("FIFO caps", () => {
  it("capSetFifo drops the OLDEST entries, keeping the most recent `cap`", () => {
    const s = new Set<number>();
    for (let i = 0; i < 10; i++) s.add(i);
    capSetFifo(s, 4);
    expect(s.size).toBe(4);
    // Oldest (0..5) evicted; newest (6..9) retained.
    expect([...s]).toEqual([6, 7, 8, 9]);
  });

  it("capSetFifo is a no-op when already within cap", () => {
    const s = new Set([1, 2, 3]);
    capSetFifo(s, 10);
    expect([...s]).toEqual([1, 2, 3]);
  });

  it("capMapFifo drops the oldest keys, keeping the most recent `cap`", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 6; i++) m.set(`k${i}`, i);
    capMapFifo(m, 2);
    expect([...m.keys()]).toEqual(["k4", "k5"]);
  });

  it("caps are positive and generous enough not to bite normal sessions", () => {
    expect(RAW_APPLIED_UUID_CAP).toBeGreaterThanOrEqual(10_000);
    expect(WORKFLOW_VIEWPORT_CAP).toBeGreaterThanOrEqual(64);
  });
});
