// Smoke render tests for each WorkNode card. Cards are React Flow node
// components — their NodeProps shape demands a Node-shaped object, but
// since the cards only read ``id`` + ``data`` (selected now subscribes
// mock props rather than going through ReactFlow's node lifecycle.
//
// Goal: verify the per-kind chrome renders the data the visual spec
// promises — testid, label, badge presence — without depending on
// React Flow's measurement loop. Layout / handle interaction is
// covered by layoutWorkflow.test.ts + the e2e probe.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ReactNode } from "react";

import { AttachmentCard } from "./AttachmentCard";
import { CompactCard } from "./CompactCard";
import { DelegateCard } from "./DelegateCard";
import { LlmCallCard } from "./LlmCallCard";
import { ToolCallCard } from "./ToolCallCard";

// React Flow's <Handle> components require a ReactFlowProvider in the
// tree, so each card render wraps in one. They also require a
// ``parentId`` lookup but tolerate the empty default when no nodes are
// registered — which is the case here.
function withRF(node: ReactNode) {
  return <ReactFlowProvider>{node}</ReactFlowProvider>;
}

// Minimal NodeProps shim — the cards only access id + data (selection
// reads from the store via useIsWorkNodeSelected, default false here
// since no activeSessionId is set), but React Flow's type demands the
// full prop set. Cast at the call site is contained here so each test
// stays readable.
function nodeProps<D extends Record<string, unknown>>(
  type: string,
  id: string,
  data: D,
  hasIncomingEdge = false,
  hasOutgoingEdge = false,
) {
  return {
    id,
    type,
    data: { ...data, hasIncomingEdge, hasOutgoingEdge },
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
     
  } as any;
}

describe("LlmCallCard", () => {
  it("renders text preview + thinking line count + model badge", () => {
    render(
      withRF(
        <LlmCallCard
          {...nodeProps("llm_call", "l1", {
            workNode: {
              id: "l1",
              kind: "llm_call",
              parentUuid: null,
              text: "the answer is 42",
              thinking: [{ text: "let me think\nabout this" }],
              model: "claude-opus-4-7",
              usage: {
                input_tokens: 1200,
                output_tokens: 350,
                cache_read_input_tokens: 8000,
                cache_creation_input_tokens: 400,
              },
            },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("worknode-llm_call-l1")).toBeTruthy();
    expect(screen.getByText("the answer is 42")).toBeTruthy();
    expect(screen.getByText(/2 lines/)).toBeTruthy();
    expect(screen.getByText("claude-opus-4-7")).toBeTruthy();
    // PR 2.3: TokenBar = cumulative input (input + cache_read +
    // cache_creation) = 1200 + 8000 + 400 = 9600 → "9.6k" format.
    // Output tokens are NO LONGER included in the bar; they sit on
    // the per-call detail (LlmCallDetail) instead.
    expect(screen.getByTestId("node-id-l1")).toBeTruthy();
    expect(screen.getByText(/9\.6k/i)).toBeTruthy();
  });

  it("renders empty-text placeholder when text is empty", () => {
    render(
      withRF(
        <LlmCallCard
          {...nodeProps("llm_call", "l2", {
            workNode: {
              id: "l2",
              kind: "llm_call",
              parentUuid: null,
              text: "",
              thinking: [],
            },
          })}
        />,
      ),
    );
    expect(screen.getByText(/无文本输出/)).toBeTruthy();
  });

  it("v0.6 redo M4: omits TokenBar when usage is missing", () => {
    render(
      withRF(
        <LlmCallCard
          {...nodeProps("llm_call", "l3", {
            workNode: {
              id: "l3",
              kind: "llm_call",
              parentUuid: null,
              text: "no usage",
              thinking: [],
            },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("node-id-l3")).toBeTruthy();
    // No percent tick = no TokenBar drawn.
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });
});

describe("ToolCallCard", () => {
  it("renders tool name + input lines + result preview + NodeIdLine (no TokenBar)", () => {
    render(
      withRF(
        <ToolCallCard
          {...nodeProps("tool_call", "t1", {
            workNode: {
              id: "t1",
              kind: "tool_call",
              parentUuid: "l1",
              toolName: "Glob",
              input: { pattern: "**/*.tsx", path: "/src" },
              resultBlock: { content: "5 paths returned\n..." },
            },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("worknode-tool_call-t1")).toBeTruthy();
    expect(screen.getByText("Glob")).toBeTruthy();
    expect(screen.getByText(/pattern: \*\*\/\*\.tsx/)).toBeTruthy();
    expect(screen.getByText(/5 paths returned/)).toBeTruthy();
    // v0.6 redo M4: NodeIdLine present, TokenBar deliberately omitted
    // (tool_call doesn't carry model attribution).
    expect(screen.getByTestId("node-id-t1")).toBeTruthy();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  it("shows ✗ marker and rose chrome when isError is true", () => {
    render(
      withRF(
        <ToolCallCard
          {...nodeProps("tool_call", "t-err", {
            workNode: {
              id: "t-err",
              kind: "tool_call",
              parentUuid: null,
              toolName: "Bash",
              input: {},
              isError: true,
            },
          })}
        />,
      ),
    );
    const card = screen.getByTestId("worknode-tool_call-t-err");
    // ✗ marker (in title attribute) + rose accent class on the card.
    expect(card.querySelector('[title="failed"]')).toBeTruthy();
    expect(card.className).toMatch(/rose/);
  });
});

describe("DelegateCard", () => {
  it("renders agentType badge + description + stats + content head", () => {
    render(
      withRF(
        <DelegateCard
          {...nodeProps("delegate", "d1", {
            workNode: {
              id: "d1",
              kind: "delegate",
              parentUuid: null,
              toolName: "Agent",
              agentType: "Explore",
              agentId: "abc_def_123",
              description: "Map the backend",
              content: "Found 3 services",
              totalDurationMs: 50_000,
              totalTokens: 49_560,
              totalToolUseCount: 21,
            },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("worknode-delegate-d1")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByText("Map the backend")).toBeTruthy();
    expect(screen.getByText(/Found 3 services/)).toBeTruthy();
    // Stats include duration / tokens / tool count as adjacent chips.
    expect(screen.getByText(/50\.0s/)).toBeTruthy();
    // 49.6k appears in the stats chip; the TokenBar formatter (formatTokensKM)
    // emits 49.6k too, so getAllByText keeps the assertion non-ambiguous.
    expect(screen.getAllByText(/49\.6k/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/🔧 21/)).toBeTruthy();
    // v0.9.1: drill affordance is now an explicit button (replaced
    // the v0.5 double-click + the briefly-tried right-click — both
    // were eaten by RF / browser defaults).
    // PR 2-D + i18n round: copy unified to "进入子对话流" (sub-agent's
    // inner shape is a ChatFlow not a WorkFlow).
    expect(screen.getByText(/进入子对话流/)).toBeTruthy();
    // v0.6 redo M4: TokenBar (totalTokens=49560) + NodeIdLine present.
    expect(screen.getByTestId("node-id-d1")).toBeTruthy();
  });

  it("v0.5: shows the auto-compact badge when agentId starts with acompact-", () => {
    render(
      withRF(
        <DelegateCard
          {...nodeProps("delegate", "d-ac", {
            workNode: {
              id: "d-ac",
              kind: "delegate",
              parentUuid: null,
              toolName: "Agent",
              // Some old sessions report an unrelated agentType here;
              // the prefix on agentId is the canonical auto-compact signal.
              agentType: "general-purpose",
              agentId: "acompact-deadbeef",
            },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("auto-compact-badge")).toBeTruthy();
    // Regular agentType chip suppressed when auto-compact badge wins.
    expect(screen.queryByText("general-purpose")).toBeNull();
    const card = screen.getByTestId("worknode-delegate-d-ac");
    expect(card.dataset.autoCompact).toBe("true");
  });

  it("v0.5: hides the drill affordance when agentId is missing", () => {
    render(
      withRF(
        <DelegateCard
          {...nodeProps("delegate", "d-noagent", {
            workNode: {
              id: "d-noagent",
              kind: "delegate",
              parentUuid: null,
              toolName: "Agent",
              agentType: "Explore",
              // no agentId — sidecar can't be located, so the hint
              // would mislead the user.
            },
          })}
        />,
      ),
    );
    expect(screen.queryByText(/进入子工作流/)).toBeNull();
  });
});

describe("CompactCard", () => {
  it("auto trigger uses teal chrome + 🤖 auto badge + TokenBar", () => {
    render(
      withRF(
        <CompactCard
          {...nodeProps("compact", "c1", {
            workNode: {
              id: "c1",
              kind: "compact",
              parentUuid: null,
              trigger: "auto",
              preTokens: 92_300,
              summaryText: "previous discussion summarized",
            },
          })}
        />,
      ),
    );
    const card = screen.getByTestId("worknode-compact-c1");
    expect(card.dataset.compactTrigger).toBe("auto");
    expect(card.className).toMatch(/teal/);
    expect(card.className).toMatch(/dashed/);
    expect(screen.getByText(/auto/i)).toBeTruthy();
    // Token formatting in stats chip: 92300 → "92K"
    expect(screen.getByText(/92K/)).toBeTruthy();
    // v0.6 redo M4: TokenBar (preTokens) + NodeIdLine present.
    expect(screen.getByTestId("node-id-c1")).toBeTruthy();
  });

  it("manual trigger uses purple chrome + ✎ manual badge", () => {
    render(
      withRF(
        <CompactCard
          {...nodeProps("compact", "c2", {
            workNode: {
              id: "c2",
              kind: "compact",
              parentUuid: null,
              trigger: "manual",
              summaryText: "...",
            },
          })}
        />,
      ),
    );
    const card = screen.getByTestId("worknode-compact-c2");
    expect(card.className).toMatch(/purple/);
    expect(screen.getByText(/manual/i)).toBeTruthy();
  });
});

describe("AttachmentCard", () => {
  it("file attachment shows 📄 + filename + NodeIdLine (no TokenBar)", () => {
    render(
      withRF(
        <AttachmentCard
          {...nodeProps("attachment", "a1", {
            workNode: {
              id: "a1",
              kind: "attachment",
              parentUuid: null,
              attachmentType: "file",
              raw: { attachment: { filename: "src/App.tsx" } },
            },
          })}
        />,
      ),
    );
    expect(screen.getByTestId("worknode-attachment-a1")).toBeTruthy();
    expect(screen.getByText("src/App.tsx")).toBeTruthy();
    expect(screen.getByText("file")).toBeTruthy();
    // v0.6 redo M4: NodeIdLine present, TokenBar deliberately omitted.
    expect(screen.getByTestId("node-id-a1")).toBeTruthy();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  it("compact_file_reference adds ⊠ marker indicating original content is gone", () => {
    render(
      withRF(
        <AttachmentCard
          {...nodeProps("attachment", "a2", {
            workNode: {
              id: "a2",
              kind: "attachment",
              parentUuid: null,
              attachmentType: "compact_file_reference",
              raw: { attachment: { filename: "lib/big.ts" } },
            },
          })}
        />,
      ),
    );
    expect(screen.getByText(/content compacted/i)).toBeTruthy();
  });
});
