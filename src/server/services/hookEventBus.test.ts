import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDedupForTests,
  _resetHookBusForTests,
  _suppressedDupCountForTests,
  publishHook,
  subscribeHooks,
  type HookEnvelope,
} from "@/server/services/hookEventBus";

const SID = "11111111-1111-4000-8000-000000000aaa";

function envWith(extras: Record<string, unknown> = {}): HookEnvelope {
  return {
    session_id: SID,
    transcript_path: "/tmp/x.jsonl",
    cwd: "/home/example",
    extras,
  };
}

beforeEach(() => {
  _resetHookBusForTests();
  _resetDedupForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hookEventBus — dedup", () => {
  it("first arrival wins; second within TTL with same tool_use_id is suppressed", () => {
    const seen: Array<{ event: string; tuid: unknown }> = [];
    subscribeHooks((event, payload) => {
      seen.push({ event, tuid: payload.extras.tool_use_id });
    });
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_abc", tool_name: "Bash" }));
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_abc", tool_name: "Bash" }));
    expect(seen).toHaveLength(1);
    expect(seen[0].tuid).toBe("toolu_abc");
    expect(_suppressedDupCountForTests()).toBe(1);
  });

  it("distinct tool_use_ids both deliver (different events, not dups)", () => {
    const seen: string[] = [];
    subscribeHooks((_event, payload) => {
      seen.push(String(payload.extras.tool_use_id ?? ""));
    });
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_a" }));
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_b" }));
    expect(seen).toEqual(["toolu_a", "toolu_b"]);
    expect(_suppressedDupCountForTests()).toBe(0);
  });

  it("different event types with same tool_use_id both deliver (key includes event)", () => {
    const seen: string[] = [];
    subscribeHooks((event) => {
      seen.push(event);
    });
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_x" }));
    publishHook("PostToolUse", envWith({ tool_use_id: "toolu_x" }));
    expect(seen).toEqual(["PreToolUse", "PostToolUse"]);
    expect(_suppressedDupCountForTests()).toBe(0);
  });

  it("different sessions with same tool_use_id both deliver (key includes session_id)", () => {
    const seen: string[] = [];
    subscribeHooks((_event, payload) => {
      seen.push(payload.session_id);
    });
    const SID_OTHER = "22222222-2222-4000-8000-000000000bbb";
    publishHook("PreToolUse", { ...envWith({ tool_use_id: "toolu_x" }), session_id: SID });
    publishHook("PreToolUse", { ...envWith({ tool_use_id: "toolu_x" }), session_id: SID_OTHER });
    expect(seen).toEqual([SID, SID_OTHER]);
  });

  it("events without tool_use_id dedup by 1s timestamp bucket", () => {
    // UserPromptSubmit / Stop / SessionStart have no per-fire id; the
    // bus falls back to coarse bucket. Lock the clock to a single
    // bucket so the test is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000); // some round second
    const seen: number[] = [];
    subscribeHooks((_event) => {
      seen.push(Date.now());
    });
    publishHook("UserPromptSubmit", envWith({ prompt: "first" }));
    // SDK programmatic + HTTP path arrive ~100ms apart; both within
    // the same second.
    vi.setSystemTime(1_700_000_000_100);
    publishHook("UserPromptSubmit", envWith({ prompt: "second-but-actually-dup" }));
    expect(seen).toHaveLength(1); // dup suppressed
    expect(_suppressedDupCountForTests()).toBe(1);
  });

  it("after TTL elapses, same key is allowed again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const seen: number[] = [];
    subscribeHooks(() => seen.push(Date.now()));
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_x" }));
    // Advance past TTL (2s) — same key allowed.
    vi.setSystemTime(1_700_000_002_500);
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_x" }));
    expect(seen).toHaveLength(2);
  });

  it("multiple listeners each receive the event exactly once per dedup window", () => {
    const a: string[] = [];
    const b: string[] = [];
    subscribeHooks((event) => a.push(event));
    subscribeHooks((event) => b.push(event));
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_x" }));
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_x" })); // suppressed
    expect(a).toEqual(["PreToolUse"]);
    expect(b).toEqual(["PreToolUse"]);
  });

  it("a listener throwing doesn't break sibling listeners or dedup", () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok: string[] = [];
    subscribeHooks(() => {
      throw new Error("boom");
    });
    subscribeHooks((event) => ok.push(event));
    publishHook("PreToolUse", envWith({ tool_use_id: "toolu_x" }));
    expect(ok).toEqual(["PreToolUse"]);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
