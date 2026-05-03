// v0.6 M4 — unified NodeCard rendering tests.
//
// One smoke test per kind branch + per-feature checks (slash command,
// auto-compact badge, expand hint, token bar, error markers). The
// render harness shims React Flow's NodeProps so tests don't have to
// mount a real ReactFlow tree.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";

import { NodeCard } from "@/canvas/nodes/NodeCard";
import type { Node, NodeKind } from "@/data/types";

function withRF(n: ReactNode) {
  return <ReactFlowProvider>{n}</ReactFlowProvider>;
}

// React Flow's NodeProps demands the full prop set; only ``id`` +
// ``data`` are read by NodeCard so the rest gets stubbed.
function nodeProps(
  id: string,
  kind: NodeKind,
  node: Partial<Node>,
  flags: Partial<{
    hasIncomingEdge: boolean;
    hasOutgoingEdge: boolean;
    hasFoldedChildren: boolean;
    isOverridden: boolean;
  }> = {},
) {
  const baseNode: Node = {
    id,
    parentId: null,
    kind,
    defaultFolded: true,
    ...node,
  };
  return {
    id,
    type: kind,
    data: {
      node: baseNode,
      hasIncomingEdge: flags.hasIncomingEdge ?? false,
      hasOutgoingEdge: flags.hasOutgoingEdge ?? false,
      hasFoldedChildren: flags.hasFoldedChildren ?? false,
      isOverridden: flags.isOverridden ?? false,
    },
    selected: false,
    dragging: false,
    isConnectable: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    width: 200,
    height: 100,
    sourcePosition: undefined,
    targetPosition: undefined,
    dragHandle: undefined,
    parentId: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("NodeCard — user_message kind", () => {
  it("renders 用户 / 助手 sections + aggregate stats + token bar", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("u1", "user_message", {
            content: "list all tsx files",
            aggregate: {
              assistantPreview: "Found 5 .tsx files.",
              llmCallCount: 2,
              toolCallCount: 1,
              delegateCount: 0,
              attachmentCount: 0,
              thinkingChars: 250,
              contextTokens: 50_000,
              model: "claude-opus-4-7",
            },
            isTurnRoot: true,
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-u1");
    expect(card.dataset.nodeKind).toBe("user_message");
    expect(screen.getByText("list all tsx files")).toBeTruthy();
    expect(screen.getByText("Found 5 .tsx files.")).toBeTruthy();
    // 🧠 2 llm + 🔧 1 tool
    expect(card.textContent).toMatch(/2/);
    expect(card.textContent).toMatch(/1/);
    // Token bar: 50k / 1M opus = 5%
    expect(card.textContent).toMatch(/5%/);
  });

  it("slash-command body shows ⚡ + name + stdout", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("u-slash", "user_message", {
            slashCommand: { name: "/model", args: undefined, stdout: "Set to Opus" },
            isTurnRoot: true,
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-u-slash");
    expect(card.dataset.slash).toBe("true");
    expect(card.textContent).toMatch(/\/model/);
    expect(card.textContent).toMatch(/Set to Opus/);
  });

  it("scheduled-trigger turn root shows ⏰ scheduled badge + amber chrome", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("u-sched", "user_message", {
            trigger: "scheduled",
            isTurnRoot: true,
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-u-sched");
    expect(card.className).toMatch(/amber/);
    expect(card.textContent).toMatch(/scheduled/);
  });

  it("hasFoldedChildren=true renders the 展开工作流 affordance", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps(
            "u-with-children",
            "user_message",
            { isTurnRoot: true },
            { hasFoldedChildren: true },
          )}
        />,
      ),
    );
    expect(screen.getByTestId("expand-u-with-children")).toBeTruthy();
  });
});

describe("NodeCard — assistant_call kind", () => {
  it("renders text preview + thinking line count + model", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("a1", "assistant_call", {
            text: "the answer is 42",
            thinking: [{ text: "let me think\nabout this" }],
            model: "claude-opus-4-7",
          })}
        />,
      ),
    );
    expect(screen.getByTestId("node-a1")).toBeTruthy();
    expect(screen.getByText("the answer is 42")).toBeTruthy();
    expect(screen.getByText(/2 lines/)).toBeTruthy();
    expect(screen.getByText("claude-opus-4-7")).toBeTruthy();
  });

  it("error case shows ✗ + rose accent", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("a-err", "assistant_call", {
            text: "",
            errors: [{ type: "overloaded_error" }],
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-a-err");
    expect(card.className).toMatch(/rose/);
    expect(card.textContent).toMatch(/overloaded_error/);
  });
});

describe("NodeCard — tool_call kind", () => {
  it("renders 🔧 toolName + input lines + result preview", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("t1", "tool_call", {
            toolName: "Glob",
            toolInput: { pattern: "**/*.tsx", path: "/src" },
            toolResultBlock: { content: "5 paths returned\n..." },
          })}
        />,
      ),
    );
    expect(screen.getByText("Glob")).toBeTruthy();
    expect(screen.getByText(/pattern: \*\*\/\*\.tsx/)).toBeTruthy();
    expect(screen.getByText(/5 paths returned/)).toBeTruthy();
  });

  it("isError=true shows ✗ + rose chrome", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("t-err", "tool_call", {
            toolName: "Bash",
            toolInput: {},
            isError: true,
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-t-err");
    expect(card.className).toMatch(/rose/);
    expect(card.querySelector('[title="failed"]')).toBeTruthy();
  });
});

describe("NodeCard — delegate kind", () => {
  it("renders 🤖 + agentType + description + stats + drill hint", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("d1", "delegate", {
            toolName: "Agent",
            agentType: "Explore",
            agentId: "abc_def_123",
            description: "Map the backend",
            delegateContent: "Found 3 services",
            totalDurationMs: 50_000,
            totalTokens: 49_560,
            totalToolUseCount: 21,
          })}
        />,
      ),
    );
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByText("Map the backend")).toBeTruthy();
    expect(screen.getByText(/Found 3 services/)).toBeTruthy();
    expect(screen.getByText(/50\.0s/)).toBeTruthy();
    // formatTokensKM(49560) == "49.6k" (single 'k')
    expect(screen.getByText(/49\.6k/)).toBeTruthy();
    expect(screen.getByText(/🔧 21/)).toBeTruthy();
    expect(screen.getByText(/double-click to drill/)).toBeTruthy();
  });

  it("auto-compact badge fires when agentId starts with acompact-", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("d-ac", "delegate", {
            toolName: "Agent",
            agentType: "general-purpose",
            agentId: "acompact-deadbeef",
          })}
        />,
      ),
    );
    expect(screen.getByTestId("auto-compact-badge")).toBeTruthy();
    // agentType chip suppressed when AC badge shows.
    expect(screen.queryByText("general-purpose")).toBeNull();
  });
});

describe("NodeCard — compact kind", () => {
  it("auto trigger uses teal chrome + 🤖 auto badge + dashed border", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("c1", "compact", {
            compactTrigger: "auto",
            preTokens: 92_300,
            summaryText: "previous discussion summarized",
            isTurnRoot: true,
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-c1");
    expect(card.dataset.compactTrigger).toBe("auto");
    expect(card.className).toMatch(/teal/);
    expect(card.className).toMatch(/dashed/);
    expect(screen.getByText(/auto/i)).toBeTruthy();
  });

  it("manual trigger uses purple chrome + ✎ manual badge", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("c2", "compact", {
            compactTrigger: "manual",
            summaryText: "...",
          })}
        />,
      ),
    );
    const card = screen.getByTestId("node-c2");
    expect(card.className).toMatch(/purple/);
    expect(screen.getByText(/manual/i)).toBeTruthy();
  });
});

describe("NodeCard — attachment kind", () => {
  it("file attachment shows 📄 + filename + type label", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("a-file", "attachment", {
            attachmentType: "file",
            attachmentRaw: { attachment: { filename: "src/App.tsx" } },
          })}
        />,
      ),
    );
    expect(screen.getByText("src/App.tsx")).toBeTruthy();
    expect(screen.getByText("file")).toBeTruthy();
  });

  it("compact_file_reference adds the ⊠ content compacted note", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("a-comp", "attachment", {
            attachmentType: "compact_file_reference",
            attachmentRaw: { attachment: { filename: "lib/big.ts" } },
          })}
        />,
      ),
    );
    expect(screen.getByText(/content compacted/i)).toBeTruthy();
  });
});

describe("NodeCard — id line + handles", () => {
  it("id line renders the node id (click-to-copy chrome from legacy)", () => {
    render(
      withRF(
        <NodeCard
          {...nodeProps("just-an-id", "tool_call", {
            toolName: "Bash",
            toolInput: {},
          })}
        />,
      ),
    );
    expect(screen.getByTestId("node-id-just-an-id")).toBeTruthy();
  });
});
