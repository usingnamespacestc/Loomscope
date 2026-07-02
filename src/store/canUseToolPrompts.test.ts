// v2.7: dedup of pending canUseTool/AskUserQuestion prompts.
//
// Bug: CC re-fires the PreToolUse hook for the SAME AskUserQuestion
// (5s hook-client timeout retry / duplicate fanout delivery). The gate
// mints a fresh promptId each time, so the old promptId-only dedup let
// one question render as TWO forms; answering one left the other
// dangling. Dedup now keys on the STABLE tool_use_id.
// 中: 同一 AUQ 的 PreToolUse 重发会生成新 promptId,原来只按 promptId
// 去重导致一个问题两个表单。改用稳定 tool_use_id 去重。
import { beforeEach, describe, expect, it } from "vitest";

import { makeSessionState } from "@/test/factories";
import { useStore } from "@/store/index";

const SID = "11111111-1111-4000-8000-00000000dedup";

function seed() {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, { ...makeSessionState(), pendingCanUseToolPrompts: [] });
    return { sessions, activeSessionId: SID };
  });
}

function pendings() {
  return useStore.getState().sessions.get(SID)?.pendingCanUseToolPrompts ?? [];
}

const base = {
  toolName: "AskUserQuestion",
  toolInput: { questions: [] },
  receivedAt: 1,
  source: "http" as const,
};

describe("addCanUseToolPrompt — tool_use_id dedup", () => {
  beforeEach(() => {
    useStore.setState({ sessions: new Map(), activeSessionId: null });
    seed();
  });

  it("collapses a re-fired PreToolUse (same tool_use_id, new promptId) into ONE entry", () => {
    const add = useStore.getState().addCanUseToolPrompt;
    add(SID, { ...base, promptId: "httpperm-AAA", toolUseId: "toolu_1" });
    add(SID, { ...base, promptId: "httpperm-BBB", toolUseId: "toolu_1" });
    const list = pendings();
    expect(list).toHaveLength(1);
    // promptId updated to the latest (older gate may be stale).
    expect(list[0].promptId).toBe("httpperm-BBB");
    expect(list[0].toolUseId).toBe("toolu_1");
  });

  it("keeps DISTINCT tool_use_ids as separate forms", () => {
    const add = useStore.getState().addCanUseToolPrompt;
    add(SID, { ...base, promptId: "httpperm-AAA", toolUseId: "toolu_1" });
    add(SID, { ...base, promptId: "httpperm-BBB", toolUseId: "toolu_2" });
    expect(pendings()).toHaveLength(2);
  });

  it("falls back to promptId dedup when tool_use_id is absent (SDK path)", () => {
    const add = useStore.getState().addCanUseToolPrompt;
    add(SID, { ...base, promptId: "pp-AAA" });
    add(SID, { ...base, promptId: "pp-AAA" }); // late-join replay
    expect(pendings()).toHaveLength(1);
    add(SID, { ...base, promptId: "pp-BBB" });
    expect(pendings()).toHaveLength(2);
  });

  it("updating the promptId preserves the entry's position (form doesn't jump)", () => {
    const add = useStore.getState().addCanUseToolPrompt;
    add(SID, { ...base, promptId: "pp-first", toolUseId: "toolu_A" });
    add(SID, { ...base, promptId: "httpperm-X", toolUseId: "toolu_B" });
    // toolu_A re-fires — should stay at index 0, not move to the end.
    add(SID, { ...base, promptId: "httpperm-Y", toolUseId: "toolu_A" });
    const list = pendings();
    expect(list).toHaveLength(2);
    expect(list[0].toolUseId).toBe("toolu_A");
    expect(list[0].promptId).toBe("httpperm-Y");
    expect(list[1].toolUseId).toBe("toolu_B");
  });

  it("removeCanUseToolPrompt clears the entry by its (latest) promptId", () => {
    const store = useStore.getState();
    store.addCanUseToolPrompt(SID, {
      ...base,
      promptId: "httpperm-AAA",
      toolUseId: "toolu_1",
    });
    store.addCanUseToolPrompt(SID, {
      ...base,
      promptId: "httpperm-BBB",
      toolUseId: "toolu_1",
    });
    // Answering targets the latest promptId.
    store.removeCanUseToolPrompt(SID, "httpperm-BBB");
    expect(pendings()).toHaveLength(0);
  });
});
