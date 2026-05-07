// v0.10 polish: keyboard navigation hook unit tests.
//
// Pattern: render a tiny harness that mounts useKeyboardNav, seed a
// chatFlow + selectedNodeId in the store, fire window keydown events
// via fireEvent, then read the resulting store state.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";

import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "00000000-0000-4000-8000-00000000000a";

function cn(id: string, parent: string | null): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [] },
    workflow: { nodes: [], edges: [] },
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

function seed(cf: ChatFlow, selectedId: string | null): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow: cf,
      foldedNodeIds: new Set(),
      foldedCompactIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: selectedId,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      workflowCache: new Map(),
      workflowViewports: new Map(),
      pendingPermission: null,
      currentTurn: null,
      lastTurnHookAt: 0,
      isLoading: false,
      error: null,
      lastUpdated: Date.now(),
      lastInvalidateAt: 0,
    });
    return { sessions, activeSessionId: SID };
  });
}

function Harness() {
  useKeyboardNav();
  return <div data-testid="harness" />;
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});
afterEach(() => {
  cleanup();
});

describe("useKeyboardNav", () => {
  // a → b → c → d (linear chain). Time flows left→right on the canvas,
  // so ArrowRight = forward = next, ArrowLeft = backward = prev.
  const linear = () => flow([cn("a", null), cn("b", "a"), cn("c", "b"), cn("d", "c")]);

  it("ArrowRight moves selection forward along the path", () => {
    seed(linear(), "b");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("c");
  });

  it("ArrowLeft moves selection backward along the path", () => {
    seed(linear(), "c");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("b");
  });

  it("ArrowLeft at root is a no-op (idx 0 has no prev)", () => {
    seed(linear(), "a");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("a");
  });

  it("ArrowRight at leaf is a no-op", () => {
    seed(linear(), "d");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("d");
  });

  it("with no selection, ArrowRight at the implicit leaf is a no-op", () => {
    // sel=null → endpoint = latest leaf → no next available
    seed(linear(), null);
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBeNull();
  });

  it("with no selection, ArrowLeft moves from latest leaf to leaf-1", () => {
    seed(linear(), null);
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    // Default endpoint = leaf "d", left → "c"
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("c");
  });

  it("ArrowDown / ArrowUp / j / k are NOT mapped (only horizontal arrows)", () => {
    // LR canvas — vertical-axis keys would feel reversed (j=down ≠ next).
    // Confirm none of them move selection.
    seed(linear(), "b");
    render(<Harness />);
    for (const key of ["ArrowDown", "ArrowUp", "j", "k"]) {
      fireEvent.keyDown(window, { key });
    }
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("b");
  });

  it("Enter from top-level ChatFlow view enters WorkFlow drill", () => {
    seed(linear(), "b");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "Enter" });
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toEqual([{ kind: "chatnode", chatNodeId: "b" }]);
  });

  it("Enter without selection is a no-op", () => {
    seed(linear(), null);
    render(<Harness />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(useStore.getState().sessions.get(SID)?.drillStack).toEqual([]);
  });

  it("Escape pops the drill stack", () => {
    seed(linear(), "b");
    useStore.getState().enterWorkflow(SID, "b");
    expect(useStore.getState().sessions.get(SID)?.drillStack).toHaveLength(1);
    render(<Harness />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().sessions.get(SID)?.drillStack).toEqual([]);
  });

  it("ignores keys when typing in an input", () => {
    seed(linear(), "b");
    render(
      <>
        <input data-testid="input" />
        <Harness />
      </>,
    );
    const input = document.querySelector('[data-testid="input"]') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight", bubbles: true });
    // Selection unchanged
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("b");
  });

  it("ignores keys with modifier (Meta/Ctrl/Alt)", () => {
    seed(linear(), "b");
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    expect(useStore.getState().sessions.get(SID)?.selectedNodeId).toBe("b");
  });

  it("no-op when no active session", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useStore.getState().activeSessionId).toBeNull();
    // Doesn't throw.
  });
});
