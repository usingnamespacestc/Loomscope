// Render tests for ChatNodeDetail + WorkNodeDetail. Each kind branch
// gets a focused fixture verifying the spec'd fields surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChatNodeDetail } from "@/components/drill/ChatNodeDetail";
import {
  WorkNodeDetail,
  extractOverflowRefId,
} from "@/components/drill/WorkNodeDetail";
import { WorkFlowPanContext } from "@/canvas/WorkFlowPanContext";
import { useStore } from "@/store/index";
import type {
  AttachmentNode,
  ChatFlow,
  ChatNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
  WorkNode,
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
    const { container } = render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
  });

  it("falls back to JsonView when user message content is structured", () => {
    const cn = makeChatNode({
      userMessage: { uuid: "u1", content: { weird: "shape" }, attachments: [] },
    });
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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
    const { container } = render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(container.textContent).toMatch(/llm_call: 1/);
    expect(container.textContent).toMatch(/tool_call \+ delegate: 2/);
  });

  it("renders slash command stdout when present", () => {
    const cn = makeChatNode({
      slashCommand: { name: "/model", args: undefined, stdout: "Set model to Opus" },
    });
    const { container } = render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(container.textContent).toMatch(/\/model/);
    expect(container.textContent).toMatch(/Set model to Opus/);
  });

  it("v0.8.1 #9: session 触及文件 section title carries the new wording", () => {
    const cn = makeChatNode({
      meta: {
        fileHistorySnapshots: [
          { uuid: "s1", trackedFiles: ["a.ts"], isUpdate: false },
        ],
      },
    });
    const { container } = render(
      <ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />,
    );
    expect(container.textContent).toMatch(/session 触及文件/);
  });

  it("v0.8.1 #9: 本节点新触及文件 section subtracts the parent's snapshot from the child's", () => {
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={child} chatFlow={flowFor(parent, child)} />);
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={child} chatFlow={flowFor(parent, child)} />);
    expect(screen.queryByTestId("node-own-file-changes")).toBeNull();
  });

  it("renders session 触及文件 section using LATEST snapshot only — earlier snapshots are subsumed by the cumulative latest frame", () => {
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
    // Latest snapshot has {A, B}. devlog.md was in the earlier
    // snapshot only — should NOT render (would have been a 3rd row
    // pre-fix, mistakenly inflating the count).
    expect(screen.getByTestId("fh-row-src/A.ts")).toBeTruthy();
    expect(screen.getByTestId("fh-row-src/B.ts")).toBeTruthy();
    expect(screen.queryByTestId("fh-row-docs/devlog.md")).toBeNull();
  });

  it("post-commit: latest snapshot empty → section hidden (chip would also show 0)", () => {
    // User ran `git commit` mid-turn. Pre-fix the union still showed
    // {A.ts, stale.ts}; post-fix the latest empty snapshot wins, so
    // there are no snapshot rows. With no tool_use either, the whole
    // section disappears.
    const cn = makeChatNode({
      meta: {
        fileHistorySnapshots: [
          { uuid: "before", trackedFiles: ["src/A.ts", "stale.ts"], isUpdate: false },
          { uuid: "after-commit", trackedFiles: [], isUpdate: true },
        ],
      },
    });
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
    expect(screen.queryByTestId("file-history-snapshot-list")).toBeNull();
    expect(screen.queryByTestId("fh-row-src/A.ts")).toBeNull();
    expect(screen.queryByTestId("fh-row-stale.ts")).toBeNull();
  });

  it("hides the section when neither snapshots nor tool_use file paths exist", () => {
    const cn = makeChatNode({});
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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
    render(<ChatNodeDetail sessionId="test-sid" chatNode={cn} chatFlow={flowFor(cn)} />);
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

// ─── PR 2: LlmCallDetail input/output redesign + dual-track nav ───────

const SID2 = "22222222-1111-4000-8000-000000000eee";

function llm(id: string, parentUuid: string | null = null, extra: Partial<LlmCallNode> = {}): LlmCallNode {
  return {
    id,
    kind: "llm_call",
    parentUuid,
    model: "claude-opus-4-7",
    text: "",
    thinking: [],
    ...extra,
  };
}
function tc(
  id: string,
  parentUuid: string | null,
  toolName = "Bash",
  resultUserUuid?: string,
  input: Record<string, unknown> = { command: "echo" },
): ToolCallNode {
  return {
    id,
    kind: "tool_call",
    parentUuid,
    toolName,
    input,
    resultUserUuid,
  };
}

function compactNode(id: string, parentUuid: string | null = null): CompactNode {
  return {
    id,
    kind: "compact",
    parentUuid,
    summaryText: "compacted earlier turns",
  };
}

function seedSession(): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID2, {
      chatFlow: null as unknown as ChatFlow,
      foldedNodeIds: new Set(),
      foldedCompactIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      workflowCache: new Map(),
      workflowViewports: new Map(),
      pendingPermission: null,
      lastNotification: null,
      currentTurn: null,
      lastTurnHookAt: 0,
      isLoading: false,
      error: null,
      lastUpdated: 0,
      lastInvalidateAt: 0,
    });
    return { sessions, activeSessionId: SID2 };
  });
}

function renderWithPan(workNode: WorkNode, workflowNodes: WorkNode[], panFn?: (id: string) => void) {
  const ref = { current: panFn ?? null };
  return render(
    <WorkFlowPanContext.Provider value={{ ref }}>
      <WorkNodeDetail
        workNode={workNode}
        sessionId={SID2}
        workflowNodes={workflowNodes}
      />
    </WorkFlowPanContext.Provider>,
  );
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});
afterEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("LlmCallDetail PR 2-A — input section", () => {
  it("renders the Conversation jump button + system prompt note", () => {
    seedSession();
    const node = llm("l1");
    renderWithPan(node, [node]);
    expect(screen.getByTestId("llm-input-jump-conversation")).toBeTruthy();
    const note = screen.getByTestId("llm-input-system-note");
    expect(note.textContent).toMatch(/system prompt/);
    expect(note.textContent).toMatch(/不写入 jsonl/);
  });

  it("clicking the jump button switches drillPanelTab to 'conversation'", () => {
    seedSession();
    useStore.setState({ drillPanelTab: "detail" });
    const node = llm("l1");
    renderWithPan(node, [node]);
    fireEvent.click(screen.getByTestId("llm-input-jump-conversation"));
    expect(useStore.getState().drillPanelTab).toBe("conversation");
  });
});

describe("LlmCallDetail PR 2-B — spawned tool calls (dual-track)", () => {
  it("lists tool_calls whose parentUuid === this llm_call's id", () => {
    seedSession();
    const root = llm("l-root");
    const t1 = tc("t-1", "l-root", "Bash");
    const t2 = tc("t-2", "l-root", "Read");
    // Sibling tool_call NOT spawned by us — must be excluded.
    const tOther = tc("t-other", "l-other-llm", "Glob");
    renderWithPan(root, [root, t1, t2, tOther]);
    const section = screen.getByTestId("llm-spawned-tools");
    expect(section.textContent).toMatch(/触发的工具调用 \(2\)/);
    expect(screen.getByTestId("llm-spawned-tool-row-t-1")).toBeTruthy();
    expect(screen.getByTestId("llm-spawned-tool-row-t-2")).toBeTruthy();
    expect(screen.queryByTestId("llm-spawned-tool-row-t-other")).toBeNull();
  });

  it("clicking the row jumps: selects the target WorkNode AND pans the canvas", () => {
    seedSession();
    const root = llm("l-root");
    const t1 = tc("t-1", "l-root", "Bash");
    const panSpy = vi.fn();
    renderWithPan(root, [root, t1], panSpy);
    fireEvent.click(screen.getByTestId("llm-spawned-tool-jump-t-1"));
    expect(useStore.getState().sessions.get(SID2)?.workflowSelectedNodeId).toBe("t-1");
    expect(panSpy).toHaveBeenCalledWith("t-1");
  });

  it("section absent when no tool_calls were spawned", () => {
    seedSession();
    const node = llm("l-only");
    renderWithPan(node, [node]);
    expect(screen.queryByTestId("llm-spawned-tools")).toBeNull();
  });
});

describe("LlmCallDetail PR 2-C — chain accumulation", () => {
  it("walks parentUuid back through tool_call.resultUserUuid + spawn edges", () => {
    seedSession();
    // Chain: l1 → t1 (parent=l1, resultUuid=u1) → l2 (parent=u1)
    //        → t2 (parent=l2, resultUuid=u2) → l3 (parent=u2)
    const l1 = llm("l1", null, { thinking: [{ text: "first thinking" }] });
    const t1 = tc("t1", "l1", "Bash", "u1");
    const l2 = llm("l2", "u1", { thinking: [{ text: "second thinking" }] });
    const t2 = tc("t2", "l2", "Read", "u2");
    const l3 = llm("l3", "u2");
    renderWithPan(l3, [l1, t1, l2, t2, l3]);
    // Section header surfaces aggregate counts (2 prior llm_calls,
    // 2 prior tool_calls in the chain history).
    const toggle = screen.getByTestId("llm-chain-history-toggle");
    expect(toggle.textContent).toMatch(/2 次 thinking/);
    expect(toggle.textContent).toMatch(/2 次 tool 交互/);
  });

  it("default-folded; expanding reveals the node list", () => {
    seedSession();
    const l1 = llm("l1");
    const t1 = tc("t1", "l1", "Bash", "u1");
    const l2 = llm("l2", "u1");
    renderWithPan(l2, [l1, t1, l2]);
    expect(screen.queryByTestId("llm-chain-history-list")).toBeNull();
    fireEvent.click(screen.getByTestId("llm-chain-history-toggle"));
    expect(screen.getByTestId("llm-chain-history-list")).toBeTruthy();
    // Both predecessors listed.
    expect(screen.getByTestId("llm-chain-history-row-l1")).toBeTruthy();
    expect(screen.getByTestId("llm-chain-history-row-t1")).toBeTruthy();
  });

  it("section absent when llm_call has no chain predecessors (chain root)", () => {
    seedSession();
    const root = llm("l-root", null);
    renderWithPan(root, [root]);
    expect(screen.queryByTestId("llm-chain-history")).toBeNull();
  });

  it("chain walk stops at parentUuid pointing OUTSIDE the WorkFlow", () => {
    seedSession();
    // l2.parentUuid points at a uuid not in nodes → walk should stop
    // immediately, no chain history rendered.
    const l2 = llm("l2", "external-uuid-not-here");
    renderWithPan(l2, [l2]);
    expect(screen.queryByTestId("llm-chain-history")).toBeNull();
  });
});

describe("LlmCallDetail PR 2.2 — chain_position metadata", () => {
  it("first llm_call in WorkFlow shows 'WorkFlow 起点' label", () => {
    seedSession();
    const root = llm("l-root", null);
    renderWithPan(root, [root]);
    const first = screen.getByTestId("llm-chain-position-first");
    expect(first.textContent).toMatch(/WorkFlow 起点/);
    expect(first.textContent).toMatch(/第 1 条链/);
    expect(screen.queryByTestId("llm-chain-position-with-prev")).toBeNull();
  });

  it("mid-chain llm_call (parent resolves inside WorkFlow) — no chain_position row", () => {
    seedSession();
    // l1 → t1 → l2: l2 is mid-chain, NOT a chain root.
    const l1 = llm("l1");
    const t1 = tc("t1", "l1", "Bash", "u-res");
    const l2 = llm("l2", "u-res");
    renderWithPan(l2, [l1, t1, l2]);
    expect(screen.queryByTestId("llm-chain-position-first")).toBeNull();
    expect(screen.queryByTestId("llm-chain-position-with-prev")).toBeNull();
  });

  it("chain root with previous chain in workflow + no gap evidence → 'no visible evidence' message", () => {
    seedSession();
    // Chain 1: l1 → t1 → l2 (parent=u-res-1) — continuous chain.
    // Chain 2: l3 has parentUuid pointing at an external uuid (no
    // resolution) — chain root. Tail = l2. No CompactNode/Attachment
    // between → "本 WorkFlow 内在两条链之间没有可见证据".
    const l1 = llm("l1");
    const t1 = tc("t1", "l1", "Bash", "u-res-1");
    const l2 = llm("l2", "u-res-1");
    const l3 = llm("l3", "external-uuid");
    renderWithPan(l3, [l1, t1, l2, l3]);
    const row = screen.getByTestId("llm-chain-position-with-prev");
    expect(row.textContent).toMatch(/新链起点/);
    expect(row.textContent).toMatch(/前一条链结束于/);
    // Tail link points at l2.
    const tailLink = screen.getByTestId("llm-chain-position-tail-link");
    expect(tailLink.textContent).toContain("l2");
    // No evidence list rendered; sentinel text instead.
    expect(screen.queryByTestId("llm-chain-position-evidence-list")).toBeNull();
    expect(screen.getByTestId("llm-chain-position-no-evidence")).toBeTruthy();
    // PR 2.4-C revert: caveat copy now explains the compact-less
    // case (post 'compact = real break' semantics).
    expect(row.textContent).toMatch(/无 compact 痕迹但 chain 在此重置/);
  });

  it("chain root with intervening CompactNode → confident '因 compact 断链' verdict + compact link + preTokens", () => {
    seedSession();
    // Chain 1: l1 (root). CompactNode c1 with preTokens between.
    // Chain 2: l2 (chain root, parentUuid points outside).
    // Compact replaces prior context with summary, so it's the
    // unambiguous cause — the UI gives a definite verdict, not the
    // hedged evidence-list path.
    const l1 = llm("l1");
    const c1: CompactNode = { ...compactNode("c1"), preTokens: 92_300 };
    const l2 = llm("l2", "external-uuid");
    renderWithPan(l2, [l1, c1, l2]);
    const cause = screen.getByTestId("llm-chain-position-cause-compact");
    expect(cause.textContent).toMatch(/因 compact 断链/);
    expect(cause.textContent).toMatch(/preTokens 92\.3k/i);
    expect(screen.getByTestId("llm-chain-position-compact-link")).toBeTruthy();
    // Evidence-list path NOT used when compact present.
    expect(screen.queryByTestId("llm-chain-position-evidence-list")).toBeNull();
    // Old "无法精确判断" caveat replaced with compact-specific copy.
    expect(cause.textContent).toMatch(/前面对话被替换为摘要/);
  });

  it("clicking tail link jumps: selects target AND pans the canvas", () => {
    seedSession();
    const l1 = llm("l1");
    const l2 = llm("l2", "external-uuid");
    const panSpy = vi.fn();
    renderWithPan(l2, [l1, l2], panSpy);
    fireEvent.click(screen.getByTestId("llm-chain-position-tail-link"));
    expect(useStore.getState().sessions.get(SID2)?.workflowSelectedNodeId).toBe("l1");
    expect(panSpy).toHaveBeenCalledWith("l1");
  });
});

describe("LlmCallDetail PR 2.3 — ctx tokens + delta", () => {
  it("usage section shows ctx (input + cache_read + cache_creation) cumulative tokens", () => {
    seedSession();
    const node = llm("l1", null, {
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 500,
      },
    });
    renderWithPan(node, [node]);
    const usage = screen.getByTestId("llm-usage");
    // Cumulative ctx = 1000 + 5000 + 500 = 6500 → "6.5k".
    expect(usage.textContent).toMatch(/6\.5k/);
    // Output line still present (200 → "200" since < 1k).
    expect(usage.textContent).toMatch(/output:.*200/);
  });

  it("delta row absent when node is the first llm_call in the chain (no predecessor)", () => {
    seedSession();
    const node = llm("l1", null, {
      usage: { input_tokens: 1000, output_tokens: 200 },
    });
    renderWithPan(node, [node]);
    expect(screen.queryByTestId("llm-usage-delta")).toBeNull();
  });

  it("delta row shows positive delta when next llm_call grew the context", () => {
    seedSession();
    // Chain: l1 (ctx 1000) → t1 → l2 (ctx 8500) — delta on l2 = +7.5k.
    const l1 = llm("l1", null, { usage: { input_tokens: 1000, output_tokens: 100 } });
    const t1 = tc("t1", "l1", "Bash", "u-res-1");
    const l2 = llm("l2", "u-res-1", {
      usage: {
        input_tokens: 7500,
        output_tokens: 200,
        cache_read_input_tokens: 1000,
      },
    });
    renderWithPan(l2, [l1, t1, l2]);
    const delta = screen.getByTestId("llm-usage-delta");
    // l2 ctx = 7500 + 1000 = 8500; l1 ctx = 1000; delta = 7500.
    expect(delta.textContent).toMatch(/\+7\.5k/);
  });

  it("delta row negative when context shrank (e.g. mid-turn compact)", () => {
    seedSession();
    // l1 ctx 50k → l2 ctx 10k (post-compact: huge drop).
    const l1 = llm("l1", null, { usage: { input_tokens: 50_000 } });
    const t1 = tc("t1", "l1", "Bash", "u-res-1");
    const l2 = llm("l2", "u-res-1", { usage: { input_tokens: 10_000 } });
    renderWithPan(l2, [l1, t1, l2]);
    const delta = screen.getByTestId("llm-usage-delta");
    expect(delta.textContent).toMatch(/-40\.0k/);
  });
});
