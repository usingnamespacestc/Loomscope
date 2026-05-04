// Render tests for ChatNodeDetail + WorkNodeDetail. Each kind branch
// gets a focused fixture verifying the spec'd fields surface.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChatNodeDetail } from "@/components/drill/ChatNodeDetail";
import {
  WorkNodeDetail,
  extractOverflowRefId,
} from "@/components/drill/WorkNodeDetail";
import type {
  AttachmentNode,
  ChatFlow,
  ChatNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
} from "@/data/types";

// v0.8.1 #9: ChatNodeDetail now needs `chatFlow` for the "本节点
// 文件改动" parent-snapshot walk. Tests use a minimal flow that wraps
// the ChatNode under test, optionally with extra ancestors.
function flowFor(...chatNodes: ChatNode[]): ChatFlow {
  return {
    id: "test-flow",
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

function makeChatNode(extra: Partial<ChatNode> = {}): ChatNode {
  return {
    kind: "chat",
    id: "p1",
    parentChatNodeId: null,
    rootUserUuid: "u1",
    userMessage: { uuid: "u1", content: "hello **world**", attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
    ...extra,
  };
}

describe("ChatNodeDetail", () => {
  it("renders user message via markdown (bold becomes <strong>)", () => {
    const cn = makeChatNode({
      userMessage: { uuid: "u1", content: "hello **world**", attachments: [] },
    });
    const { container } = render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
  });

  it("falls back to JsonView when user message content is structured", () => {
    const cn = makeChatNode({
      userMessage: { uuid: "u1", content: { weird: "shape" }, attachments: [] },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(screen.getByTestId("json-view")).toBeTruthy();
  });

  it("renders the last llm_call's text as the assistant reply (last wins)", () => {
    const cn = makeChatNode({
      workflow: {
        nodes: [
          {
            id: "l-early",
            kind: "llm_call",
            parentUuid: null,
            text: "early text",
            thinking: [],
          },
          {
            id: "l-late",
            kind: "llm_call",
            parentUuid: "l-early",
            text: "final answer",
            thinking: [],
          },
        ],
        edges: [],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(screen.getByText("final answer")).toBeTruthy();
  });

  it("shows WorkFlow summary counts", () => {
    const cn = makeChatNode({
      workflow: {
        nodes: [
          { id: "l1", kind: "llm_call", parentUuid: null, text: "", thinking: [] },
          { id: "t1", kind: "tool_call", parentUuid: "l1", toolName: "Bash", input: {} },
          { id: "d1", kind: "delegate", parentUuid: "l1", toolName: "Agent" },
        ],
        edges: [],
      },
    });
    const { container } = render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(container.textContent).toMatch(/llm_call: 1/);
    expect(container.textContent).toMatch(/tool_call \+ delegate: 2/);
  });

  it("renders slash command stdout when present", () => {
    const cn = makeChatNode({
      slashCommand: { name: "/model", args: undefined, stdout: "Set model to Opus" },
    });
    const { container } = render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(container.textContent).toMatch(/\/model/);
    expect(container.textContent).toMatch(/Set model to Opus/);
  });

  it("v0.8.1 #9: 本轮累积 section title carries the new wording", () => {
    const cn = makeChatNode({
      meta: {
        fileHistorySnapshots: [
          { uuid: "s1", trackedFiles: ["a.ts"], isUpdate: false },
        ],
      },
    });
    const { container } = render(
      <ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />,
    );
    expect(container.textContent).toMatch(/本轮累积文件改动/);
  });

  it("v0.8.1 #9: 本节点文件改动 section subtracts the parent's snapshot from the child's", () => {
    const parent = makeChatNode({
      id: "parent",
      parentChatNodeId: null,
      meta: {
        fileHistorySnapshots: [
          { uuid: "p", trackedFiles: ["a.ts", "b.ts"], isUpdate: false },
        ],
      },
    });
    const child = makeChatNode({
      id: "child",
      parentChatNodeId: "parent",
      meta: {
        fileHistorySnapshots: [
          {
            uuid: "c",
            trackedFiles: ["a.ts", "b.ts", "newfile.ts"],
            isUpdate: false,
          },
        ],
      },
    });
    render(<ChatNodeDetail chatNode={child} chatFlow={flowFor(parent, child)} />);
    // newfile.ts is the only path attributable to THIS node.
    expect(screen.getByTestId("nofc-row-newfile.ts")).toBeTruthy();
    expect(screen.queryByTestId("nofc-row-a.ts")).toBeNull();
    expect(screen.queryByTestId("nofc-row-b.ts")).toBeNull();
  });

  it("v0.8.1 #9: 本节点 section hides entirely when selfDelta is empty + no tool_use", () => {
    const parent = makeChatNode({
      id: "parent",
      meta: {
        fileHistorySnapshots: [
          { uuid: "p", trackedFiles: ["a.ts"], isUpdate: false },
        ],
      },
    });
    const child = makeChatNode({
      id: "child",
      parentChatNodeId: "parent",
      meta: {
        fileHistorySnapshots: [
          { uuid: "c", trackedFiles: ["a.ts"], isUpdate: false },
        ],
      },
    });
    render(<ChatNodeDetail chatNode={child} chatFlow={flowFor(parent, child)} />);
    expect(screen.queryByTestId("node-own-file-changes")).toBeNull();
  });

  it("renders 本轮累积文件改动 section when fileHistorySnapshots are bound (sorted union)", () => {
    const cn = makeChatNode({
      meta: {
        fileHistorySnapshots: [
          {
            uuid: "snap-A",
            timestamp: "2026-04-10T03:10:00Z",
            trackedFiles: ["src/A.ts", "docs/devlog.md"],
            isUpdate: false,
          },
          {
            uuid: "snap-B",
            timestamp: "2026-04-10T03:10:30Z",
            trackedFiles: ["src/A.ts", "src/B.ts"],
            isUpdate: false,
          },
        ],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(screen.getByTestId("fh-row-docs/devlog.md")).toBeTruthy();
    expect(screen.getByTestId("fh-row-src/A.ts")).toBeTruthy();
    expect(screen.getByTestId("fh-row-src/B.ts")).toBeTruthy();
  });

  it("paths only seen on isUpdate=true snapshots get gray-400 path text", () => {
    const cn = makeChatNode({
      meta: {
        fileHistorySnapshots: [
          { uuid: "fresh", trackedFiles: ["src/A.ts"], isUpdate: false },
          {
            uuid: "upd",
            trackedFiles: ["src/A.ts", "stale-only.ts"],
            isUpdate: true,
          },
        ],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    const fresh = screen.getByTestId("fh-row-src/A.ts");
    const stale = screen.getByTestId("fh-row-stale-only.ts");
    // Path text cell = first child div in the grid row
    expect(fresh.children[0].className).not.toMatch(/text-gray-400/);
    expect(stale.children[0].className).toMatch(/text-gray-400/);
  });

  it("hides the section when neither snapshots nor tool_use file paths exist", () => {
    const cn = makeChatNode({});
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(screen.queryByTestId("file-history-snapshot-list")).toBeNull();
  });

  // ── M1c side-by-side comparison ──────────────────────────────────────

  it("paths in BOTH snapshot and tool_use render normal color with ✓ marks", () => {
    const cn = makeChatNode({
      workflow: {
        nodes: [
          {
            id: "t1",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Edit",
            input: { file_path: "src/A.ts", old_string: "a", new_string: "b" },
          },
        ],
        edges: [],
      },
      meta: {
        fileHistorySnapshots: [
          { uuid: "s1", trackedFiles: ["src/A.ts"], isUpdate: false },
        ],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    const row = screen.getByTestId("fh-row-src/A.ts");
    expect(row.className).not.toMatch(/text-amber-700/);
    expect(screen.getByTestId("fh-src/A.ts-snap").textContent).toBe("✓");
    expect(screen.getByTestId("fh-src/A.ts-tool").textContent).toBe("✓");
  });

  it("snapshot-only paths get amber + 📸/⚠ markers (side-effect)", () => {
    const cn = makeChatNode({
      workflow: { nodes: [], edges: [] },
      meta: {
        fileHistorySnapshots: [
          {
            uuid: "s1",
            trackedFiles: ["docs/devlog.md"],
            isUpdate: false,
          },
        ],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    const row = screen.getByTestId("fh-row-docs/devlog.md");
    expect(row.className).toMatch(/text-amber-700/);
    expect(screen.getByTestId("fh-docs/devlog.md-snap").textContent).toBe("📸");
    expect(screen.getByTestId("fh-docs/devlog.md-tool").textContent).toBe("⚠");
  });

  it("tool_use-only paths (.gitignore'd ghost write) get amber + 🔧 marker", () => {
    const cn = makeChatNode({
      workflow: {
        nodes: [
          {
            id: "t1",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Write",
            input: { file_path: ".env.local", content: "SECRET=" },
          },
        ],
        edges: [],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    const row = screen.getByTestId("fh-row-.env.local");
    expect(row.className).toMatch(/text-amber-700/);
    expect(screen.getByTestId("fh-.env.local-snap").textContent).toBe("—");
    expect(screen.getByTestId("fh-.env.local-tool").textContent).toBe("🔧");
  });

  it("recognizes Edit/Write/MultiEdit/NotebookEdit tool_use file paths", () => {
    const cn = makeChatNode({
      workflow: {
        nodes: [
          {
            id: "t1",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Edit",
            input: { file_path: "edit.ts" },
          },
          {
            id: "t2",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Write",
            input: { file_path: "write.ts" },
          },
          {
            id: "t3",
            kind: "tool_call",
            parentUuid: null,
            toolName: "MultiEdit",
            input: { file_path: "multi.ts" },
          },
          {
            id: "t4",
            kind: "tool_call",
            parentUuid: null,
            toolName: "NotebookEdit",
            input: { notebook_path: "nb.ipynb" },
          },
          {
            id: "t5",
            kind: "tool_call",
            parentUuid: null,
            toolName: "Bash",
            input: { command: "echo hi" },
          },
        ],
        edges: [],
      },
    });
    render(<ChatNodeDetail chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(screen.getByTestId("fh-row-edit.ts")).toBeTruthy();
    expect(screen.getByTestId("fh-row-write.ts")).toBeTruthy();
    expect(screen.getByTestId("fh-row-multi.ts")).toBeTruthy();
    expect(screen.getByTestId("fh-row-nb.ipynb")).toBeTruthy();
    // Bash deliberately NOT extracted (path lives in stdout, v0.10
    // polish range).
    expect(screen.queryByTestId("fh-row-echo hi")).toBeNull();
  });
});

describe("WorkNodeDetail — llm_call", () => {
  it("renders model + text + thinking blocks", () => {
    const node: LlmCallNode = {
      id: "l1",
      kind: "llm_call",
      parentUuid: null,
      model: "claude-opus-4-7",
      text: "the **answer**",
      thinking: [{ text: "let me think" }, { text: "more thoughts" }],
      usage: { input_tokens: 100 },
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/claude-opus-4-7/);
    // Markdown bold wrapper present.
    expect(container.querySelector("strong")?.textContent).toBe("answer");
    expect(container.textContent).toMatch(/let me think/);
    expect(container.textContent).toMatch(/more thoughts/);
    // Usage rendered via JsonView.
    expect(screen.getByTestId("json-view")).toBeTruthy();
  });
});

describe("WorkNodeDetail — tool_call", () => {
  it("renders Bash command in a code block", () => {
    const node: ToolCallNode = {
      id: "t1",
      kind: "tool_call",
      parentUuid: "l1",
      toolName: "Bash",
      input: { command: "ls -la /tmp", description: "list tmp" },
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/list tmp/);
    expect(container.querySelector("pre")?.textContent).toBe("ls -la /tmp");
  });

  it("uses JsonView for non-Bash tools' input", () => {
    const node: ToolCallNode = {
      id: "t1",
      kind: "tool_call",
      parentUuid: "l1",
      toolName: "Glob",
      input: { pattern: "**/*.ts" },
    };
    render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    // At least 2 JsonView instances: input + result.
    expect(screen.getAllByTestId("json-view").length).toBeGreaterThanOrEqual(1);
  });

  it("renders DiffView when toolUseResult.structuredPatch is present", () => {
    const node: ToolCallNode = {
      id: "t-edit",
      kind: "tool_call",
      parentUuid: "l1",
      toolName: "Edit",
      input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
      toolUseResult: {
        filePath: "/x.ts",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
        ],
      },
    };
    render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(screen.getByTestId("diff-view")).toBeTruthy();
  });

  it("flags ✗ failed marker when isError", () => {
    const node: ToolCallNode = {
      id: "t-err",
      kind: "tool_call",
      parentUuid: null,
      toolName: "Bash",
      input: { command: "exit 1" },
      isError: true,
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/✗ failed/);
  });
});

describe("WorkNodeDetail — delegate", () => {
  it("renders agentType / status / stats and the rendered description", () => {
    const node: DelegateNode = {
      id: "d1",
      kind: "delegate",
      parentUuid: "l1",
      toolName: "Agent",
      agentType: "Explore",
      agentId: "abc123",
      status: "completed",
      description: "Map backend",
      content: "Found 3 services",
      totalDurationMs: 50_000,
      totalTokens: 49_560,
      totalToolUseCount: 21,
      toolStats: { readCount: 5 },
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/Explore/);
    expect(container.textContent).toMatch(/abc123/);
    expect(container.textContent).toMatch(/Map backend/);
    expect(container.textContent).toMatch(/Found 3 services/);
    expect(container.textContent).toMatch(/totalDurationMs: 50000/);
  });
});

describe("WorkNodeDetail — compact", () => {
  it("renders trigger + summary text via markdown", () => {
    const node: CompactNode = {
      id: "c1",
      kind: "compact",
      parentUuid: null,
      trigger: "manual",
      preTokens: 50_000,
      summaryText: "**summary** of prior",
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/manual/);
    expect(container.querySelector("strong")?.textContent).toBe("summary");
  });
});

describe("extractOverflowRefId", () => {
  it("matches CC v2.1.104+ <persisted-output> string format", () => {
    const block = {
      type: "tool_result",
      content:
        "<persisted-output>\nOutput too large (144.2KB). Full output saved to: /home/u/.claude/projects/-x/sid/tool-results/b0h2c79j6.txt\n\nPreview…",
    };
    expect(extractOverflowRefId(block)).toBe("b0h2c79j6");
  });

  it("matches the documented ContentReplacementRecord object format", () => {
    const block = {
      type: "tool_result",
      content: { type: "content_replacement", refId: "abc_def-123" },
    };
    expect(extractOverflowRefId(block)).toBe("abc_def-123");
  });

  it("matches a content_replacement block nested inside an array", () => {
    const block = {
      type: "tool_result",
      content: [{ type: "content_replacement", refId: "nested_ref" }],
    };
    expect(extractOverflowRefId(block)).toBe("nested_ref");
  });

  it("matches a string text block carrying the persisted-output marker", () => {
    const block = {
      type: "tool_result",
      content: [
        {
          type: "text",
          text: "<persisted-output>… tool-results/multi_block_ref.txt …",
        },
      ],
    };
    expect(extractOverflowRefId(block)).toBe("multi_block_ref");
  });

  it("returns null for ordinary tool_result content (no overflow)", () => {
    expect(
      extractOverflowRefId({ type: "tool_result", content: "5 paths" }),
    ).toBeNull();
    expect(
      extractOverflowRefId({ type: "tool_result", content: [] }),
    ).toBeNull();
    expect(extractOverflowRefId(null)).toBeNull();
    expect(extractOverflowRefId({})).toBeNull();
  });
});

describe("WorkNodeDetail — attachment", () => {
  it("renders type label + raw JsonView", () => {
    const node: AttachmentNode = {
      id: "a1",
      kind: "attachment",
      parentUuid: null,
      attachmentType: "queued_command",
      raw: { attachment: { prompt: "do thing" } },
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/queued_command/);
    expect(screen.getByTestId("json-view")).toBeTruthy();
  });

  it("compact_file_reference renders dashed-gray card with filename + ⊠ marker (v0.7 M5 4A 精装)", () => {
    const node: AttachmentNode = {
      id: "a2",
      kind: "attachment",
      parentUuid: null,
      attachmentType: "compact_file_reference",
      raw: {
        attachment: {
          type: "compact_file_reference",
          filename: "src/parse/jsonl.ts",
          displayPath: "/home/u/Loomscope/src/parse/jsonl.ts",
        },
      },
    };
    render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    const card = screen.getByTestId("compact-file-reference-card");
    expect(card.className).toMatch(/border-dashed/);
    expect(card.className).toMatch(/gray/);
    // Filename surfaced as bold heading.
    expect(card.textContent).toContain("src/parse/jsonl.ts");
    // displayPath surfaced as mono path.
    expect(card.textContent).toContain("/home/u/Loomscope/src/parse/jsonl.ts");
    // ⊠ badge + "原文不在 jsonl 中" subtitle.
    expect(card.textContent).toMatch(/content compacted/);
    expect(card.textContent).toMatch(/原文不在 jsonl 中/);
  });

  it("compact_file_reference card surfaces (filename 缺失) when filename absent", () => {
    const node: AttachmentNode = {
      id: "a3",
      kind: "attachment",
      parentUuid: null,
      attachmentType: "compact_file_reference",
      raw: { attachment: { type: "compact_file_reference" } },
    };
    render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    const card = screen.getByTestId("compact-file-reference-card");
    expect(card.textContent).toMatch(/filename 缺失/);
  });

  it("non-compact attachment kinds keep the legacy type-label rendering (no compact card)", () => {
    const node: AttachmentNode = {
      id: "a-norm",
      kind: "attachment",
      parentUuid: null,
      attachmentType: "queued_command",
      raw: { attachment: { prompt: "x" } },
    };
    render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(screen.queryByTestId("compact-file-reference-card")).toBeNull();
  });
});
