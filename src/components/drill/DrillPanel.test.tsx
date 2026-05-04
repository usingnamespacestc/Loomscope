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
      foldedCompactIds: new Set<string>(),
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
  it("chatflow mode + selected ChatNode → Detail tab renders ChatNodeDetail", () => {
    // v0.10 polish: chatflow mode auto-defaults to Conversation tab,
    // so click Detail tab first to exercise the ChatNodeDetail dispatch.
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
    fireEvent.click(screen.getByTestId("drill-panel-tab-detail"));
    const detail = screen.getByTestId("chat-node-detail");
    expect(detail).toBeTruthy();
    expect(detail.textContent).toContain("p2");
  });

  it("sub-chatflow mode resolves selectedChatId against the SUB ChatFlow scope (Detail tab)", () => {
    // sub-chatflow auto-defaults to Conversation, so click Detail first.
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
    fireEvent.click(screen.getByTestId("drill-panel-tab-detail"));
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
  it("chatflow mode auto-defaults to Conversation tab (v0.10 polish)", () => {
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
    expect(detailTab.dataset.active).toBe("false");
    expect(convTab.dataset.active).toBe("true");
  });

  it("workflow mode auto-defaults to Detail tab (v0.10 polish)", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="workflow"
        drilledChatNode={cf.chatNodes[0]}
      />,
    );
    const detailTab = screen.getByTestId("drill-panel-tab-detail");
    const convTab = screen.getByTestId("drill-panel-tab-conversation");
    expect(detailTab.dataset.active).toBe("true");
    expect(convTab.dataset.active).toBe("false");
  });

  it("clicking Detail tab in chatflow mode swaps the body to ChatNodeDetail + flips active marker", () => {
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
    // Default Conversation tab — ConversationView visible.
    expect(screen.getByTestId("conversation-view")).toBeTruthy();
    // Switch to Detail tab.
    fireEvent.click(screen.getByTestId("drill-panel-tab-detail"));
    expect(useStore.getState().drillPanelTab).toBe("detail");
    expect(screen.queryByTestId("conversation-view")).toBeNull();
    expect(screen.getByTestId("chat-node-detail")).toBeTruthy();
    expect(
      screen.getByTestId("drill-panel-tab-detail").dataset.active,
    ).toBe("true");
  });

  it("hard constraint #11: Detail tab content matches v0.7 1:1 (chatflow + selected → ChatNodeDetail)", () => {
    // Regression guard for ChatNodeDetail rendering. Click Detail tab
    // first since v0.10 auto-defaults to Conversation in chatflow mode.
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
    fireEvent.click(screen.getByTestId("drill-panel-tab-detail"));
    const detail = screen.getByTestId("chat-node-detail");
    expect(detail.textContent).toContain("p2");
  });
});

describe("DrillPanel TabStrip (v0.8.1 #1: collapse + breadcrumb folded into tabs)", () => {
  it("does NOT render the v0.8 'DETAIL' header text — that was redundant with the tab labels", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    const { container } = render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    // The literal "DETAIL" uppercase header from v0.8 M3 is gone.
    // Tab labels "Detail" / "Conversation" are the new chrome.
    expect(container.textContent).not.toMatch(/DETAIL/);
  });

  it("collapse button moved into the tab strip (right-aligned)", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    const tabs = screen.getByTestId("drill-panel-tabs");
    const collapse = screen.getByTestId("drill-panel-collapse");
    expect(tabs.contains(collapse)).toBe(true);
  });

  it("workflow-mode breadcrumb moved into the tab strip", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="workflow"
        drilledChatNode={cf.chatNodes[0]}
      />,
    );
    const tabs = screen.getByTestId("drill-panel-tabs");
    const breadcrumb = screen.getByTestId("drill-panel-breadcrumb");
    expect(tabs.contains(breadcrumb)).toBe(true);
    expect(breadcrumb.textContent).toContain("p1".slice(0, 8));
  });

  it("clicking the moved collapse button still toggles the panel", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    expect(useStore.getState().drillPanelCollapsed).toBe(false);
    fireEvent.click(screen.getByTestId("drill-panel-collapse"));
    expect(useStore.getState().drillPanelCollapsed).toBe(true);
  });
});

describe("DrillPanel fullscreen toggle (v0.8.1 #7)", () => {
  it("renders the fullscreen button in tab strip with default data-active=false", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    const btn = screen.getByTestId("drill-panel-fullscreen");
    expect(btn).toBeTruthy();
    expect(btn.dataset.active).toBe("false");
    expect(btn.title).toMatch(/Maximize/);
  });

  it("clicking fullscreen button enters fullscreen + flips title + sets aside data-fullscreen=true", () => {
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    fireEvent.click(screen.getByTestId("drill-panel-fullscreen"));
    expect(useStore.getState().drillPanelFullscreen).toBe(true);
    const aside = screen.getByTestId("drill-panel");
    expect(aside.dataset.fullscreen).toBe("true");
    expect(screen.getByTestId("drill-panel-fullscreen").title).toMatch(/Restore/);
  });

  it("fullscreen mode hides the resize handle", () => {
    useStore.setState({ drillPanelFullscreen: true });
    const cf = chatFlow(SID, [chatNode("p1")]);
    render(
      <DrillPanel
        sessionId={SID}
        chatFlow={cf}
        viewMode="chatflow"
        drilledChatNode={null}
      />,
    );
    expect(screen.queryByTestId("drill-panel-resize")).toBeNull();
  });
});
