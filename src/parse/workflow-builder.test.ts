// Unit tests for the WorkFlow builder primitives (previously only
// covered indirectly through jsonl.test.ts end-to-end fixtures).
import { describe, expect, it } from "vitest";

import type { RawRecord } from "@/parse/raw-record";
import {
  buildMergedLlmCall,
  buildWorkflow,
  groupAssistantsByMessageId,
} from "@/parse/workflow-builder";

function asst(uuid: string, messageId: string | null, text: string): RawRecord {
  return {
    type: "assistant",
    uuid,
    message: {
      role: "assistant",
      ...(messageId ? { id: messageId } : {}),
      content: [{ type: "text", text }],
    } as RawRecord["message"],
  };
}

describe("groupAssistantsByMessageId", () => {
  it("coalesces consecutive assistant records sharing a message.id", () => {
    const groups = groupAssistantsByMessageId([
      asst("a1", "m1", "part 1"),
      asst("a2", "m1", "part 2"),
      asst("a3", "m2", "other"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].group.map((r) => r.uuid)).toEqual(["a1", "a2"]);
    expect(groups[1].group.map((r) => r.uuid)).toEqual(["a3"]);
  });

  it("treats records without a message.id as singleton groups", () => {
    const groups = groupAssistantsByMessageId([
      asst("a1", null, "x"),
      asst("a2", null, "y"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.messageId === null)).toBe(true);
  });

  it("skips non-assistant records", () => {
    const groups = groupAssistantsByMessageId([
      { type: "user", uuid: "u1" },
      asst("a1", "m1", "hi"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].group[0].uuid).toBe("a1");
  });
});

describe("buildMergedLlmCall", () => {
  it("throws on empty input", () => {
    expect(() => buildMergedLlmCall([])).toThrow();
  });

  it("merges text from every record in the group into one llm_call", () => {
    const node = buildMergedLlmCall([
      asst("a1", "m1", "hello "),
      asst("a2", "m1", "world"),
    ]);
    expect(node.kind).toBe("llm_call");
    expect(node.text).toBe("hello world");
  });
});

describe("buildWorkflow", () => {
  it("returns an empty workflow for no records", () => {
    const wf = buildWorkflow([]);
    expect(wf.nodes).toEqual([]);
    expect(wf.edges).toEqual([]);
  });

  it("emits a single llm_call node for one assistant turn", () => {
    const wf = buildWorkflow([asst("a1", "m1", "answer")]);
    const llms = wf.nodes.filter((n) => n.kind === "llm_call");
    expect(llms).toHaveLength(1);
  });
});
