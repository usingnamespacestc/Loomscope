// v0.8 M4 — ConversationView render + branchMemory + selection sync.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ConversationView } from "@/components/drill/ConversationView";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "11111111-1111-4000-8000-000000000fff";

function cn(
  id: string,
  parent: string | null,
  userText = `prompt ${id}`,
  assistantText: string | null = `reply ${id}`,
  ts = `2026-04-10T00:00:${id.padStart(2, "0")}.000Z`,
): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: userText, timestamp: ts, attachments: [] },
    workflow: {
      nodes: assistantText
        ? [
            {
              id: `l-${id}`,
              kind: "llm_call",
              parentUuid: null,
              text: assistantText,
              thinking: [],
              model: "claude-opus-4-7",
              usage: { input_tokens: 5, output_tokens: 3 },
            },
          ]
        : [],
      edges: [],
    },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function flow(nodes: ChatNode[]): ChatFlow {
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

function seed(cf: ChatFlow, selectedNodeId: string | null = null): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow: cf,
      foldedNodeIds: new Set(),
      foldedCompactIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      isLoading: false,
      error: null,
      lastUpdated: 0,
    });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

afterEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("ConversationView — root → focused linear path", () => {
  it("renders empty hint when chatFlow is null", () => {
    seed(flow([]));
    render(<ConversationView sessionId={SID} chatFlow={null} />);
    expect(screen.getByTestId("conversation-empty")).toBeTruthy();
  });

  it("renders the resolved path as message bubbles in root → endpoint order", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "c");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    const view = screen.getByTestId("conversation-view");
    const ids = Array.from(view.querySelectorAll("[data-testid^='conversation-bubble-']")).map(
      (el) => el.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "conversation-bubble-a",
      "conversation-bubble-b",
      "conversation-bubble-c",
    ]);
  });

  it("selected ChatNode bubble carries data-selected=true + visible marker class", () => {
    const cf = flow([cn("a", null), cn("b", "a")]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    const a = screen.getByTestId("conversation-bubble-a");
    const b = screen.getByTestId("conversation-bubble-b");
    expect(a.dataset.selected).toBe("false");
    expect(b.dataset.selected).toBe("true");
    expect(b.className).toMatch(/border-blue-400/);
  });

  it("clicking a message bubble fires setSelected (selection sync, design micro-decision 2A)", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "c");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    fireEvent.click(screen.getByTestId("conversation-bubble-a"));
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("a");
  });
});

describe("ConversationView — fork + BranchSelector", () => {
  it("renders BranchSelector at fork points with chips per child + active marker", () => {
    // a → b (fork) → c1, c2; selected c1.
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b", "branch one prompt"),
      cn("c2", "b", "branch two prompt", null, "2026-04-10T00:00:04.000Z"),
    ]);
    seed(cf, "c1");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    const sel = screen.getByTestId("branch-selector-b");
    expect(sel).toBeTruthy();
    const c1 = screen.getByTestId("branch-option-c1");
    const c2 = screen.getByTestId("branch-option-c2");
    expect(c1.dataset.active).toBe("true");
    expect(c2.dataset.active).toBe("false");
    // Preview text is the user prompt (truncated).
    expect(c1.textContent).toContain("branch one prompt");
    expect(c2.textContent).toContain("branch two prompt");
  });

  it("clicking a BranchSelector chip flips selectedNodeId AND records branchMemory[forkChildId] = leaf", () => {
    // a → b (fork) → c1 + c2 → c2 has a deeper child d to verify
    // findLatestLeafInSubtree walks to the leaf, not just to c2.
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b", "first branch"),
      cn("c2", "b", "second branch"),
      cn("d", "c2", "deeper"),
    ]);
    seed(cf, "c1");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    fireEvent.click(screen.getByTestId("branch-option-c2"));
    const state = useStore.getState().sessions.get(SID)!;
    // Selected jumped to leaf of c2's subtree (d), not just c2.
    expect(state.selectedNodeId).toBe("d");
    // branchMemory remembers c2 → d.
    expect(state.branchMemory).toEqual({ c2: "d" });
  });

  it("re-clicking a previously-visited branch uses branchMemory leaf (auto-restore UX)", () => {
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b"),
      cn("c2", "b"),
      cn("d", "c2"),
      cn("e", "d"), // deeper leaf reachable from c2
    ]);
    seed(cf, "c1");
    // Visit c2 → branchMemory[c2] = e (deepest)
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    fireEvent.click(screen.getByTestId("branch-option-c2"));
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("e");
    // Programmatically navigate back to c1.
    useStore.getState().setSelected(SID, "c1");
    expect(useStore.getState().sessions.get(SID)?.branchMemory).toEqual({ c2: "e" });
    // Re-click c2 → memory restores selection to e directly.
    fireEvent.click(screen.getByTestId("branch-option-c2"));
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("e");
  });

  it("fork at the path's terminal node (selected IS the fork) marks no chip active", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c1", "b"), cn("c2", "b")]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.getByTestId("branch-selector-b")).toBeTruthy();
    expect(screen.getByTestId("branch-option-c1").dataset.active).toBe("false");
    expect(screen.getByTestId("branch-option-c2").dataset.active).toBe("false");
  });
});

describe("ConversationView — content rendering", () => {
  it("renders user message text + assistant text via MarkdownView", () => {
    const cf = flow([cn("a", null, "hello **world**", "the **answer** is 42")]);
    seed(cf, "a");
    const { container } = render(
      <ConversationView sessionId={SID} chatFlow={cf} />,
    );
    // Both user + assistant get bold tags via markdown rendering.
    const strongTags = container.querySelectorAll("strong");
    const strongTexts = Array.from(strongTags).map((el) => el.textContent);
    expect(strongTexts).toContain("world");
    expect(strongTexts).toContain("answer");
  });

  it("falls back to compact summaryText when no llm_call exists", () => {
    const cf = flow([
      {
        ...cn("c", null, "[Compact summary]", null),
        isCompactSummary: true,
        compactMetadata: {
          id: "comp",
          kind: "compact",
          parentUuid: null,
          summaryText: "compacted prior段",
          trigger: "auto",
        },
      },
    ]);
    seed(cf, "c");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.getByText("compacted prior段")).toBeTruthy();
  });

  it("MessageMeta surfaces model + token sum when last llm_call has usage", () => {
    const cf = flow([cn("a", null, "hi", "yo")]);
    seed(cf, "a");
    const { container } = render(
      <ConversationView sessionId={SID} chatFlow={cf} />,
    );
    expect(container.textContent).toContain("claude-opus-4-7");
    expect(container.textContent).toMatch(/8 tok/);
  });
});
