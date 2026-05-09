// DrillPanel render contract — verifies the v0.6 redo viewMode union
// (chatflow / workflow / sub-chatflow) routes to the correct
// ChatNode-/WorkNode-detail component.
//
// The real ChatNodeDetail / WorkNodeDetail rendering paths are covered
// by details.test.tsx; here we just assert the dispatch + scope plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DrillPanel } from "@/components/drill/DrillPanel";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode } from "@/data/types";

// happy-dom resolves relative-URL fetches against http://localhost:3000
// by default, which has no listener in tests → ECONNREFUSED. Several
// slices the panel touches (gitFilesSlice → /api/sessions/:id/git/
// commits-files, possibly more) fire-and-forget fetches in useEffects,
// so the rejection lands as an "unhandled promise rejection" outside
// any specific test body — vitest counts it as the file failing even
// though every individual `it(...)` passes. Stub global.fetch with an
// empty-OK response so all those flush quietly. Tests that need a
// specific response wire their own mock per-call (none currently do).
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    // Sensible default: empty-shaped OK JSON. Slices that read specific
    // fields fall back to defaults when the field's missing.
    if (url.includes("/git/commits-files")) {
      return new Response(JSON.stringify({ commits: [], files: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

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
  vi.restoreAllMocks();
});

describe("DrillPanel viewMode dispatch", () => {
  it("chatflow mode + selected ChatNode → Detail tab renders ChatNodeDetail", async () => {
    // v0.10 polish: chatflow mode auto-defaults to Conversation tab,
    // so click Detail tab first. ChatNodeDetail / ConversationView are
    // lazy-loaded via React.lazy (#6B), so use findByTestId to await
    // the chunk fetch + render.
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
    const detail = await screen.findByTestId("chat-node-detail");
    expect(detail.textContent).toContain("p2");
  });

  it("sub-chatflow mode resolves selectedChatId against the SUB ChatFlow scope (Detail tab)", async () => {
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
    const detail = await screen.findByTestId("chat-node-detail");
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

  it("clicking Detail tab in chatflow mode swaps the body to ChatNodeDetail + flips active marker", async () => {
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
    // Default Conversation tab — wait for the lazy chunk to load.
    // v0.11: EffectiveContextView also renders a ConversationView
    // inside its own tab body, so two `conversation-view` elements
    // exist once both lazy chunks resolve. Wait via findAll then
    // assert at least one is present (we don't care which order
    // they appear).
    await screen.findAllByTestId("conversation-view");
    // Switch to Detail tab.
    fireEvent.click(screen.getByTestId("drill-panel-tab-detail"));
    expect(useStore.getState().drillPanelTab).toBe("detail");
    // v0.10 perf: both tab contents stay mounted (avoid 5s remount
    // markdown re-parse spike). Inactive tab's container has
    // display:none. Verify DOM existence + display style instead of
    // asserting unmounted.
    const detailEl = await screen.findByTestId("chat-node-detail");
    expect(detailEl).toBeTruthy();
    expect(
      screen.getByTestId("drill-panel-body-detail").style.display,
    ).toBe("block");
    expect(
      screen.getByTestId("drill-panel-body-conversation").style.display,
    ).toBe("none");
    expect(
      screen.getByTestId("drill-panel-tab-detail").dataset.active,
    ).toBe("true");
  });

  it("hard constraint #11: Detail tab content matches v0.7 1:1 (chatflow + selected → ChatNodeDetail)", async () => {
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
    const detail = await screen.findByTestId("chat-node-detail");
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
