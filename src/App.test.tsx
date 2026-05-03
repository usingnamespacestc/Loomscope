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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App shell", () => {
  it("renders Header + Sidebar + empty canvas state when no session active", async () => {
    render(<App />);
    expect(screen.getByText("Loomscope")).toBeTruthy();
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.getByTestId("canvas-host")).toBeTruthy();
    // Empty-state text is split across nested span (highlight on "sidebar"),
    // so match on the canvas-host textContent rather than getByText (which
    // requires single-element matches).
    expect(
      screen.getByTestId("canvas-host").textContent?.replace(/\s+/g, " "),
    ).toMatch(/Select a session from the sidebar/i);
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
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeId: null,
        workflowSelectedNodeId: null,
        drillStack: [],
        subAgentCache: new Map(),
        isLoading: true,
        error: null,
        lastUpdated: 0,
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
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeId: null,
        workflowSelectedNodeId: null,
        drillStack: [],
        subAgentCache: new Map(),
        isLoading: false,
        error: "boom",
        lastUpdated: 0,
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
