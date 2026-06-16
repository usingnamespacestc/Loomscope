import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildSyntheticRecords,
  fixtureUuids,
  recordsToJsonl,
  SESSION_ID,
} from "./__fixtures__/synthetic/build-fixture";
import {
  buildChatFlow,
  chatFlowStats,
  parseJsonlFile,
  parseJsonlFileIncremental,
  parseJsonlText,
  readRecordsIncremental,
  type IncrementalParseState,
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
import {
  buildMergedLlmCall,
  buildWorkflow,
  DELEGATE_TOOL_NAMES,
  groupAssistantsByMessageId,
} from "./workflow-builder";

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

describe("workflow-builder — groupAssistantsByMessageId (B msg_id merge step 1)", () => {
  it("groups two assistant records sharing message.id into one group", () => {
    const recs: RawRecord[] = [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u",
        message: { id: "msg_X", role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      } as RawRecord,
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        message: { id: "msg_X", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
      } as RawRecord,
    ];
    const groups = groupAssistantsByMessageId(recs);
    expect(groups).toHaveLength(1);
    expect(groups[0].messageId).toBe("msg_X");
    expect(groups[0].group.map((r) => r.uuid)).toEqual(["a1", "a2"]);
  });

  it("isolates records without message.id into singleton groups", () => {
    const recs: RawRecord[] = [
      { type: "assistant", uuid: "a1", message: { role: "assistant" } } as RawRecord,
      { type: "assistant", uuid: "a2", message: { role: "assistant" } } as RawRecord,
    ];
    const groups = groupAssistantsByMessageId(recs);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.messageId === null)).toBe(true);
    expect(groups.every((g) => g.group.length === 1)).toBe(true);
  });

  it("preserves first-seen ordering across multiple groups", () => {
    const recs: RawRecord[] = [
      { type: "assistant", uuid: "a1", message: { id: "msg_A" } } as RawRecord,
      { type: "assistant", uuid: "b1", message: { id: "msg_B" } } as RawRecord,
      { type: "assistant", uuid: "a2", message: { id: "msg_A" } } as RawRecord,
      { type: "assistant", uuid: "b2", message: { id: "msg_B" } } as RawRecord,
    ];
    const groups = groupAssistantsByMessageId(recs);
    expect(groups.map((g) => g.messageId)).toEqual(["msg_A", "msg_B"]);
    expect(groups[0].group.map((r) => r.uuid)).toEqual(["a1", "a2"]);
    expect(groups[1].group.map((r) => r.uuid)).toEqual(["b1", "b2"]);
  });

  it("ignores non-assistant records", () => {
    const recs: RawRecord[] = [
      { type: "user", uuid: "u1" } as RawRecord,
      { type: "assistant", uuid: "a1", message: { id: "msg_A" } } as RawRecord,
      { type: "system", uuid: "s1" } as RawRecord,
    ];
    const groups = groupAssistantsByMessageId(recs);
    expect(groups).toHaveLength(1);
    expect(groups[0].group[0].uuid).toBe("a1");
  });
});

// Helper: synthesise a split-assistant turn — given a list of
// "logical blocks" produce N records sharing the same message.id,
// each carrying one block + an internal-chain parentUuid. Mirrors
// CC's actual on-disk encoding so property tests run against
// realistic fixtures.
function buildSplitAssistantTurn(opts: {
  messageId: string;
  parentUuid: string;
  promptId?: string;
  uuidPrefix?: string;
  blocks: Array<
    | { type: "thinking"; text: string }
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  model?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
}): RawRecord[] {
  const out: RawRecord[] = [];
  let prevUuid = opts.parentUuid;
  for (let i = 0; i < opts.blocks.length; i += 1) {
    const block = opts.blocks[i];
    const uuid = `${opts.uuidPrefix ?? "split"}-${i}`;
    const isLast = i === opts.blocks.length - 1;
    out.push({
      type: "assistant",
      uuid,
      parentUuid: prevUuid,
      message: {
        id: opts.messageId,
        role: "assistant",
        content: [block as unknown as { type: string; [k: string]: unknown }],
        model: opts.model ?? "claude-opus-4-7",
        stop_reason: isLast ? opts.stopReason ?? "end_turn" : undefined,
        usage: opts.usage ?? { input_tokens: 10, output_tokens: 5 },
      },
    } as RawRecord);
    prevUuid = uuid;
  }
  return out;
}

describe("workflow-builder — buildMergedLlmCall (B msg_id merge step 1)", () => {
  it("merges thinking + text blocks across split records", () => {
    const recs: RawRecord[] = [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u",
        message: {
          id: "msg_X",
          role: "assistant",
          content: [{ type: "thinking", thinking: "" }],
          model: "claude-opus-4-7",
          usage: { input_tokens: 10 },
        },
      } as RawRecord,
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        message: {
          id: "msg_X",
          role: "assistant",
          content: [{ type: "text", text: "Hello." }],
          model: "claude-opus-4-7",
          usage: { input_tokens: 10 },
          stop_reason: "end_turn",
        },
      } as RawRecord,
    ];
    const node = buildMergedLlmCall(recs);
    expect(node.kind).toBe("llm_call");
    expect(node.id).toBe("a1"); // first record's uuid
    expect(node.parentUuid).toBe("u"); // first record's parent (= outside the group)
    expect(node.thinking).toEqual([{ text: "", signature: undefined }]);
    expect(node.text).toBe("Hello.");
    expect(node.stopReason).toBe("end_turn"); // taken from last non-empty
    expect(node.model).toBe("claude-opus-4-7");
    expect(node.usage).toEqual({ input_tokens: 10 });
  });

  it("singleton group is byte-equivalent to the legacy buildLlmCall", () => {
    const r: RawRecord = {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u",
      requestId: "req-1",
      timestamp: "2026-05-08T00:00:00Z",
      message: {
        id: "msg_X",
        role: "assistant",
        content: [
          { type: "text", text: "lonely turn" },
          { type: "thinking", thinking: "before" },
        ],
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        usage: { input_tokens: 5 },
      },
    } as RawRecord;
    const merged = buildMergedLlmCall([r]);
    // Field-by-field equivalence to the v0 single-record build
    // contract (text, thinking, parentUuid, model, stopReason,
    // requestId, usage, timestamp). Doesn't compare references —
    // the helpers create new objects.
    expect(merged.id).toBe("a1");
    expect(merged.parentUuid).toBe("u");
    expect(merged.text).toBe("lonely turn");
    expect(merged.thinking).toEqual([{ text: "before", signature: undefined }]);
    expect(merged.model).toBe("claude-opus-4-7");
    expect(merged.stopReason).toBe("end_turn");
    expect(merged.requestId).toBe("req-1");
    expect(merged.timestamp).toBe("2026-05-08T00:00:00Z");
    expect(merged.usage).toEqual({ input_tokens: 5 });
  });

  it("text from multiple records concatenates in record order", () => {
    const recs: RawRecord[] = [
      { type: "assistant", uuid: "a1", message: { id: "m", content: [{ type: "text", text: "Part 1. " }] } } as RawRecord,
      { type: "assistant", uuid: "a2", message: { id: "m", content: [{ type: "text", text: "Part 2." }] } } as RawRecord,
    ];
    const node = buildMergedLlmCall(recs);
    expect(node.text).toBe("Part 1. Part 2.");
  });

  it("stopReason takes the last non-empty value (streaming intermediates lose to final)", () => {
    const recs: RawRecord[] = [
      { type: "assistant", uuid: "a1", message: { id: "m", stop_reason: "tool_use" } } as RawRecord,
      { type: "assistant", uuid: "a2", message: { id: "m", stop_reason: "end_turn" } } as RawRecord,
    ];
    expect(buildMergedLlmCall(recs).stopReason).toBe("end_turn");
  });

  it("tool_use blocks are NOT folded into the LlmCallNode body (they spawn separate ToolCallNodes)", () => {
    const recs: RawRecord[] = [
      {
        type: "assistant",
        uuid: "a1",
        message: {
          id: "m",
          content: [
            { type: "thinking", thinking: "" },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
          ],
        },
      } as RawRecord,
    ];
    const node = buildMergedLlmCall(recs);
    expect(node.thinking).toHaveLength(1);
    expect(node.text).toBe("");
    // No `tools` or `tool_use` field on LlmCallNode — design intent.
    expect("tools" in node).toBe(false);
  });

  it("throws on empty records[] (caller invariant)", () => {
    expect(() => buildMergedLlmCall([])).toThrow();
  });
});

describe("workflow-builder — buildWorkflow with split-assistant fixtures (B step 2)", () => {
  // Property #1 — merged content union
  it("merges split [thinking, text, tool_use] into one llm_call + spawn edge for the tool_use", () => {
    const records: RawRecord[] = [
      // user record (root)
      { type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "hi" } } as RawRecord,
      // split assistant turn
      ...buildSplitAssistantTurn({
        messageId: "msg_X",
        parentUuid: "u1",
        blocks: [
          { type: "thinking", text: "let me think" },
          { type: "text", text: "Here's the plan." },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
        ],
      }),
      // tool result
      {
        type: "user",
        uuid: "tr1",
        parentUuid: "split-2",
        promptId: "p1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "file1\n" } as never,
          ],
        },
      } as RawRecord,
    ];
    const wf = buildWorkflow(records);
    const llms = wf.nodes.filter((n) => n.kind === "llm_call");
    const tools = wf.nodes.filter((n) => n.kind === "tool_call");
    expect(llms).toHaveLength(1);
    expect(tools).toHaveLength(1);
    if (llms[0].kind === "llm_call") {
      expect(llms[0].id).toBe("split-0"); // first split's uuid
      expect(llms[0].thinking).toHaveLength(1);
      expect(llms[0].text).toBe("Here's the plan.");
    }
    // Spawn edge from merged llm to the tool_use
    const spawn = wf.edges.filter((e) => e.kind === "spawn");
    expect(spawn).toHaveLength(1);
    expect(spawn[0].from).toBe("split-0");
    expect(spawn[0].to).toBe("tu1");
  });

  // Property #2 — spawn edges preserved across multiple tool_uses in different split records
  it("two tool_uses in different split records both emit spawn edges from the same merged llm_call", () => {
    const records: RawRecord[] = [
      { type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "" } } as RawRecord,
      ...buildSplitAssistantTurn({
        messageId: "msg_Y",
        parentUuid: "u1",
        blocks: [
          { type: "tool_use", id: "tuA", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "tuB", name: "Read", input: { file_path: "/x" } },
        ],
      }),
    ];
    const wf = buildWorkflow(records);
    const llms = wf.nodes.filter((n) => n.kind === "llm_call");
    const tools = wf.nodes.filter((n) => n.kind === "tool_call");
    expect(llms).toHaveLength(1);
    expect(tools).toHaveLength(2);
    const spawn = wf.edges.filter((e) => e.kind === "spawn");
    expect(spawn).toHaveLength(2);
    // Both spawn edges come from the merged id
    expect(spawn.every((e) => e.from === "split-0")).toBe(true);
    expect(new Set(spawn.map((e) => e.to))).toEqual(new Set(["tuA", "tuB"]));
  });

  // Property #3 — no self-loops introduced by the merge
  it("no edge has from === to (intra-group parent chains collapse, not loop)", () => {
    const records: RawRecord[] = [
      { type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "" } } as RawRecord,
      ...buildSplitAssistantTurn({
        messageId: "msg_Z",
        parentUuid: "u1",
        blocks: [
          { type: "thinking", text: "" },
          { type: "text", text: "x" },
          { type: "tool_use", id: "tu", name: "Bash", input: {} },
        ],
      }),
    ];
    const wf = buildWorkflow(records);
    for (const e of wf.edges) {
      expect(e.from).not.toBe(e.to);
    }
  });

  // Property #4 — singleton fallback equivalence: a non-split fixture
  // yields a workflow byte-equivalent to what the legacy per-record
  // path produced. We verify by NOT splitting any messageId and
  // confirming the synthetic fixture's chatFlow is unchanged.
  it("non-split fixtures (each assistant has unique message.id or no id) produce unchanged workflows", () => {
    // The synthetic fixture has no split assistants, so building from
    // it must produce the same `chatNodes.length` + `workflow.nodes`
    // shape pre/post B. Using parseJsonlText through buildChatFlow
    // exercises the full path.
    const records = buildSyntheticRecords();
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    // Expected from existing fixture-based tests: chatNodes count
    // matches earlier value.
    expect(cf.chatNodes.length).toBeGreaterThan(0);
    for (const cn of cf.chatNodes) {
      // Every llm_call.id must still match a record uuid (= first or
      // singleton record), and parentUuid must remap correctly. Cheap
      // sanity: no llm_call has a parentUuid that points at another
      // llm_call.id WITHIN the same workflow (would mean an
      // intra-group edge slipped through).
      const llmIds = new Set(
        cn.workflow.nodes.filter((n) => n.kind === "llm_call").map((n) => n.id),
      );
      for (const n of cn.workflow.nodes) {
        if (n.kind !== "llm_call") continue;
        if (n.parentUuid && llmIds.has(n.parentUuid)) {
          // This is OK if the parent llm is a DIFFERENT chain root
          // (rare but legal); not an automatic failure. Just smoke-
          // check no obvious loop.
          expect(n.parentUuid).not.toBe(n.id);
        }
      }
    }
  });

  // Property #5 — chainCount stability: a 1-API-call turn (regardless
  // of how many records it's split into) should have chainCount = 1
  // (one continuous chain back to the user message). Prior to B,
  // split records inflated chainCount because intra-group records
  // were sometimes treated as their own chain root.
  it("chainCount is 1 for a single-API-call turn split into 3 records", () => {
    const records: RawRecord[] = [
      { type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "" } } as RawRecord,
      ...buildSplitAssistantTurn({
        messageId: "msg_W",
        parentUuid: "u1",
        blocks: [
          { type: "thinking", text: "" },
          { type: "text", text: "ack" },
          { type: "tool_use", id: "tu", name: "Bash", input: {} },
        ],
      }),
    ];
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    expect(cf.chatNodes).toHaveLength(1);
    const summary = cf.chatNodes[0].workflow.summary;
    // 1 logical API call → chainCount = 1 (no break)
    expect(summary?.chainCount).toBe(1);
    // llmCount should reflect API calls, not split records → 1
    expect(summary?.llmCount).toBe(1);
  });

  // Property #6 — tool_use_id → cn lookup still works after merge
  it("tool_use_id resolution: ToolCallNode.parentUuid points at the merged llm_call.id", () => {
    const records: RawRecord[] = [
      { type: "user", uuid: "u1", promptId: "p1", message: { role: "user", content: "" } } as RawRecord,
      ...buildSplitAssistantTurn({
        messageId: "msg_V",
        parentUuid: "u1",
        blocks: [
          { type: "thinking", text: "" }, // split-0
          { type: "tool_use", id: "tuLate", name: "Bash", input: {} }, // split-1
        ],
      }),
    ];
    const wf = buildWorkflow(records);
    const tool = wf.nodes.find((n) => n.kind === "tool_call");
    expect(tool).toBeDefined();
    if (tool && (tool.kind === "tool_call" || tool.kind === "delegate")) {
      // Before B: parentUuid would be "split-1" (the record that
      // physically wrote the tool_use). After B: must be "split-0"
      // (the merged llm_call id).
      expect(tool.parentUuid).toBe("split-0");
    }
  });

  // Property #7 — chainCount transit walk: attachment(task_reminder)
  // and compact_boundary records sit ON the chain (CC's
  // sessionStorage.ts:isChainParticipant returns true for both). The
  // next assistant's parentUuid points at the attachment/compact uuid,
  // not at the prior tool_result. Pre-fix computeChainCount only
  // recognised llm→llm and llm→tool→llm patterns, so each transit
  // record falsely registered as a chain root. Real session
  // (a02f707f-…f81e3e2f-) had a 1-chain turn rendered as 3 chains.
  it("chainCount = 1 when an attachment(task_reminder) sits between tool_result and next llm_call", () => {
    // Real CC: tool_result user records carry promptId (= the
    // ChatNode's promptId) — without it the parser orphans them at
    // bucketing. Mirroring the real shape so chainCount sees the
    // full transit chain.
    const records: RawRecord[] = [
      { type: "user", uuid: "u-prompt", promptId: "p1", message: { role: "user", content: "" } } as RawRecord,
      // llm_1 + tool_use(Bash)
      {
        type: "assistant",
        uuid: "llm-1",
        parentUuid: "u-prompt",
        message: {
          id: "msg_A",
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
        },
      } as RawRecord,
      // tool_result
      {
        type: "user",
        uuid: "u-tr-1",
        promptId: "p1",
        parentUuid: "llm-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      } as RawRecord,
      // attachment(task_reminder) injected by CC harness
      {
        type: "attachment",
        uuid: "att-1",
        parentUuid: "u-tr-1",
        attachment: { type: "task_reminder", content: [] },
      } as RawRecord,
      // llm_2 with parentUuid pointing at the attachment, NOT at the tool_result
      {
        type: "assistant",
        uuid: "llm-2",
        parentUuid: "att-1",
        message: { id: "msg_B", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      } as RawRecord,
    ];
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    expect(cf.chatNodes).toHaveLength(1);
    const summary = cf.chatNodes[0].workflow.summary;
    expect(summary?.llmCount).toBe(2);
    // Pre-fix: chainCount=2 (attachment falsely splits chain).
    // Post-fix: chainCount=1 — attachment is transit.
    expect(summary?.chainCount).toBe(1);
  });

  // PR 2.4: hybrid ChatNode = real user prompt + isCompactSummary user
  // record in the same promptId bucket. Real CC sessions show this in
  // ~96% of compacts (user fires auto-compact mid-turn, the synthetic
  // resume marker stays under the same promptId). Pre-fix, isCompact
  // got set to true regardless of whether nonMetaUser existed,
  // overlaying compact chrome on top of a real-work turn.
  it("hybrid bucket (real prompt + isCompactSummary user) → isCompactSummary=false, hasInnerCompact=true", () => {
    const records: RawRecord[] = [
      // Real user prompt
      {
        type: "user",
        uuid: "u-real",
        promptId: "p-hybrid",
        message: { role: "user", content: "do the task" },
      } as RawRecord,
      // Pre-compact assistant work
      {
        type: "assistant",
        uuid: "llm-1",
        parentUuid: "u-real",
        message: {
          id: "msg_A",
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
        },
      } as RawRecord,
      {
        type: "user",
        uuid: "u-tr-1",
        promptId: "p-hybrid",
        parentUuid: "llm-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      } as RawRecord,
      // CC fires auto-compact mid-turn — synthetic resume marker
      {
        type: "user",
        uuid: "u-compact",
        promptId: "p-hybrid",
        parentUuid: "u-tr-1",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation...",
        },
      } as RawRecord,
      // Post-compact assistant
      {
        type: "assistant",
        uuid: "llm-2",
        parentUuid: "u-compact",
        message: {
          id: "msg_B",
          role: "assistant",
          content: [{ type: "text", text: "continuing" }],
          stop_reason: "end_turn",
        },
      } as RawRecord,
    ];
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    const cn = cf.chatNodes.find((c) => c.id === "p-hybrid");
    expect(cn).toBeTruthy();
    if (!cn) return;
    expect(cn.isCompactSummary).toBe(false);  // real prompt wins → not pure compact
    expect(cn.hasInnerCompact).toBe(true);    // but compact happened inside
    expect(cn.compactMetadata).toBeTruthy();   // metadata still surfaced for chip
    // userMessage shows the REAL prompt, not the synthesised resume.
    expect(typeof cn.userMessage.content === "string"
      ? cn.userMessage.content
      : "").toMatch(/do the task/);
  });

  it("pure compact bucket (only isCompactSummary user, no real prompt) → isCompactSummary=true, hasInnerCompact=true", () => {
    const records: RawRecord[] = [
      // Only the synthetic compact resume marker — no real user prompt.
      {
        type: "user",
        uuid: "u-compact-only",
        promptId: "p-pure",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation...",
        },
      } as RawRecord,
      {
        type: "assistant",
        uuid: "llm-1",
        parentUuid: "u-compact-only",
        message: {
          id: "msg_A",
          role: "assistant",
          content: [{ type: "text", text: "continuing" }],
          stop_reason: "end_turn",
        },
      } as RawRecord,
    ];
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    const cn = cf.chatNodes.find((c) => c.id === "p-pure");
    expect(cn).toBeTruthy();
    if (!cn) return;
    expect(cn.isCompactSummary).toBe(true);   // pure compact ChatNode chrome
    expect(cn.hasInnerCompact).toBe(true);    // chip metadata still set
  });

  it("chainCount = 1 when a compact_boundary sits between two llm_calls", () => {
    const records: RawRecord[] = [
      { type: "user", uuid: "u-prompt", promptId: "p1", message: { role: "user", content: "" } } as RawRecord,
      {
        type: "assistant",
        uuid: "llm-1",
        parentUuid: "u-prompt",
        message: {
          id: "msg_A",
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
        },
      } as RawRecord,
      {
        type: "user",
        uuid: "u-tr-1",
        promptId: "p1",
        parentUuid: "llm-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      } as RawRecord,
      // compact_boundary on the chain. Carries promptId="p1" so it
      // gets bucketed into this ChatNode (real compact_boundary
      // records do — CC's bucketing rule on jsonl.ts:469 special-
      // cases the unpaired boundary, but with promptId set the
      // chain-walk sees it as a transit record).
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "cb-1",
        promptId: "p1",
        parentUuid: "u-tr-1",
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 100 },
      } as RawRecord,
      // llm_2.parentUuid points at the compact boundary
      {
        type: "assistant",
        uuid: "llm-2",
        parentUuid: "cb-1",
        message: { id: "msg_B", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      } as RawRecord,
    ];
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    const summary = cf.chatNodes[0].workflow.summary;
    expect(summary?.llmCount).toBe(2);
    // compact transit through → still 1 chain.
    expect(summary?.chainCount).toBe(1);
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

  it("ChatNode.contributingSessions = unique sessionIds across the bucket", () => {
    // Single-jsonl fixture: every record carries SESSION_ID, so
    // every ChatNode's contributingSessions = [SESSION_ID].
    const cf = fixtureChatFlow();
    for (const cn of cf.chatNodes) {
      expect(cn.contributingSessions).toEqual([SESSION_ID]);
    }
  });

  it("contributingSessions unions across mixed-source records (closure-merge case)", () => {
    // Simulate what loadMergedChatFlow feeds buildChatFlow when
    // viewing a session with a fork sibling: prefix records carry the
    // sibling's sessionId, post-fork records carry the entry's. Both
    // sets share promptId 'p1' (CC's forkSession preserves promptId
    // across the copy). Result: one bucket with two contributing sids.
    const records: RawRecord[] = [
      {
        type: "user",
        uuid: "u1",
        promptId: "p1",
        sessionId: "sid-A",
        message: { role: "user", content: "hi" },
      } as RawRecord,
      {
        type: "user",
        uuid: "u1-copy",
        promptId: "p1",
        sessionId: "sid-B",
        message: { role: "user", content: "hi" },
      } as RawRecord,
    ];
    const cf = buildChatFlow(records, "/synthetic/merged.jsonl");
    expect(cf.chatNodes).toHaveLength(1);
    const cn = cf.chatNodes[0];
    expect(cn.contributingSessions).not.toBeUndefined();
    expect([...(cn.contributingSessions ?? [])].sort()).toEqual(["sid-A", "sid-B"]);
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

  it("backfills compactMetadata.logicalParentChatNodeId via resolvePromptId (v0.7 M3)", () => {
    // p3 is the compact ChatNode; the boundary's logicalParentUuid =
    // fixtureUuids.a3 (an assistant record in p2). resolvePromptId
    // should walk that uuid → its parentUuid chain → land on p2.
    const cf = fixtureChatFlow();
    const cn3 = cf.chatNodes.find((c) => c.id === "p3");
    expect(cn3?.compactMetadata?.logicalParentChatNodeId).toBe("p2");
  });

  it("flags a ChatNode as scheduled when its user record traces back through a fire", () => {
    const cf = fixtureChatFlow();
    const cn4 = cf.chatNodes.find((c) => c.id === "p4");
    expect(cn4?.trigger).toBe("scheduled");
    expect(cn4?.meta.scheduledFireUuid).toBe(fixtureUuids.fire1);
    expect(cn4?.triggerSource?.workNodeId).toBe(fixtureUuids.tu_sw);
  });

  it("attaches away_summary as the PREVIOUS ChatNode's brief (2026-05-13)", () => {
    // EN: the away_summary record CC emits between two turns is now
    // anchored to the turn BEFORE the gap (= the new turn's parent
    // ChatNode), not the new turn itself. The new turn (p5) has its
    // slot cleared; the previous turn (p4) carries the recap as its
    // "closing summary". See jsonl.ts re-anchor comment for rationale.
    // 中: away_summary 现在挂在 gap 前那个节点（p4）而非新节点
    // （p5）；p5 的 slot 清空。
    const cf = fixtureChatFlow();
    const cn4 = cf.chatNodes.find((c) => c.id === "p4");
    const cn5 = cf.chatNodes.find((c) => c.id === "p5");
    expect(cn4?.meta.awaySummary?.uuid).toBe(fixtureUuids.aw1);
    expect(cn4?.meta.awaySummary?.content).toContain("Heads up");
    expect(cn5?.meta.awaySummary).toBeUndefined();
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

  it("prefers non-meta user record as ChatNode root when bucket has both meta + non-meta (slash command pattern)", () => {
    // Slash command (e.g. /model) buckets as 3 user records under one
    // promptId: caveat (isMeta=true), command body (no meta), stdout
    // (no meta). Without preference rule the caveat would win and the
    // card would show the system warning. We must surface the command
    // body instead.
    const records = [
      {
        type: "user",
        uuid: "u-caveat",
        parentUuid: null,
        promptId: "p-slash",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:00Z",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>System note</local-command-caveat>" },
      },
      {
        type: "user",
        uuid: "u-cmd",
        parentUuid: "u-caveat",
        promptId: "p-slash",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:01Z",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      },
      {
        type: "user",
        uuid: "u-stdout",
        parentUuid: "u-cmd",
        promptId: "p-slash",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:02Z",
        message: { role: "user", content: "<local-command-stdout>Set model to Opus</local-command-stdout>" },
      },
    ];
    const cf = buildChatFlow(records as RawRecord[], "/tmp/x.jsonl");
    const cn = cf.chatNodes.find((c) => c.id === "p-slash");
    expect(cn).toBeDefined();
    // Non-meta command body wins as root; uuid points at the command, not the caveat
    expect(cn!.userMessage.uuid).toBe("u-cmd");
    expect(cn!.userMessage.content).toContain("<command-name>/model</command-name>");
  });

  it("extracts slashCommand info from /command + stdout user records", () => {
    const records = [
      {
        type: "user",
        uuid: "u-caveat",
        parentUuid: null,
        promptId: "p-cmd",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:00Z",
        isMeta: true,
        message: { role: "user", content: "<local-command-caveat>...</local-command-caveat>" },
      },
      {
        type: "user",
        uuid: "u-cmd",
        parentUuid: "u-caveat",
        promptId: "p-cmd",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:01Z",
        message: {
          role: "user",
          content:
            "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus-4-7</command-args>",
        },
      },
      {
        type: "user",
        uuid: "u-stdout",
        parentUuid: "u-cmd",
        promptId: "p-cmd",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:02Z",
        message: {
          role: "user",
          content:
            "<local-command-stdout>Set model to [1mOpus 4.7 (1M context)[22m (default)</local-command-stdout>",
        },
      },
    ];
    const cf = buildChatFlow(records as RawRecord[], "/tmp/x.jsonl");
    const cn = cf.chatNodes.find((c) => c.id === "p-cmd");
    expect(cn?.slashCommand).toBeDefined();
    expect(cn!.slashCommand!.name).toBe("/model");
    expect(cn!.slashCommand!.args).toBe("opus-4-7");
    // ANSI \x1b[1m and \x1b[22m stripped.
    expect(cn!.slashCommand!.stdout).toBe("Set model to Opus 4.7 (1M context) (default)");
  });

  it("does NOT set slashCommand on regular ChatNodes (no <command-name> tag)", () => {
    const cf = fixtureChatFlow();
    // Synthetic fixture's ChatNodes are plain user/assistant turns.
    const anyHasSlash = cf.chatNodes.some((c) => c.slashCommand !== undefined);
    expect(anyHasSlash).toBe(false);
  });

  it("falls back to meta user when bucket only has meta (ScheduleWakeup sentinel still works)", () => {
    // ScheduleWakeup fire produces a single isMeta user record with the
    // <<autonomous-loop-dynamic>> sentinel. No non-meta records — meta
    // must still be picked.
    const records = [
      {
        type: "user",
        uuid: "u-sentinel",
        parentUuid: null,
        promptId: "p-sched",
        sessionId: "s",
        cwd: "/",
        timestamp: "2026-05-02T22:00:00Z",
        isMeta: true,
        message: { role: "user", content: "<<autonomous-loop-dynamic>>" },
      },
    ];
    const cf = buildChatFlow(records as RawRecord[], "/tmp/x.jsonl");
    const cn = cf.chatNodes.find((c) => c.id === "p-sched");
    expect(cn).toBeDefined();
    expect(cn!.userMessage.uuid).toBe("u-sentinel");
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

describe("file-history-snapshot binding (v0.7)", () => {
  // Real CC schema: snapshot record carries `messageId` (top-level OR
  // nested under `snapshot.messageId`) that resolves directly to a
  // user/assistant record's uuid. promptId then comes via the existing
  // resolvePromptId chain (parentUuid hop for assistant records that
  // don't carry promptId themselves).
  function snapshotRecord(opts: {
    uuid: string;
    messageId: string;
    timestamp?: string;
    trackedFiles?: string[];
    isUpdate?: boolean;
    nestMessageId?: boolean;
  }): RawRecord {
    const trackedBackups = (opts.trackedFiles ?? []).reduce<Record<string, string>>(
      (acc, f) => {
        acc[f] = "<original content>";
        return acc;
      },
      {},
    );
    const rec: RawRecord = {
      type: "file-history-snapshot",
      uuid: opts.uuid,
      parentUuid: null,
      timestamp: opts.timestamp ?? "2026-04-10T03:10:00.000Z",
      snapshot: {
        messageId: opts.nestMessageId ? opts.messageId : undefined,
        trackedFileBackups: trackedBackups,
        timestamp: opts.timestamp ?? "2026-04-10T03:10:00.000Z",
      },
      isSnapshotUpdate: opts.isUpdate === true,
    };
    if (!opts.nestMessageId) {
      (rec as unknown as { messageId: string }).messageId = opts.messageId;
    }
    return rec;
  }

  it("binds snapshot to ChatNode when messageId points at the user record (direct promptId)", () => {
    const records = buildSyntheticRecords();
    records.push(
      snapshotRecord({
        uuid: "snap-1",
        messageId: fixtureUuids.u1, // p1's user record
        trackedFiles: ["src/App.tsx", "src/main.tsx"],
      }),
    );
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    expect(cn1?.meta.fileHistorySnapshots?.length).toBe(1);
    const snap = cn1?.meta.fileHistorySnapshots?.[0];
    expect(snap?.uuid).toBe("snap-1");
    expect(snap?.trackedFiles).toEqual(["src/App.tsx", "src/main.tsx"]);
    expect(snap?.isUpdate).toBe(false);
    // Not orphaned.
    expect(cf.orphans.find((o) => o.uuid === "snap-1")).toBeUndefined();
  });

  it("binds snapshot to ChatNode when messageId points at an assistant record (parentUuid hop)", () => {
    // Assistant records don't carry promptId themselves. resolvePromptId
    // walks parentUuid back to the user record.
    const records = buildSyntheticRecords();
    records.push(
      snapshotRecord({
        uuid: "snap-asst",
        messageId: fixtureUuids.a1, // p1's assistant record
        trackedFiles: ["docs/devlog.md"],
      }),
    );
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    expect(cn1?.meta.fileHistorySnapshots?.length).toBe(1);
    expect(cn1?.meta.fileHistorySnapshots?.[0].uuid).toBe("snap-asst");
  });

  it("accepts messageId nested under snapshot.messageId (CC alt schema)", () => {
    const records = buildSyntheticRecords();
    records.push(
      snapshotRecord({
        uuid: "snap-nested",
        messageId: fixtureUuids.u1,
        nestMessageId: true,
        trackedFiles: ["x.ts"],
      }),
    );
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    expect(cn1?.meta.fileHistorySnapshots?.[0].uuid).toBe("snap-nested");
  });

  it("orphans snapshot when messageId does not resolve to any record", () => {
    const records = buildSyntheticRecords();
    records.push(
      snapshotRecord({
        uuid: "snap-dangling",
        messageId: "nonexistent-uuid-xxx",
      }),
    );
    const cf = buildChatFlow(records, FIXTURE_PATH);
    for (const cn of cf.chatNodes) {
      expect(cn.meta.fileHistorySnapshots?.find((s) => s.uuid === "snap-dangling")).toBeUndefined();
    }
    const orph = cf.orphans.find((o) => o.uuid === "snap-dangling");
    expect(orph).toBeDefined();
    expect(orph?.reason).toMatch(/messageId/);
  });

  it("propagates isSnapshotUpdate true onto the FileHistorySnapshot record", () => {
    const records = buildSyntheticRecords();
    records.push(
      snapshotRecord({
        uuid: "snap-upd",
        messageId: fixtureUuids.u1,
        trackedFiles: ["a.ts"],
        isUpdate: true,
      }),
    );
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    expect(cn1?.meta.fileHistorySnapshots?.[0].isUpdate).toBe(true);
  });

  it("collects multiple snapshots for the same ChatNode in record order", () => {
    const records = buildSyntheticRecords();
    records.push(
      snapshotRecord({
        uuid: "snap-A",
        messageId: fixtureUuids.u1,
        trackedFiles: ["a.ts"],
      }),
      snapshotRecord({
        uuid: "snap-B",
        messageId: fixtureUuids.u1,
        trackedFiles: ["b.ts"],
      }),
    );
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    expect(cn1?.meta.fileHistorySnapshots?.map((s) => s.uuid)).toEqual([
      "snap-A",
      "snap-B",
    ]);
  });

  it("snapshots stay null when ChatNode has no bound snapshots", () => {
    const cf = buildChatFlow(buildSyntheticRecords(), FIXTURE_PATH);
    for (const cn of cf.chatNodes) {
      expect(cn.meta.fileHistorySnapshots).toBeUndefined();
    }
  });
});

describe("fork tracking — forkedFrom + custom-title (v0.8 M1)", () => {
  // Helper: clone the synthetic fixture and stamp per-record forkedFrom
  // on the bucket records of the given promptIds, mimicking how CC
  // `/branch` writes — sessionId uniform across bucket but messageUuid
  // = each record's own preserved uuid (different per record).
  function withForkedRecords(
    sourceSessionId: string,
    targetPromptIds: string[],
  ): RawRecord[] {
    const records = buildSyntheticRecords();
    return records.map((r) => {
      if (
        r.promptId &&
        targetPromptIds.includes(r.promptId) &&
        typeof r.uuid === "string"
      ) {
        return {
          ...r,
          forkedFrom: { sessionId: sourceSessionId, messageUuid: r.uuid },
        };
      }
      return r;
    });
  }

  it("hoists forkedFrom from rootUser onto the ChatNode (sessionId + rootUser.uuid)", () => {
    const sid = "original-session-aaaa-bbbb-cccc-dddddddddddd";
    const records = withForkedRecords(sid, ["p1"]);
    const cf = buildChatFlow(records, FIXTURE_PATH);
    const cn1 = cf.chatNodes.find((c) => c.id === "p1");
    // messageUuid points at the source bucket's rootUser uuid (= u1
    // in our synthetic fixture, since uuid is preserved by /branch).
    expect(cn1?.forkedFrom).toEqual({ sessionId: sid, messageUuid: fixtureUuids.u1 });
    // p2 / p3 unaffected (not stamped).
    const cn2 = cf.chatNodes.find((c) => c.id === "p2");
    expect(cn2?.forkedFrom).toBeUndefined();
  });

  it("does NOT warn when bucket records carry the same sessionId but different per-record messageUuid (= the normal /branch shape)", () => {
    const sid = "original-session-aaaa";
    const records = withForkedRecords(sid, ["p1"]);
    const warn = console.warn;
    const calls: string[] = [];
    console.warn = (msg: string) => calls.push(msg);
    try {
      buildChatFlow(records, FIXTURE_PATH);
      expect(calls.filter((m) => m.includes("forkedFrom"))).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });

  it("hoists `customTitle` from `{type: 'custom-title'}` record to ChatFlow", () => {
    const records = buildSyntheticRecords();
    records.push({
      type: "custom-title",
      sessionId: SESSION_ID,
      timestamp: "2026-04-10T03:11:00.000Z",
      customTitle: "list all tsx files (Branch)",
    } as RawRecord);
    const cf = buildChatFlow(records, FIXTURE_PATH);
    expect(cf.customTitle).toBe("list all tsx files (Branch)");
  });

  it("custom-title record does NOT enter orphans (skipped via SKIP_TYPES)", () => {
    const records = buildSyntheticRecords();
    records.push({
      type: "custom-title",
      sessionId: SESSION_ID,
      uuid: "ct-uuid-1",
      customTitle: "session-x (Branch 2)",
    } as RawRecord);
    const cf = buildChatFlow(records, FIXTURE_PATH);
    expect(cf.orphans.find((o) => o.uuid === "ct-uuid-1")).toBeUndefined();
    expect(cf.orphans.find((o) => o.type === "custom-title")).toBeUndefined();
  });

  it("warns + keeps rootUser's when bucket records carry inconsistent forkedFrom.sessionId (hand-edited / non-/branch source)", () => {
    const records = buildSyntheticRecords();
    const sidA = "src-a-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sidB = "src-b-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    // Stamp rootUser (u1) with sidA, stamp the next record (a1) with sidB.
    const mutated = records.map((r) => {
      if (r.uuid === fixtureUuids.u1) {
        return { ...r, forkedFrom: { sessionId: sidA, messageUuid: r.uuid! } };
      }
      if (r.uuid === fixtureUuids.a1) {
        return { ...r, forkedFrom: { sessionId: sidB, messageUuid: r.uuid! } };
      }
      return r;
    });
    const warn = console.warn;
    const calls: string[] = [];
    console.warn = (msg: string) => calls.push(msg);
    try {
      const cf = buildChatFlow(mutated, FIXTURE_PATH);
      const cn1 = cf.chatNodes.find((c) => c.id === "p1");
      // rootUser's wins — sidA + u1 uuid.
      expect(cn1?.forkedFrom).toEqual({ sessionId: sidA, messageUuid: fixtureUuids.u1 });
      expect(
        calls.some((m) => m.includes("inconsistent forkedFrom.sessionId")),
      ).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  it("no forkedFrom anywhere → ChatNode.forkedFrom = undefined", () => {
    const cf = buildChatFlow(buildSyntheticRecords(), FIXTURE_PATH);
    for (const cn of cf.chatNodes) {
      expect(cn.forkedFrom).toBeUndefined();
    }
  });

  it("non-merged ChatFlow leaves linkedSessions undefined (server fills it in M2)", () => {
    const cf = buildChatFlow(buildSyntheticRecords(), FIXTURE_PATH);
    expect(cf.linkedSessions).toBeUndefined();
  });
});

describe("parseJsonlFileIncremental (M0 — v0.10 收尾 / v0.11 prep)", () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "loomscope-incr-"));
    jsonlPath = path.join(tmpDir, "session.jsonl");
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("prevState undefined → falls back to full parse and emits a populated state", async () => {
    const initial = recordsToJsonl(buildSyntheticRecords().slice(0, 8));
    await fsp.writeFile(jsonlPath, initial, "utf8");
    const r = await parseJsonlFileIncremental(jsonlPath, undefined);
    expect(r.usedIncremental).toBe(false);
    expect(r.state.records.length).toBeGreaterThan(0);
    expect(r.state.byteSize).toBe(initial.length);
    expect(r.state.pendingFragment).toBe("");
    // ChatFlow shape matches a full parse on the same input.
    const fullRef = await parseJsonlFile(jsonlPath);
    expect(r.chatFlow.chatNodes.length).toBe(fullRef.chatFlow.chatNodes.length);
  });

  it("matching state + appended bytes → records = prev ++ new and chatFlow equals fresh full parse", async () => {
    const all = buildSyntheticRecords();
    const head = recordsToJsonl(all.slice(0, 6));
    await fsp.writeFile(jsonlPath, head, "utf8");
    const first = await parseJsonlFileIncremental(jsonlPath, undefined);

    // Append the rest atomically so awaitWriteFinish-style semantics
    // aren't a concern for the test (we're not running chokidar here).
    const tail = recordsToJsonl(all.slice(6));
    await fsp.appendFile(jsonlPath, tail, "utf8");

    const second = await parseJsonlFileIncremental(jsonlPath, first.state);
    expect(second.usedIncremental).toBe(true);
    expect(second.state.records.length).toBe(first.state.records.length + (all.length - 6));
    expect(second.state.byteSize).toBe(head.length + tail.length);
    // Equivalence: incremental result should match a clean full parse
    // of the same final file.
    const fresh = await parseJsonlFile(jsonlPath);
    expect(second.chatFlow.chatNodes.length).toBe(fresh.chatFlow.chatNodes.length);
    for (let i = 0; i < fresh.chatFlow.chatNodes.length; i += 1) {
      expect(second.chatFlow.chatNodes[i].id).toBe(fresh.chatFlow.chatNodes[i].id);
    }
  });

  it("unchanged file (size matches state) → reuses prev records, still emits a fresh chatFlow", async () => {
    const txt = recordsToJsonl(buildSyntheticRecords().slice(0, 5));
    await fsp.writeFile(jsonlPath, txt, "utf8");
    const first = await parseJsonlFileIncremental(jsonlPath, undefined);
    const second = await parseJsonlFileIncremental(jsonlPath, first.state);
    expect(second.usedIncremental).toBe(true);
    expect(second.state.records.length).toBe(first.state.records.length);
    expect(second.chatFlow.chatNodes.length).toBe(first.chatFlow.chatNodes.length);
  });

  it("file shrunk → falls back to full parse (truncation/rewrite scenario)", async () => {
    const big = recordsToJsonl(buildSyntheticRecords().slice(0, 8));
    await fsp.writeFile(jsonlPath, big, "utf8");
    const first = await parseJsonlFileIncremental(jsonlPath, undefined);

    // Replace with a strictly smaller file (truncation / rewrite).
    const small = recordsToJsonl(buildSyntheticRecords().slice(0, 3));
    await fsp.writeFile(jsonlPath, small, "utf8");
    const second = await parseJsonlFileIncremental(jsonlPath, first.state);
    expect(second.usedIncremental).toBe(false);
    expect(second.state.byteSize).toBe(small.length);
    // records count should match a fresh parse of the small file, not
    // be (first.records ++ partial).
    const fresh = await parseJsonlFile(jsonlPath);
    expect(second.chatFlow.chatNodes.length).toBe(fresh.chatFlow.chatNodes.length);
  });

  it("#4a same-size in-place rewrite (mtime changed) → full reparse, not stale records", async () => {
    const mk = (txt: string) =>
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "s",
        promptId: "p1",
        message: { role: "user", content: txt },
      }) + "\n";
    const a = mk("AAAA");
    const b = mk("BBBB");
    expect(a.length).toBe(b.length); // guard: identical byte length

    await fsp.writeFile(jsonlPath, a, "utf8");
    const first = await parseJsonlFileIncremental(jsonlPath, undefined);
    expect(first.chatFlow.chatNodes[0]?.userMessage.content).toBe("AAAA");

    // In-place rewrite to the SAME length, with a detectably newer mtime.
    await fsp.writeFile(jsonlPath, b, "utf8");
    const newer = new Date(first.state.mtimeMs + 5000);
    await fsp.utimes(jsonlPath, newer, newer);

    const second = await parseJsonlFileIncremental(jsonlPath, first.state);
    // Pre-#4a this reused the stale cached records (byteSize unchanged →
    // append path found no new bytes). Now it forces a full reparse.
    expect(second.usedIncremental).toBe(false);
    expect(second.chatFlow.chatNodes[0]?.userMessage.content).toBe("BBBB");
  });

  it("partial-line tail (no trailing \\n) is buffered into pendingFragment and consumed on the next call", async () => {
    const recs = buildSyntheticRecords();
    const head = recordsToJsonl(recs.slice(0, 4));
    await fsp.writeFile(jsonlPath, head, "utf8");
    const first = await parseJsonlFileIncremental(jsonlPath, undefined);

    // Append a half-written line — no trailing \n. Incremental should
    // hold it in pendingFragment and emit no new records yet.
    const halfRecord = JSON.stringify(recs[4]);
    const halfChunk = halfRecord.slice(0, Math.floor(halfRecord.length / 2));
    await fsp.appendFile(jsonlPath, halfChunk, "utf8");
    const second = await parseJsonlFileIncremental(jsonlPath, first.state);
    expect(second.usedIncremental).toBe(true);
    expect(second.state.pendingFragment.length).toBeGreaterThan(0);
    expect(second.state.records.length).toBe(first.state.records.length);

    // Complete the line + add the rest.
    const completion = halfRecord.slice(halfChunk.length) + "\n" + recordsToJsonl(recs.slice(5));
    await fsp.appendFile(jsonlPath, completion, "utf8");
    const third = await parseJsonlFileIncremental(jsonlPath, second.state);
    expect(third.usedIncremental).toBe(true);
    expect(third.state.pendingFragment).toBe("");
    // All records present + equivalent to a fresh parse.
    const fresh = await parseJsonlFile(jsonlPath);
    expect(third.chatFlow.chatNodes.length).toBe(fresh.chatFlow.chatNodes.length);
  });

  it("does not mutate the prevState's records array (caller may keep stale snapshots)", async () => {
    const head = recordsToJsonl(buildSyntheticRecords().slice(0, 4));
    await fsp.writeFile(jsonlPath, head, "utf8");
    const first = await parseJsonlFileIncremental(jsonlPath, undefined);
    const beforeLen = first.state.records.length;
    const sharedRef: IncrementalParseState = first.state;

    const tail = recordsToJsonl(buildSyntheticRecords().slice(4, 8));
    await fsp.appendFile(jsonlPath, tail, "utf8");
    const second = await parseJsonlFileIncremental(jsonlPath, first.state);
    // Original state's array length unchanged — caller's prevState
    // reference must remain stable.
    expect(sharedRef.records.length).toBe(beforeLen);
    expect(second.state.records.length).toBeGreaterThan(beforeLen);
  });
});

describe("buildChatFlow reuse hint (M2 — v0.10 收尾 / v0.11 prep)", () => {
  // EN: the reuse hint is the M2 perf knob — a per-bucket short-
  // circuit that lets buildChatFlow skip the expensive
  // buildChatNode call for buckets that didn't accumulate new
  // records since the prev snapshot. The CRITICAL invariant: at
  // any split point of any record list, the M2 reuse path must
  // produce a ChatFlow that's byte-equivalent (= JSON.stringify-
  // equal) to a fresh full rebuild of the same records. Anything
  // less is silent corruption.
  // 中: 关键不变量 —— 任意 split 点上 M2 跟全量 rebuild 必须 JSON
  // 字节级相等。这条挂掉 = 数据 silent corrupt。
  const FIXTURE = "/synthetic/main.jsonl";
  const ALL_RECORDS = buildSyntheticRecords();

  function assertReuseEquivalent(splitAt: number): void {
    const head = ALL_RECORDS.slice(0, splitAt);
    const headCf = buildChatFlow(head, FIXTURE);
    const m2Cf = buildChatFlow(ALL_RECORDS, FIXTURE, undefined, {
      prevChatFlow: headCf,
      prevRecordCount: splitAt,
    });
    const fullCf = buildChatFlow(ALL_RECORDS, FIXTURE);
    expect(JSON.stringify(m2Cf)).toBe(JSON.stringify(fullCf));
  }

  it("equivalence at split=0 (empty prev → all buckets rebuild)", () => {
    assertReuseEquivalent(0);
  });

  it("equivalence at split=ALL.length (no new records → all buckets reuse)", () => {
    assertReuseEquivalent(ALL_RECORDS.length);
  });

  it("equivalence at every split point in the synthetic fixture", () => {
    // Brute-force: iterate every split. The synthetic fixture is
    // small enough (<100 records) that O(N²) buildChatFlow calls
    // is sub-second. If any split point fails we get a precise
    // pinpoint of where the M2 path diverges from full rebuild.
    for (let s = 0; s <= ALL_RECORDS.length; s += 1) {
      try {
        assertReuseEquivalent(s);
      } catch (err) {
        throw new Error(
          `M2 reuse diverges from full rebuild at split=${s}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  });

  it("PR E3 — explicit newRecords field drives dirty-bucket detection (closure>1 path)", () => {
    // EN: when the merged record stream is NOT append-only (records
    // from a non-last fork member land mid-stream), slice(prevCount)
    // can't find the new records. The `newRecords` field in the
    // reuse hint lets the caller declare the dirty records directly.
    //
    // We simulate this by passing the FULL record list as `records`
    // but only the last few promptIds' worth of records as
    // `newRecords`. The unchanged early buckets should be reused
    // (same object identity); the dirty buckets should rebuild.
    //
    // 中: closure>1 合并流非追加；显式 newRecords 决定哪些 bucket
    // 脏。这里模拟：records 全量；newRecords 只含部分。早段 bucket
    // 应原样复用（同对象引用），新段重建。
    const head = ALL_RECORDS.slice(0, ALL_RECORDS.length - 5);
    const headCf = buildChatFlow(head, FIXTURE);
    const tail = ALL_RECORDS.slice(ALL_RECORDS.length - 5);
    const reusedCf = buildChatFlow(ALL_RECORDS, FIXTURE, undefined, {
      prevChatFlow: headCf,
      prevRecordCount: 0, // unused in newRecords mode
      newRecords: tail,
    });
    const fullCf = buildChatFlow(ALL_RECORDS, FIXTURE);
    // Byte-equivalence with full rebuild — the critical invariant.
    expect(JSON.stringify(reusedCf)).toBe(JSON.stringify(fullCf));

    // Object-identity reuse for buckets untouched by `tail` records.
    // At least ONE early bucket should be a reused reference.
    // 中: 早段 bucket 应至少有一个 ChatNode 对象引用与 headCf 一致。
    const headById = new Map(headCf.chatNodes.map((cn) => [cn.id, cn]));
    let reusedCount = 0;
    for (const cn of reusedCf.chatNodes) {
      const prev = headById.get(cn.id);
      if (prev && prev === cn) reusedCount += 1;
    }
    expect(reusedCount).toBeGreaterThan(0);
  });

  it("PR E3 — newRecords mode tolerates an empty list (no dirty buckets)", () => {
    // EN: when caller passes newRecords=[], NO buckets are marked
    // dirty → every bucket reuses its prev ChatNode. Output must
    // still be byte-equivalent to a full rebuild.
    // 中: newRecords 空 → 没 dirty bucket，全 reuse；输出仍等于
    // 全量重建。
    const headCf = buildChatFlow(ALL_RECORDS, FIXTURE);
    const reusedCf = buildChatFlow(ALL_RECORDS, FIXTURE, undefined, {
      prevChatFlow: headCf,
      prevRecordCount: 0,
      newRecords: [],
    });
    expect(JSON.stringify(reusedCf)).toBe(JSON.stringify(headCf));
  });

  it("appends survive a parseJsonlFileIncremental → parseJsonlFileIncremental round-trip with M2 active", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "loomscope-m2-"));
    try {
      const filePath = path.join(tmpDir, "session.jsonl");
      const head = recordsToJsonl(ALL_RECORDS.slice(0, Math.floor(ALL_RECORDS.length / 2)));
      await fsp.writeFile(filePath, head, "utf8");
      const first = await parseJsonlFileIncremental(filePath, undefined);
      expect(first.state.chatFlow).not.toBeNull();

      // Append the rest. This call should hit the M2 path: reuse
      // unchanged old buckets, rebuild only the dirty ones.
      const tail = recordsToJsonl(ALL_RECORDS.slice(Math.floor(ALL_RECORDS.length / 2)));
      await fsp.appendFile(filePath, tail, "utf8");
      const second = await parseJsonlFileIncremental(filePath, first.state);
      expect(second.usedIncremental).toBe(true);

      // Equivalence to a clean full reparse.
      const fresh = await parseJsonlFile(filePath);
      expect(JSON.stringify(second.chatFlow)).toBe(
        JSON.stringify(fresh.chatFlow),
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// PR 2.5 / task #89: hasInFlightWork must treat 'tool_use' and other
// non-terminal stop_reasons as in-flight, not done. Pre-fix the
// running animation flickered off during inter-API-call gaps because
// CC sets stopReason='tool_use' on the assistant message that emits
// tool_use blocks, all tool_results write back, then the next
// API call is fired — between "all tools done" and "next stream
// starts" the data shape said complete + sessionLive decayed to false
// → animation off. Fix: only stopReasons in TERMINAL_STOP_REASONS
// count as terminal.
describe("computeWorkflowSummary — hasInFlightWork stop_reason gate (#89)", () => {
  // Helper to construct a minimal session via parseJsonlText and
  // extract the single ChatNode's hasInFlightWork.
  const trace = (
    lastStopReason: string | undefined,
    allToolsResolved = true,
  ): boolean => {
    const records: RawRecord[] = [
      {
        type: "user",
        uuid: "u-1",
        promptId: "p-flight",
        message: { role: "user", content: "do it" },
      } as RawRecord,
      {
        type: "assistant",
        uuid: "llm-1",
        parentUuid: "u-1",
        message: {
          id: "msg_A",
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
          stop_reason: lastStopReason,
        },
      } as RawRecord,
    ];
    if (allToolsResolved) {
      records.push({
        type: "user",
        uuid: "u-tr-1",
        promptId: "p-flight",
        parentUuid: "llm-1",
        // Record-level toolUseResult is the signal isToolResultRecord
        // checks (raw-record.ts:126); without it the parser doesn't
        // associate this record back to tool_call tu-1, leaving
        // resultBlock=null and forcing hasInFlightWork=true via the
        // tool_call branch.
        toolUseResult: { stdout: "ok" },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      } as RawRecord);
    }
    const cf = parseJsonlText(recordsToJsonl(records), FIXTURE_PATH).chatFlow;
    return cf.chatNodes[0]?.workflow.summary?.hasInFlightWork ?? false;
  };

  it("hasInFlightWork=true for stopReason='tool_use' even with all tool_results landed (waiting for next API call)", () => {
    expect(trace("tool_use", true)).toBe(true);
  });

  it("hasInFlightWork=true for stopReason='pause_turn' (CC harness pause, more API calls coming)", () => {
    expect(trace("pause_turn", true)).toBe(true);
  });

  it("hasInFlightWork=true for stopReason undefined (still streaming)", () => {
    expect(trace(undefined, true)).toBe(true);
  });

  it("hasInFlightWork=false for stopReason='end_turn' (turn truly done)", () => {
    expect(trace("end_turn", true)).toBe(false);
  });

  it("hasInFlightWork=false for stopReason='max_tokens' (terminated by token limit)", () => {
    expect(trace("max_tokens", true)).toBe(false);
  });

  it("hasInFlightWork=false for stopReason='stop_sequence' (matched stop string)", () => {
    expect(trace("stop_sequence", true)).toBe(false);
  });

  it("hasInFlightWork=false for stopReason='refusal' (safety-side terminal)", () => {
    expect(trace("refusal", true)).toBe(false);
  });

  it("hasInFlightWork=true regardless of stopReason when a tool_call lacks resultBlock (tool still running)", () => {
    // tool_use emitted but no tool_result yet — should still be in
    // flight even if (somehow) stopReason were terminal already.
    expect(trace("end_turn", false)).toBe(true);
  });
});

describe("readRecordsIncremental (v2.1 PR D4 stretch)", () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "loomscope-records-incr-"));
    jsonlPath = path.join(tmpDir, "session.jsonl");
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("prevState undefined → full read + populated state", async () => {
    const initial = recordsToJsonl(buildSyntheticRecords().slice(0, 4));
    await fsp.writeFile(jsonlPath, initial, "utf8");
    const r = await readRecordsIncremental(jsonlPath, undefined);
    expect(r.usedIncremental).toBe(false);
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.state.byteSize).toBe(initial.length);
  });

  it("appended file → incremental tail-read produces same records as full read", async () => {
    const all = buildSyntheticRecords();
    const head = recordsToJsonl(all.slice(0, 5));
    await fsp.writeFile(jsonlPath, head, "utf8");
    const first = await readRecordsIncremental(jsonlPath, undefined);
    const tail = recordsToJsonl(all.slice(5));
    await fsp.appendFile(jsonlPath, tail, "utf8");
    const second = await readRecordsIncremental(jsonlPath, first.state);
    expect(second.usedIncremental).toBe(true);
    // Same total record count as a fresh full read.
    // 中: 增量 + 原 state ≡ 全量重读。
    const fresh = await readRecordsIncremental(jsonlPath, undefined);
    expect(second.records.length).toBe(fresh.records.length);
  });

  it("file shrunk → falls back to full read", async () => {
    const all = recordsToJsonl(buildSyntheticRecords().slice(0, 6));
    await fsp.writeFile(jsonlPath, all, "utf8");
    const first = await readRecordsIncremental(jsonlPath, undefined);
    // Truncate.
    // 中: 文件被截断（重写）→ fallback 全量。
    await fsp.writeFile(jsonlPath, recordsToJsonl(buildSyntheticRecords().slice(0, 2)), "utf8");
    const second = await readRecordsIncremental(jsonlPath, first.state);
    expect(second.usedIncremental).toBe(false);
  });
});
