// EN (PR-2.5 slice 3a) — reproduce-first tests for the terminal-CC
// hook→lifecycle reducer. Drives the real reducer through the hook
// bus (same proven harness as pendingPermissionTracker.test). Slice
// 3a scope only: UserPromptSubmit→running, Stop/SessionEnd→clear.
// Lost-Stop transcript-cross-check + tight TTL = slice 3b (its own
// reproduce-first lost-Stop suite).
//
// 中: PR-2.5 slice 3a reducer 单测，经 hook 总线驱动真 reducer。本片
// 只覆盖 UserPromptSubmit→running / Stop|SessionEnd→clear；丢 Stop 的
// transcript 核对 + 紧 TTL 属 3b。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetHookBusForTests,
  publishHook,
  type HookEnvelope,
} from "@/server/services/hookEventBus";
import {
  _peekHookLifecycleForTests,
  _resetHookLifecycleReducerForTests,
  getTerminalTurnRunning,
  initHookLifecycleReducer,
} from "@/server/services/hookLifecycleReducer";

function env(sessionId: string): HookEnvelope {
  return { session_id: sessionId, cwd: "/tmp", extras: {} };
}

beforeEach(() => {
  _resetHookBusForTests();
  _resetHookLifecycleReducerForTests();
  initHookLifecycleReducer();
});
afterEach(() => {
  _resetHookBusForTests();
  _resetHookLifecycleReducerForTests();
});

describe("hookLifecycleReducer — terminal-CC turnRunning", () => {
  it("UserPromptSubmit → running { since }", () => {
    const t0 = Date.now();
    publishHook("UserPromptSubmit", env("sid-A"));
    const r = getTerminalTurnRunning("sid-A");
    expect(r).not.toBeNull();
    expect(r!.since).toBeGreaterThanOrEqual(t0);
  });

  it("null for a session that never submitted", () => {
    expect(getTerminalTurnRunning("never")).toBeNull();
  });

  it("Stop clears running (turn ended)", () => {
    publishHook("UserPromptSubmit", env("sid-B"));
    expect(getTerminalTurnRunning("sid-B")).not.toBeNull();
    publishHook("Stop", env("sid-B"));
    expect(getTerminalTurnRunning("sid-B")).toBeNull();
  });

  it("SessionEnd clears running (CC gone — defensive)", () => {
    publishHook("UserPromptSubmit", env("sid-C"));
    publishHook("SessionEnd", env("sid-C"));
    expect(getTerminalTurnRunning("sid-C")).toBeNull();
  });

  it("a duplicate UserPromptSubmit for an in-flight turn does NOT reset `since`", async () => {
    publishHook("UserPromptSubmit", env("sid-D"));
    const first = getTerminalTurnRunning("sid-D")!.since;
    await new Promise((r) => setTimeout(r, 5));
    publishHook("UserPromptSubmit", env("sid-D"));
    expect(getTerminalTurnRunning("sid-D")!.since).toBe(first);
  });

  it("is per-session isolated", () => {
    publishHook("UserPromptSubmit", env("sid-E"));
    publishHook("UserPromptSubmit", env("sid-F"));
    publishHook("Stop", env("sid-E"));
    expect(getTerminalTurnRunning("sid-E")).toBeNull();
    expect(getTerminalTurnRunning("sid-F")).not.toBeNull();
    expect(_peekHookLifecycleForTests().map((e) => e.sessionId)).toEqual([
      "sid-F",
    ]);
  });

  it("non-boundary events (PostToolUse / PreToolUse) do NOT define the turn", () => {
    publishHook("PostToolUse", env("sid-G"));
    expect(getTerminalTurnRunning("sid-G")).toBeNull();
    publishHook("UserPromptSubmit", env("sid-G"));
    publishHook("PostToolUse", env("sid-G"));
    // Still running — tool activity is not a turn boundary in 3a.
    expect(getTerminalTurnRunning("sid-G")).not.toBeNull();
  });

  it("init is idempotent (double init doesn't double-count or double-clear)", () => {
    initHookLifecycleReducer(); // already inited in beforeEach
    publishHook("UserPromptSubmit", env("sid-H"));
    // If the listener were registered twice, a single Stop could
    // race or the entry could be written twice — assert single, clean.
    expect(_peekHookLifecycleForTests()).toHaveLength(1);
    publishHook("Stop", env("sid-H"));
    expect(getTerminalTurnRunning("sid-H")).toBeNull();
  });
});
