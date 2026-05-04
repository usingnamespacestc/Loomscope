// DrillPanel render contract — verifies the v0.6 redo viewMode union
// (chatflow / workflow / sub-chatflow) routes to the correct
// ChatNode-/WorkNode-detail component.
//
// The real ChatNodeDetail / WorkNodeDetail rendering paths are covered
// by details.test.tsx; here we just assert the dispatch + scope plumbing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DrillPanel } from "@/components/drill/DrillPanel";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode } from "@/data/types";

const SID = "11111111-1111-4000-8000-000000000aaa";

function chatNode(id: string): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: `hello from ${id}`, attachments: [] },
    workflow: { nodes: [], edges: [] },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function chatFlow(id: string, nodes: ChatNode[]): ChatFlow {
  return {
    id,
    mainJsonlPath: `/tmp/${id}.jsonl`,
    sidecarDir: `/tmp/${id}`,
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

beforeEach(() => {
  useStore.setState((s) => ({
    sessions: new Map(s.sessions).set(SID, {
      chatFlow: null,
      foldedNodeIds: new Set<string>(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      isLoading: false,
      error: null,
      lastUpdated: 0,
    }),
    activeSessionId: SID,
    drillPanelCollapsed: false,
    // v0.8 M3: explicit reset so the persisted localStorage value
    // doesn't leak across tests in jsdom.
    drillPanelTab: "detail",
  }));
});

afterEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

describe("DrillPanel viewMode dispatch", () => {
  it("chatflow mode + selected ChatNode → renders ChatNodeDetail", () => {
    const cf = chatFlow(SID, [chatNode("p1"), chatNode("p2")]);
    useStore.setState((s) => ({
      sessions: new Map(s.sessions).set(SID, {
        ...s.sessions.get(SID)!,
        chatFlow: cf,
        selectedNodeId: "p2",
      }),
    }));
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    const detail = screen.getByTestId("chat-node-detail");
    expect(detail).toBeTruthy();
    // ID surfaced in the detail header — confirms chatFlow scope used.
    expect(detail.textContent).toContain("p2");
  });

  it("sub-chatflow mode resolves selectedChatId against the SUB ChatFlow scope", () => {
    // Top-level scope holds p1 only; the sub-agent ChatFlow holds
    // sub-p1. With selectedChatId='sub-p1', DrillPanel must look up
    // against the sub-agent ChatFlow (passed as ``chatFlow`` prop) —
    // not the top-level one.
    const top = chatFlow(SID, [chatNode("p1")]);
    const sub = chatFlow("agent_xyz", [chatNode("sub-p1"), chatNode("sub-p2")]);
    useStore.setState((s) => ({
      sessions: new Map(s.sessions).set(SID, {
        ...s.sessions.get(SID)!,
        chatFlow: top,
        selectedNodeId: "sub-p1",
      }),
    }));
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={sub}
        viewMode="sub-chatflow"
        drilledChatNode={null}
      />,
    );
    const detail = screen.getByTestId("chat-node-detail");
    expect(detail.textContent).toContain("sub-p1");
  });

  it("workflow mode without a selected WorkNode → empty hint", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="workflow"
        drilledChatNode={cf.chatNodes[0]}
      />,
    );
    expect(screen.queryByTestId("chat-node-detail")).toBeNull();
    expect(screen.queryByTestId("work-node-detail")).toBeNull();
    // Hint string surfaces from EmptyHint.
    expect(screen.getByText(/点 WorkNode 查看详情/)).toBeTruthy();
  });
});

describe("DrillPanel 2-tab strip (v0.8 M3)", () => {
  it("renders both tab buttons with the active one marked", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    const detailTab = screen.getByTestId("drill-panel-tab-detail");
    const convTab = screen.getByTestId("drill-panel-tab-conversation");
    expect(detailTab).toBeTruthy();
    expect(convTab).toBeTruthy();
    expect(detailTab.dataset.active).toBe("true");
    expect(convTab.dataset.active).toBe("false");
  });

  it("clicking Conversation tab swaps the body to ConversationView + flips active marker", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    useStore.setState((s) => ({
      sessions: new Map(s.sessions).set(SID, {
        ...s.sessions.get(SID)!,
        chatFlow: cf,
        selectedNodeId: "p1",
      }),
    }));
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    // Default Detail tab — ChatNodeDetail visible.
    expect(screen.getByTestId("chat-node-detail")).toBeTruthy();
    // Switch to Conversation tab.
    fireEvent.click(screen.getByTestId("drill-panel-tab-conversation"));
    expect(useStore.getState().drillPanelTab).toBe("conversation");
    expect(screen.queryByTestId("chat-node-detail")).toBeNull();
    expect(screen.getByTestId("conversation-view")).toBeTruthy();
    expect(
      screen.getByTestId("drill-panel-tab-conversation").dataset.active,
    ).toBe("true");
  });

  it("hard constraint #11: Detail tab content matches v0.7 1:1 (chatflow + selected → ChatNodeDetail)", () => {
    // This is the regression guard. If a future M3 follow-up changes
    // anything inside ChatNodeDetail / WorkNodeDetail by accident,
    // this test (and details.test.tsx) catches it.
    const cf = chatFlow(SID, [chatNode("p1"), chatNode("p2")]);
    useStore.setState((s) => ({
      sessions: new Map(s.sessions).set(SID, {
        ...s.sessions.get(SID)!,
        chatFlow: cf,
        selectedNodeId: "p2",
      }),
    }));
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    // Same assertion as the v0.6/v0.7 dispatch test — proves Detail
    // tab is still the same code path.
    const detail = screen.getByTestId("chat-node-detail");
    expect(detail.textContent).toContain("p2");
  });
});
