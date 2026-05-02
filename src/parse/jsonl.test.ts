import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSyntheticRecords,
  fixtureUuids,
  recordsToJsonl,
  SESSION_ID,
} from "./__fixtures__/synthetic/build-fixture";
import {
  buildChatFlow,
  chatFlowStats,
  parseJsonlText,
} from "./jsonl";
import {
  blocksOf,
  extractToolResultBlock,
  isToolResultRecord,
  parseLine,
  type RawRecord,
} from "./raw-record";
import {
  backgroundTaskOutputPath,
  parseAgentId,
  SidecarLoader,
} from "./sidecar";
import { buildWorkflow, DELEGATE_TOOL_NAMES } from "./workflow-builder";

const FIXTURE_PATH = "/synthetic/main.jsonl";
const FIXTURE_DIR = path.resolve(
  __dirname,
  "__fixtures__/synthetic/synthetic-session",
);

function fixtureChatFlow() {
  const records = buildSyntheticRecords();
  return buildChatFlow(records, FIXTURE_PATH);
}

describe("raw-record", () => {
  it("parses well-formed JSON lines", () => {
    const r = parseLine('{"type":"user","uuid":"u","parentUuid":null}');
    expect(r?.type).toBe("user");
    expect(r?.uuid).toBe("u");
  });

  it("returns null on malformed JSON", () => {
    expect(parseLine("not json")).toBeNull();
    expect(parseLine("")).toBeNull();
    expect(parseLine("{")).toBeNull();
  });

  it("rejects records lacking a string `type`", () => {
    expect(parseLine('{"uuid":"x"}')).toBeNull();
  });

  it("isToolResultRecord identifies user records with toolUseResult", () => {
    const r: RawRecord = {
      type: "user",
      toolUseResult: { type: "text" },
    } as RawRecord;
    expect(isToolResultRecord(r)).toBe(true);
    expect(isToolResultRecord({ type: "user" } as RawRecord)).toBe(false);
    expect(
      isToolResultRecord({ type: "assistant", toolUseResult: {} } as RawRecord),
    ).toBe(false);
  });

  it("extractToolResultBlock pulls inner block by tool_use_id", () => {
    const r: RawRecord = {
      type: "user",
      toolUseResult: {},
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_x", content: "ok" },
        ],
      },
    } as RawRecord;
    const blk = extractToolResultBlock(r);
    expect(blk?.tool_use_id).toBe("toolu_x");
  });

  it("blocksOf returns [] when content is a plain string", () => {
    const r: RawRecord = {
      type: "user",
      message: { role: "user", content: "plain text" },
    } as RawRecord;
    expect(blocksOf(r)).toEqual([]);
  });
});

describe("workflow-builder", () => {
  it("knows the v0 delegate tool names", () => {
    expect(DELEGATE_TOOL_NAMES.has("Agent")).toBe(true);
    expect(DELEGATE_TOOL_NAMES.has("Task")).toBe(true);
    expect(DELEGATE_TOOL_NAMES.has("Glob")).toBe(false);
  });

  it("produces an llm_call for an isolated assistant record", () => {
    const recs: RawRecord[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        promptId: "p",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "hi" },
          ],
        },
      } as RawRecord,
    ];
    const wf = buildWorkflow(recs);
    expect(wf.nodes).toHaveLength(1);
    expect(wf.nodes[0].kind).toBe("llm_call");
    if (wf.nodes[0].kind === "llm_call") {
      expect(wf.nodes[0].text).toBe("hi");
      expect(wf.nodes[0].thinking).toEqual([{ text: "hmm", signature: undefined }]);
    }
  });

  it("classifies Agent tool_use as delegate, others as tool_call", () => {
    const recs: RawRecord[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        promptId: "p",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_g", name: "Glob", input: {} },
            {
              type: "tool_use",
              id: "toolu_a",
              name: "Agent",
              input: { description: "spelunk" },
            },
          ],
        },
      } as RawRecord,
    ];
    const wf = buildWorkflow(recs);
    const kinds = wf.nodes.map((n) => n.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("delegate");
  });

  it("emits spawn edges from llm_call to tool_call/delegate children", () => {
    const recs: RawRecord[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        promptId: "p",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_g", name: "Glob", input: {} }],
        },
      } as RawRecord,
    ];
    const wf = buildWorkflow(recs);
    const spawn = wf.edges.find((e) => e.kind === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn?.from).toBe("a");
    expect(spawn?.to).toBe("toolu_g");
  });
});

describe("buildChatFlow / parseJsonlText (synthetic fixture)", () => {
  it("buckets each promptId into exactly one ChatNode", () => {
    const cf = fixtureChatFlow();
    const ids = cf.chatNodes.map((c) => c.id).sort();
    expect(ids).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  it("survives a JSONL round-trip (text → ChatFlow same as records → ChatFlow)", () => {
    const records = buildSyntheticRecords();
    const direct = buildChatFlow(records, FIXTURE_PATH);
    const parsed = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    expect(parsed.chatNodes.length).toBe(direct.chatNodes.length);
    expect(parsed.id).toBe(direct.id);
    expect(parsed.id).toBe(SESSION_ID);
  });

  it("sets sidecarDir to the jsonl path stripped of `.jsonl`", () => {
    const cf = fixtureChatFlow();
    expect(cf.sidecarDir).toBe("/synthetic/main");
  });

  it("captures sessionId / cwd / gitBranch from the records", () => {
    const cf = fixtureChatFlow();
    expect(cf.id).toBe(SESSION_ID);
    expect(cf.cwd).toBe("/home/dev/example");
    expect(cf.gitBranch).toBe("main");
  });

  it("produces ChatNode parent links via parentUuid backwalk", () => {
    const cf = fixtureChatFlow();
    const byId = new Map(cf.chatNodes.map((c) => [c.id, c]));
    expect(byId.get("p1")?.parentChatNodeId).toBeNull();
    expect(byId.get("p2")?.parentChatNodeId).toBe("p1");
    expect(byId.get("p3")?.parentChatNodeId).toBe("p2"); // through compact_boundary
    expect(byId.get("p4")?.parentChatNodeId).toBe("p2"); // through scheduled_task_fire
    expect(byId.get("p5")?.parentChatNodeId).toBe("p4"); // through away_summary
    expect(byId.get("p6")?.parentChatNodeId).toBeNull(); // multi-root
  });

  it("matches tool_result back to tool_use via inner block tool_use_id", () => {
    const cf = fixtureChatFlow();
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    const tc = cn1?.workflow.nodes.find((n) => n.kind === "tool_call");
    expect(tc).toBeDefined();
    if (tc?.kind === "tool_call") {
      expect(tc.toolName).toBe("Glob");
      expect(tc.resultUserUuid).toBe(fixtureUuids.u2);
    }
  });

  it("turns Agent tool_use into a delegate WorkNode with agentId/agentType", () => {
    const cf = fixtureChatFlow();
    const cn2 = cf.chatNodes.find((c) => c.id === "p2");
    const dl = cn2?.workflow.nodes.find((n) => n.kind === "delegate");
    expect(dl).toBeDefined();
    if (dl?.kind === "delegate") {
      expect(dl.toolName).toBe("Agent");
      expect(dl.agentId).toBe("aaa1bbb2");
      expect(dl.agentType).toBe("Explore"); // from toolUseResult
      expect(dl.description).toBe("Find perf hot spots");
      expect(dl.totalDurationMs).toBe(1234); // numeric coercion
      expect(dl.totalTokens).toBe(5678);
      expect(dl.totalToolUseCount).toBe(9);
      expect(dl.status).toBe("completed");
    }
  });

  it("agentType passes through unchanged (no whitelist hardcode)", () => {
    // Mutate fixture to invent an unknown agentType and confirm it survives.
    const records = buildSyntheticRecords();
    for (const r of records) {
      const tur = r.toolUseResult as Record<string, unknown> | undefined;
      if (tur?.["agentId"] === "aaa1bbb2") tur["agentType"] = "future-mode";
    }
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn2 = cf.chatNodes.find((c) => c.id === "p2");
    const dl = cn2?.workflow.nodes.find((n) => n.kind === "delegate");
    if (dl?.kind === "delegate") {
      expect(dl.agentType).toBe("future-mode");
    } else {
      throw new Error("expected delegate node");
    }
  });

  it("emits both tool_call (Glob) and delegate (Agent) within ChatNode #2", () => {
    const cf = fixtureChatFlow();
    const cn2 = cf.chatNodes.find((c) => c.id === "p2");
    const kinds = cn2?.workflow.nodes.map((n) => n.kind) ?? [];
    expect(kinds).toContain("delegate");
    expect(kinds).toContain("tool_call"); // ScheduleWakeup is a non-delegate tool
  });

  it("identifies a compact ChatNode and synthesizes a compact WorkNode", () => {
    const cf = fixtureChatFlow();
    const cn3 = cf.chatNodes.find((c) => c.id === "p3");
    expect(cn3?.isCompactSummary).toBe(true);
    const compactNode = cn3?.workflow.nodes.find((n) => n.kind === "compact");
    expect(compactNode).toBeDefined();
    if (compactNode?.kind === "compact") {
      expect(compactNode.boundaryUuid).toBe(fixtureUuids.bdry1);
      expect(compactNode.logicalParentUuid).toBe(fixtureUuids.a3);
      expect(compactNode.trigger).toBe("manual");
      expect(compactNode.preTokens).toBe(50000);
      expect(compactNode.summaryText).toContain("[Compact summary]");
    }
  });

  it("flags a ChatNode as scheduled when its user record traces back through a fire", () => {
    const cf = fixtureChatFlow();
    const cn4 = cf.chatNodes.find((c) => c.id === "p4");
    expect(cn4?.trigger).toBe("scheduled");
    expect(cn4?.meta.scheduledFireUuid).toBe(fixtureUuids.fire1);
    expect(cn4?.triggerSource?.workNodeId).toBe(fixtureUuids.tu_sw);
  });

  it("attaches away_summary as the next ChatNode's brief", () => {
    const cf = fixtureChatFlow();
    const cn5 = cf.chatNodes.find((c) => c.id === "p5");
    expect(cn5?.meta.awaySummary?.uuid).toBe(fixtureUuids.aw1);
    expect(cn5?.meta.awaySummary?.content).toContain("Heads up");
  });

  it("treats parentUuid=null mid-session users as multi-root ChatNodes", () => {
    const cf = fixtureChatFlow();
    const cn6 = cf.chatNodes.find((c) => c.id === "p6");
    expect(cn6).toBeDefined();
    expect(cn6?.parentChatNodeId).toBeNull();
  });

  it("collects scheduled_task_fire as a flow-level event", () => {
    const cf = fixtureChatFlow();
    const fire = cf.flowEvents.find((e) => e.type === "scheduled_task_fire");
    expect(fire?.uuid).toBe(fixtureUuids.fire1);
  });

  it("retains unknown future record types as orphans without crashing", () => {
    const cf = fixtureChatFlow();
    const orphanTypes = cf.orphans.map((o) => o.type);
    expect(orphanTypes).toContain("marble-origami-snapshot");
  });

  it("skips skip-types (last-prompt / queue-operation)", () => {
    const cf = fixtureChatFlow();
    const orphanTypes = cf.orphans.map((o) => o.type);
    expect(orphanTypes).not.toContain("last-prompt");
    expect(orphanTypes).not.toContain("queue-operation");
  });

  it("preserves the scheduled-fire ChatNode's user message as the literal sentinel", () => {
    const cf = fixtureChatFlow();
    const cn4 = cf.chatNodes.find((c) => c.id === "p4");
    expect(cn4?.userMessage.content).toBe("<<autonomous-loop-dynamic>>");
  });

  it("orders ChatNodes by their root user record timestamp", () => {
    const cf = fixtureChatFlow();
    const ts = cf.chatNodes.map((c) => c.userMessage.timestamp ?? "");
    const sorted = [...ts].sort();
    expect(ts).toEqual(sorted);
  });

  it("chatFlowStats counts kinds across all ChatNodes", () => {
    const stats = chatFlowStats(fixtureChatFlow());
    expect(stats.chatNodeCount).toBe(6);
    expect(stats.delegateCount).toBe(1);
    expect(stats.compactCount).toBe(1);
    expect(stats.toolCallCount).toBeGreaterThanOrEqual(2); // Glob + ScheduleWakeup
    expect(stats.llmCallCount).toBeGreaterThanOrEqual(3);
  });
});

describe("multi-promptId / multi-requestId invariant", () => {
  it("groups records sharing one promptId across multiple requestIds into one ChatNode", () => {
    // Two assistant records under the same promptId but different requestId
    // — must end up in the same ChatNode's workflow.
    const recs: RawRecord[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        promptId: "px",
        timestamp: "2026-01-01T00:00:00Z",
        sessionId: "s",
        message: { role: "user", content: "go" },
      } as RawRecord,
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        promptId: "px",
        requestId: "req-A",
        timestamp: "2026-01-01T00:00:01Z",
        sessionId: "s",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first call" }],
        },
      } as RawRecord,
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        promptId: "px",
        requestId: "req-B",
        timestamp: "2026-01-01T00:00:02Z",
        sessionId: "s",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second call" }],
        },
      } as RawRecord,
    ];
    const cf = buildChatFlow(recs, "/tmp/x.jsonl");
    expect(cf.chatNodes).toHaveLength(1);
    const cn = cf.chatNodes[0];
    const llms = cn.workflow.nodes.filter((n) => n.kind === "llm_call");
    expect(llms).toHaveLength(2);
  });
});

describe("isMeta / isVisibleInTranscriptOnly handling", () => {
  it("filters non-user isMeta records but keeps isMeta user records (sentinel ChatNodes)", () => {
    const cf = fixtureChatFlow();
    expect(cf.chatNodes.find((c) => c.id === "p4")).toBeDefined();
  });
});

describe("sidecar loader", () => {
  it("parses agent ids out of filenames (jsonl + meta.json)", () => {
    expect(parseAgentId("agent-aabb1122.jsonl")).toBe("aabb1122");
    expect(parseAgentId("agent-aabb1122.meta.json")).toBe("aabb1122");
    expect(parseAgentId("/abs/path/agent-acompact-foo.jsonl")).toBe("acompact-foo");
  });

  it("computes sub-agent + meta paths under <sidecarDir>/subagents/", () => {
    const loader = new SidecarLoader("/tmp/session-dir");
    expect(loader.subAgentJsonlPath("aaa")).toBe(
      "/tmp/session-dir/subagents/agent-aaa.jsonl",
    );
    expect(loader.subAgentMetaPath("aaa")).toBe(
      "/tmp/session-dir/subagents/agent-aaa.meta.json",
    );
    expect(loader.subAgentJsonlPath("aaa", "subdir")).toBe(
      "/tmp/session-dir/subagents/subdir/agent-aaa.jsonl",
    );
  });

  it("loads sub-agent meta + jsonl from on-disk fixtures", async () => {
    const loader = new SidecarLoader(FIXTURE_DIR);
    const meta = await loader.loadAgentMetadata("aaa1bbb2");
    expect(meta?.agentType).toBe("Explore");
    expect(meta?.description).toBe("Find perf hot spots");
    const sub = await loader.loadSubAgent("aaa1bbb2");
    expect(sub?.chatFlow.id).toBe("synthetic-session");
    expect(sub?.chatFlow.chatNodes).toHaveLength(1);
  });

  it("returns null for missing sub-agent + tool-result overflow", async () => {
    const loader = new SidecarLoader(FIXTURE_DIR);
    expect(await loader.loadSubAgent("does-not-exist")).toBeNull();
    expect(await loader.loadAgentMetadata("does-not-exist")).toBeNull();
    expect(await loader.loadToolResultOverflow("does-not-exist")).toBeNull();
  });

  it("reads tool-result overflow from disk", async () => {
    const loader = new SidecarLoader(FIXTURE_DIR);
    const text = await loader.loadToolResultOverflow("refid-001");
    expect(text).toContain("overflowed-tool-result-content");
  });

  it("lists sub-agents present on disk", async () => {
    const loader = new SidecarLoader(FIXTURE_DIR);
    const list = await loader.listSubAgents();
    expect(list.map((e) => e.agentId)).toContain("aaa1bbb2");
  });

  it("computes the /tmp background-bash output path from project slug + sessionId", () => {
    const p = backgroundTaskOutputPath("task-XYZ", "-home-foo", "sess-1", 1000);
    expect(p).toMatch(/[\\/]claude-1000[\\/]-home-foo[\\/]sess-1[\\/]tasks[\\/]task-XYZ\.output$/);
  });
});
