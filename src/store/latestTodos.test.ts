// PreToolUse with tool_name === "TodoWrite" extracts the todos array
// into SessionState.latestTodos (and does NOT add an activeToolCalls
// entry — TodoWrite is metadata, the UI surface is the status bar text,
// not a ⚙️ chip).
import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store/index";
import { makeSessionState } from "@/test/factories";

const SID = "todo-sid-0001";

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

function seed(): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, { ...makeSessionState() });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("latestTodos (TodoWrite extraction)", () => {
  it("PreToolUse(TodoWrite) parses todos[] into latestTodos and does NOT add a chip", () => {
    seed();
    useStore.getState().applyCcHookEvent(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "tw1",
        tool_name: "TodoWrite",
        tool_input: {
          todos: [
            { content: "分析数据", status: "completed" },
            { content: "锁定瓶颈", status: "in_progress" },
            { content: "出修复建议", status: "pending" },
          ],
        },
      }),
    );
    const cur = useStore.getState().sessions.get(SID)!;
    expect(cur.latestTodos).toEqual([
      { content: "分析数据", status: "completed" },
      { content: "锁定瓶颈", status: "in_progress" },
      { content: "出修复建议", status: "pending" },
    ]);
    expect(cur.activeToolCalls.size).toBe(0); // NO chip
  });

  it("UserPromptSubmit clears latestTodos (new turn, stale todos drop)", () => {
    seed();
    const apply = useStore.getState().applyCcHookEvent;
    apply(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "tw1",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "task", status: "in_progress" }] },
      }),
    );
    expect(useStore.getState().sessions.get(SID)!.latestTodos).not.toBeNull();
    apply(SID, "UserPromptSubmit", envelope({}));
    expect(useStore.getState().sessions.get(SID)!.latestTodos).toBeNull();
  });

  it("Stop does NOT clear latestTodos (CC fires Stop mid-turn; todos persist)", () => {
    seed();
    const apply = useStore.getState().applyCcHookEvent;
    apply(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "tw1",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "task", status: "in_progress" }] },
      }),
    );
    apply(SID, "Stop", envelope({}));
    expect(useStore.getState().sessions.get(SID)!.latestTodos).not.toBeNull();
  });

  it("non-TodoWrite PreToolUse leaves latestTodos alone", () => {
    seed();
    const apply = useStore.getState().applyCcHookEvent;
    apply(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "tw1",
        tool_name: "TodoWrite",
        tool_input: { todos: [{ content: "x", status: "in_progress" }] },
      }),
    );
    apply(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "b1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    );
    const cur = useStore.getState().sessions.get(SID)!;
    expect(cur.latestTodos).not.toBeNull();
    expect(cur.activeToolCalls.size).toBe(1); // Bash adds a chip, TodoWrite didn't
  });

  it("malformed TodoWrite payload is a no-op (defensive)", () => {
    seed();
    useStore.getState().applyCcHookEvent(
      SID,
      "PreToolUse",
      envelope({
        tool_use_id: "tw1",
        tool_name: "TodoWrite",
        tool_input: { todos: "not an array" },
      }),
    );
    expect(useStore.getState().sessions.get(SID)!.latestTodos).toBeNull();
  });
});
