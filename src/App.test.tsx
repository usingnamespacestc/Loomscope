import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import App from "./App";
import { useStore } from "@/store/index";

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map(),
      sessionsByCwd: new Map(),
      expandedCwds: new Set(),
      pinnedWorkspaces: [],
      hiddenWorkspaces: [],
      focusedWorkspace: null,
      activeSessionId: null,
      workspaces: [],
      workspacesError: null,
      workspacesLoading: false,
      sidebarCollapsed: false,
    },
    false,
  );
  if (typeof localStorage !== "undefined") localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200 })),
  );
  // v0.9 file-tail spike: App opens an EventSource to /api/sessions/:id/
  // events whenever activeSessionId is set. happy-dom's EventSource
  // tries a real network connect (defaulting to localhost:3000),
  // which floods the test output with ECONNREFUSED noise. Stub it
  // out — tests don't exercise live-update paths.
  vi.stubGlobal(
    "EventSource",
    class MockEventSource {
      url: string;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        this.url = url;
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App shell", () => {
  it("renders Header + Sidebar + empty canvas state when no session active", async () => {
    render(<App />);
    // "Loomscope" appears in both the Header and the empty-state title
    // since the v0.10 polish enhanced empty state. getAllByText handles
    // both occurrences; we just verify one of them exists.
    expect(screen.getAllByText("Loomscope").length).toBeGreaterThan(0);
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.getByTestId("canvas-host")).toBeTruthy();
    // Empty-state body text — match on canvas-host textContent so we
    // don't need to know the exact split between spans.
    expect(
      screen.getByTestId("canvas-host").textContent?.replace(/\s+/g, " "),
    ).toMatch(/Claude Code session 可视化阅读器/);
    // Sidebar's effect should fire a refresh.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  it("shows loading state while a session is being fetched", () => {
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      sessions.set("sid", {
        chatFlow: null,
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
      currentTurn: null,
      lastTurnHookAt: 0,
        isLoading: true,
        error: null,
        lastUpdated: 0,
        lastInvalidateAt: 0,
      });
      return { sessions, activeSessionId: "sid" };
    });
    render(<App />);
    expect(screen.getByText(/Parsing JSONL/)).toBeTruthy();
  });

  it("surfaces session error state in the canvas host", () => {
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      sessions.set("sid", {
        chatFlow: null,
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
      currentTurn: null,
      lastTurnHookAt: 0,
        isLoading: false,
        error: "boom",
        lastUpdated: 0,
        lastInvalidateAt: 0,
      });
      return { sessions, activeSessionId: "sid" };
    });
    render(<App />);
    expect(screen.getByText(/Failed to load session/)).toBeTruthy();
    // "boom" appears in both Header (compact) and canvas error state — use
    // getAllByText so multiple matches don't fail the assertion.
    expect(screen.getAllByText("boom").length).toBeGreaterThan(0);
  });
});
