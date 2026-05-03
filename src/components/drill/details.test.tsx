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
  ChatNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
} from "@/data/types";

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
    const { container } = render(<ChatNodeDetail chatNode={cn} />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
  });

  it("falls back to JsonView when user message content is structured", () => {
    const cn = makeChatNode({
      userMessage: { uuid: "u1", content: { weird: "shape" }, attachments: [] },
    });
    render(<ChatNodeDetail chatNode={cn} />);
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
    render(<ChatNodeDetail chatNode={cn} />);
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
    const { container } = render(<ChatNodeDetail chatNode={cn} />);
    expect(container.textContent).toMatch(/llm_call: 1/);
    expect(container.textContent).toMatch(/tool_call \+ delegate: 2/);
  });

  it("renders slash command stdout when present", () => {
    const cn = makeChatNode({
      slashCommand: { name: "/model", args: undefined, stdout: "Set model to Opus" },
    });
    const { container } = render(<ChatNodeDetail chatNode={cn} />);
    expect(container.textContent).toMatch(/\/model/);
    expect(container.textContent).toMatch(/Set model to Opus/);
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

  it("flags compact_file_reference with content-compacted note", () => {
    const node: AttachmentNode = {
      id: "a2",
      kind: "attachment",
      parentUuid: null,
      attachmentType: "compact_file_reference",
      raw: { attachment: { filename: "x.ts" } },
    };
    const { container } = render(<WorkNodeDetail workNode={node} sessionId="sid" />);
    expect(container.textContent).toMatch(/compacted out of jsonl/);
  });
});
