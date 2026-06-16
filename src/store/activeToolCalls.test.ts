// Plan B regression: PreToolUse / PostToolUse maintain the
// `activeToolCalls` placeholder map on the running ChatNode card; Stop /
// UserPromptSubmit clear it as a structural fallback.
import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store/index";
import { makeSessionState } from "@/test/factories";

const SID = "tc-active-0001";

function seed(): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, { ...makeSessionState() });
    return { sessions, activeSessionId: SID };
  });
}

function envelope(extras: Record<string, unknown> = {}) {
  return {
    session_id: SID,
    transcript_path: undefined,
    cwd: undefined,
    permission_mode: "default",
    agent_id: undefined,
    agent_type: undefined,
    extras,
  };
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("activeToolCalls (Plan B)", () => {
  it("PreToolUse adds a placeholder keyed on tool_use_id", () => {
    seed();
    useStore.getState().applyCcHookEvent(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    );
    const m = useStore.getState().sessions.get(SID)!.activeToolCalls;
    expect(m.size).toBe(1);
    const e = m.get("t1")!;
    expect(e.toolName).toBe("Bash");
    expect((e.toolInput as { command: string }).command).toBe("ls -la");
    expect(e.since).toBeGreaterThan(0);
  });

  it("PostToolUse removes the matching placeholder", () => {
    seed();
    const apply = useStore.getState().applyCcHookEvent;
    apply(
      SID,
      "PreToolUse",
      envelope({ tool_use_id: "t1", tool_name: "Bash", tool_input: {} }),
    );
    apply(
      SID,
      "PreToolUse",
      envelope({ tool_use_id: "t2", tool_name: "Read", tool_input: {} }),
    );
    apply(SID, "PostToolUse", envelope({ tool_use_id: "t1" }));
    const m = useStore.getState().sessions.get(SID)!.activeToolCalls;
    expect(m.has("t1")).toBe(false);
    expect(m.has("t2")).toBe(true); // unrelated entry preserved
  });

  it("Stop clears every placeholder (missed-PostToolUse fallback)", () => {
    seed();
    const apply = useStore.getState().applyCcHookEvent;
    apply(
      SID,
      "PreToolUse",
      envelope({ tool_use_id: "t1", tool_name: "Bash", tool_input: {} }),
    );
    apply(
      SID,
      "PreToolUse",
      envelope({ tool_use_id: "t2", tool_name: "Read", tool_input: {} }),
    );
    apply(SID, "Stop", envelope({}));
    expect(useStore.getState().sessions.get(SID)!.activeToolCalls.size).toBe(0);
  });

  it("UserPromptSubmit also clears (new turn drops stale carryover)", () => {
    seed();
    const apply = useStore.getState().applyCcHookEvent;
    apply(
      SID,
      "PreToolUse",
      envelope({ tool_use_id: "t1", tool_name: "Bash", tool_input: {} }),
    );
    apply(SID, "UserPromptSubmit", envelope({}));
    expect(useStore.getState().sessions.get(SID)!.activeToolCalls.size).toBe(0);
  });

  it("PreToolUse with missing tool_use_id is a no-op (defensive)", () => {
    seed();
    useStore
      .getState()
      .applyCcHookEvent(SID, "PreToolUse", envelope({ tool_name: "Bash" }));
    expect(useStore.getState().sessions.get(SID)!.activeToolCalls.size).toBe(0);
  });

  it("identity preserved when nothing changed (no spurious re-renders)", () => {
    seed();
    const before = useStore.getState().sessions.get(SID)!.activeToolCalls;
    // PostToolUse for an id we never added → no change to the map.
    useStore
      .getState()
      .applyCcHookEvent(SID, "PostToolUse", envelope({ tool_use_id: "ghost" }));
    const after = useStore.getState().sessions.get(SID)!.activeToolCalls;
    expect(after).toBe(before);
  });
});
