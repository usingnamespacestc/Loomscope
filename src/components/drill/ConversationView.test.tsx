// v0.8 M4 — ConversationView render + branchMemory + selection sync.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CanvasPanContext, type PanToChatNodeFn } from "@/canvas/CanvasPanContext";
import { ConversationView } from "@/components/drill/ConversationView";
import { packStartIdx } from "@/components/drill/conversationHelpers";
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

  it("v0.8.1 #12: selecting a fork node still marks the latest-child chip active (path walks forward)", () => {
    // Pre-#12 selecting the fork left both chips inactive because the
    // path truncated at the fork. v0.8.1 #12 walks to leaf so the
    // latest-child chip is the chosen branch.
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b", "msg1", "rep1", "2026-04-10T00:00:03.000Z"),
      cn("c2", "b", "msg2", "rep2", "2026-04-10T00:00:04.000Z"),
    ]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.getByTestId("branch-selector-b")).toBeTruthy();
    expect(screen.getByTestId("branch-option-c1").dataset.active).toBe("false");
    expect(screen.getByTestId("branch-option-c2").dataset.active).toBe("true");
  });
});

describe("ConversationView — v0.8.1 #12 selection dimming (no truncation)", () => {
  it("renders messages past selection but marks them data-dimmed=true", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b"), cn("d", "c")]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    // All 4 bubbles render (path went through to the leaf).
    expect(screen.getByTestId("conversation-bubble-a")).toBeTruthy();
    expect(screen.getByTestId("conversation-bubble-b")).toBeTruthy();
    expect(screen.getByTestId("conversation-bubble-c")).toBeTruthy();
    expect(screen.getByTestId("conversation-bubble-d")).toBeTruthy();
    // a + b are at-or-before selection (idx 0, 1) → not dimmed.
    expect(screen.getByTestId("conversation-bubble-a").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-b").dataset.dimmed).toBe("false");
    // c + d are after selection → dimmed.
    expect(screen.getByTestId("conversation-bubble-c").dataset.dimmed).toBe("true");
    expect(screen.getByTestId("conversation-bubble-d").dataset.dimmed).toBe("true");
  });

  it("clicking a dimmed message updates selection so the dim range collapses to its tail", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b"), cn("d", "c")]);
    seed(cf, "a");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    // Click the dimmed `c` bubble.
    fireEvent.click(screen.getByTestId("conversation-bubble-c"));
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("c");
    // a + b + c are now at-or-before selection; only d dims.
    expect(screen.getByTestId("conversation-bubble-a").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-c").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-d").dataset.dimmed).toBe("true");
  });

  it("selectedId at leaf → no message dims (selectedIndex = path.length-1)", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "c");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.getByTestId("conversation-bubble-a").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-b").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-c").dataset.dimmed).toBe("false");
  });
});

describe("ConversationView — v0.8.1 #3 scroll-to-bottom", () => {
  it("calls scrollIntoView on the bottom marker on mount", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    const cf = flow([cn("a", null), cn("b", "a")]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(spy).toHaveBeenCalled();
  });

  it("re-scrolls to bottom when selection changes from outside (canvas click)", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "a");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    spy.mockClear();
    // Simulate external (non-bubble-click) selection change: hit the
    // store directly, just like canvas onNodeClick does. Wrap in
    // act() so React flushes the resulting effect synchronously.
    act(() => {
      useStore.getState().setSelected(SID, "b");
    });
    expect(spy).toHaveBeenCalled();
  });

  it("clicking a bubble inside ConversationView does NOT trigger a scroll-to-bottom", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "c");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    spy.mockClear();
    fireEvent.click(screen.getByTestId("conversation-bubble-a"));
    // Selection updated to "a" but scroll was suppressed.
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("a");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("packStartIdx — v0.8.1 #4 token-budget lazy pack", () => {
  function mkChatNode(id: string, charCount: number) {
    const text = "x".repeat(charCount);
    return {
      kind: "chat" as const,
      id,
      parentChatNodeId: null,
      rootUserUuid: `u-${id}`,
      userMessage: { uuid: `u-${id}`, content: text, attachments: [] },
      workflow: {
        nodes: [
          {
            id: `l-${id}`,
            kind: "llm_call" as const,
            parentUuid: null,
            text: "",
            thinking: [],
          },
        ],
        edges: [],
      },
      trigger: "user" as const,
      isCompactSummary: false,
      meta: {},
    };
  }

  it("packs back from endIdx until budget would be exceeded; always includes at least one ChatNode", () => {
    // 5 ChatNodes × 4000 chars = 1000 tokens each.
    const ids = ["a", "b", "c", "d", "e"];
    const byId = new Map(ids.map((id) => [id, mkChatNode(id, 4000)]));
    // budget = 2500 → fits 2 ChatNodes (2000 tokens) but not 3 (3000).
    expect(packStartIdx(ids, byId, ids.length, 2500)).toBe(3);
  });

  it("oversized leaf still renders (always include at least one)", () => {
    const ids = ["a", "b"];
    const byId = new Map([
      ["a", mkChatNode("a", 4000)],
      ["b", mkChatNode("b", 1_000_000)], // 250K tokens — way over budget
    ]);
    // Even though `b` busts the budget, include it (oversized-leaf
    // guarantee) and stop expanding upward.
    expect(packStartIdx(ids, byId, ids.length, 50_000)).toBe(1);
  });

  it("returns 0 when full path fits inside budget", () => {
    const ids = ["a", "b", "c"];
    const byId = new Map(ids.map((id) => [id, mkChatNode(id, 100)]));
    expect(packStartIdx(ids, byId, ids.length, 50_000)).toBe(0);
  });
});

describe("ConversationView — v0.8.1 #4 lazy slice render", () => {
  it("hides 'load more' hint when path fits inside the initial budget", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "c");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.queryByTestId("conversation-load-more")).toBeNull();
    // All bubbles still render.
    expect(screen.getByTestId("conversation-bubble-a")).toBeTruthy();
    expect(screen.getByTestId("conversation-bubble-c")).toBeTruthy();
  });
});

describe("ConversationView — v0.8.1 #5 hover-to-pan dwell", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderWithPan(panFn: (id: string) => void, cf: ChatFlow, selectedId: string) {
    seed(cf, selectedId);
    const ref = { current: panFn as ((id: string) => void) | null };
    return render(
      <CanvasPanContext.Provider value={{ ref }}>
        <ConversationView sessionId={SID} chatFlow={cf} />
      </CanvasPanContext.Provider>,
    );
  }

  it("calls panToChatNode after 250ms dwell on a bubble", () => {
    const panSpy = vi.fn();
    const cf = flow([cn("a", null), cn("b", "a")]);
    renderWithPan(panSpy, cf, "b");
    fireEvent.mouseEnter(screen.getByTestId("conversation-bubble-a"));
    // Not yet — under threshold.
    vi.advanceTimersByTime(200);
    expect(panSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    // v0.9.1 polish: hover passes mode="hover" so the pan can be
    // released on mouseLeave (transient preview). Click uses "click"
    // for persistent semantics.
    expect(panSpy).toHaveBeenCalledWith("a", "hover");
  });

  it("mouseleave before 250ms cancels the pending pan", () => {
    const panSpy = vi.fn();
    const cf = flow([cn("a", null), cn("b", "a")]);
    renderWithPan(panSpy, cf, "b");
    const bubble = screen.getByTestId("conversation-bubble-a");
    fireEvent.mouseEnter(bubble);
    vi.advanceTimersByTime(100);
    fireEvent.mouseLeave(bubble);
    vi.advanceTimersByTime(500);
    expect(panSpy).not.toHaveBeenCalled();
  });

  it("mouseenter on another bubble before 250ms restarts the timer for the new target", () => {
    const panSpy = vi.fn();
    const cf = flow([cn("a", null), cn("b", "a")]);
    renderWithPan(panSpy, cf, "b");
    fireEvent.mouseEnter(screen.getByTestId("conversation-bubble-a"));
    vi.advanceTimersByTime(100);
    fireEvent.mouseLeave(screen.getByTestId("conversation-bubble-a"));
    fireEvent.mouseEnter(screen.getByTestId("conversation-bubble-b"));
    vi.advanceTimersByTime(260);
    // Only "b" fires — "a" was cancelled.
    expect(panSpy).toHaveBeenCalledTimes(1);
    expect(panSpy).toHaveBeenCalledWith("b", "hover");
  });
});

describe("ConversationView — v0.8.1 #11 copy buttons", () => {
  it("renders user + assistant copy buttons per bubble", () => {
    const cf = flow([cn("a", null, "user prompt", "assistant reply")]);
    seed(cf, "a");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.getByTestId("copy-msg-user-a")).toBeTruthy();
    expect(screen.getByTestId("copy-msg-assistant-a")).toBeTruthy();
  });

  it("clicking copy writes the raw markdown source to clipboard + flips icon to ✓", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const cf = flow([cn("a", null, "**bold** prompt", "*italic* reply")]);
    seed(cf, "a");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    const btn = screen.getByTestId("copy-msg-user-a");
    expect(btn.textContent).toMatch(/复制|Copy/);
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("**bold** prompt");
    expect(btn.textContent).toMatch(/✓ 已复制|✓ Copied/);
  });

  it("clicking copy stops propagation so the bubble underneath doesn't re-select", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const cf = flow([cn("a", null), cn("b", "a")]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    fireEvent.click(screen.getByTestId("copy-msg-user-a"));
    // Selection should still be `b`, not `a` — bubble click was suppressed.
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("b");
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

  it("v1.2: pure compact ChatNodes are hidden from Conversation view", () => {
    // Per v1.2 design (handoff-v1.2-summary-spike.md): compact nodes
    // are model-context plumbing, not real conversation content.
    // ConversationView filters out `isCompactSummary && !hasInnerCompact`
    // ChatNodes; their summary is still visible in Effective Context view.
    // This test pins the filter — a session that contains ONLY a pure
    // compact ChatNode should render the empty state.
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
    // The compact summary text must NOT appear (was previously shown
    // as fallback bubble; v1.2 hides pure compacts entirely).
    expect(screen.queryByText("compacted prior段")).toBeNull();
    // Conversation falls back to its empty state since no visible
    // ChatNodes remain on the path.
    expect(screen.getByTestId("conversation-empty")).toBeTruthy();
  });

  it("v1.2: ChatNode with hasInnerCompact still renders (manual /compact mid-turn)", () => {
    // hasInnerCompact = a normal turn that *contains* a compact
    // tool_use (e.g. user typed /compact); these still render so the
    // user can see their manual slash invocation.
    const cf = flow([
      {
        ...cn("a", null, "user prompt", "assistant reply"),
        hasInnerCompact: true,
      },
    ]);
    seed(cf, "a");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    expect(screen.getByText("user prompt")).toBeTruthy();
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

describe("ConversationView — focusLock (workflow drill read-only mode)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderLocked(
    panFn: PanToChatNodeFn | null,
    cf: ChatFlow,
    storeSelectedId: string | null,
    focusLock: string | null,
  ) {
    seed(cf, storeSelectedId);
    const ref = { current: panFn };
    return render(
      <CanvasPanContext.Provider value={{ ref }}>
        <ConversationView sessionId={SID} chatFlow={cf} focusLock={focusLock} />
      </CanvasPanContext.Provider>,
    );
  }

  it("focusLock overrides storeSelectedId for path resolution + dim line", () => {
    // a → b → c → d. store selectedId=a (would normally render only a
    // selected, b/c/d dimmed). focusLock=c → dim line shifts to c (a/b/c
    // not dimmed; d dimmed). Verifies that focusLock wins over store.
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b"), cn("d", "c")]);
    renderLocked(null, cf, "a", "c");
    expect(screen.getByTestId("conversation-bubble-a").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-b").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-c").dataset.dimmed).toBe("false");
    expect(screen.getByTestId("conversation-bubble-d").dataset.dimmed).toBe("true");
    // Selection ring lands on c (the locked focus), not a.
    expect(screen.getByTestId("conversation-bubble-c").dataset.selected).toBe("true");
    expect(screen.getByTestId("conversation-bubble-a").dataset.selected).toBe("false");
  });

  it("clicking a bubble in locked mode does NOT mutate store selectedNodeId", () => {
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    renderLocked(null, cf, "c", "c");
    fireEvent.click(screen.getByTestId("conversation-bubble-a"));
    // Store untouched — locked mode swallows the click.
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("c");
  });

  it("hover dwell in locked mode does NOT fire panToChatNode", () => {
    const panSpy = vi.fn();
    const cf = flow([cn("a", null), cn("b", "a")]);
    renderLocked(panSpy, cf, "b", "b");
    fireEvent.mouseEnter(screen.getByTestId("conversation-bubble-a"));
    vi.advanceTimersByTime(500); // well past 250ms dwell threshold
    expect(panSpy).not.toHaveBeenCalled();
  });

  it("BranchSelector is suppressed in locked mode (would be a no-op control)", () => {
    // a → b (fork) → c1 + c2. Without focusLock branch selector renders;
    // with focusLock it must not.
    const cf = flow([
      cn("a", null),
      cn("b", "a"),
      cn("c1", "b"),
      cn("c2", "b"),
    ]);
    renderLocked(null, cf, "c1", "c1");
    expect(screen.queryByTestId("branch-selector-b")).toBeNull();
  });

  it("locked bubbles carry data-locked=true and cursor-default styling", () => {
    const cf = flow([cn("a", null), cn("b", "a")]);
    renderLocked(null, cf, "b", "b");
    const bubble = screen.getByTestId("conversation-bubble-b");
    expect(bubble.dataset.locked).toBe("true");
    // Tailwind class hint — survives the bubble being read-only.
    expect(bubble.className).toContain("cursor-default");
    expect(bubble.className).not.toContain("cursor-pointer");
  });

  it("non-locked mode still passes data-locked=false and keeps cursor-pointer", () => {
    const cf = flow([cn("a", null), cn("b", "a")]);
    seed(cf, "b");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    const bubble = screen.getByTestId("conversation-bubble-b");
    expect(bubble.dataset.locked).toBe("false");
    expect(bubble.className).toContain("cursor-pointer");
  });

  it("focusLock + drillTab=conversation scrolls bubble with block:'end'", () => {
    // Stub Element.prototype.scrollIntoView so we can inspect args.
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    useStore.setState({ drillPanelTab: "conversation" });
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    renderLocked(null, cf, "a", "b");
    // The selectedId-driven scroll fires on mount with locked=true →
    // block:'end' for the focused bubble. Search for any call that
    // matches block:'end'.
    const endCall = spy.mock.calls.find((args) => {
      const opts = args[0];
      return opts && typeof opts === "object" && opts.block === "end";
    });
    expect(endCall).toBeTruthy();
  });

  it("focusLock + drillTab=detail suppresses scroll (waits for tab flip)", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    useStore.setState({ drillPanelTab: "detail" });
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    renderLocked(null, cf, "a", "b");
    spy.mockClear();
    // Flip the tab — effect re-fires and now scrolls with block:'end'.
    act(() => {
      useStore.setState({ drillPanelTab: "conversation" });
    });
    const endCall = spy.mock.calls.find((args) => {
      const opts = args[0];
      return opts && typeof opts === "object" && opts.block === "end";
    });
    expect(endCall).toBeTruthy();
  });

  it("non-locked mode still scrolls with block:'center' (preserves preview UX)", () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
    useStore.setState({ drillPanelTab: "conversation" });
    const cf = flow([cn("a", null), cn("b", "a"), cn("c", "b")]);
    seed(cf, "a");
    render(<ConversationView sessionId={SID} chatFlow={cf} />);
    spy.mockClear();
    act(() => {
      useStore.getState().setSelected(SID, "b");
    });
    // External selection change triggers scroll with block:'center'.
    const centerCall = spy.mock.calls.find((args) => {
      const opts = args[0];
      return opts && typeof opts === "object" && opts.block === "center";
    });
    expect(centerCall).toBeTruthy();
  });
});
