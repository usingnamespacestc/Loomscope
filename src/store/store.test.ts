import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "@/store/index";

// Snapshot the initial state once; reset between tests so the singleton
// store stays clean.
const INITIAL = useStore.getState();

beforeEach(() => {
  // Reset to the captured defaults but keep the action references intact
  // — `replace: true` would erase actions, so we shallow-merge.
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
  // Clean localStorage between tests — `persist` writes on every set.
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UI slice", () => {
  it("clamps sidebar width within [180, 600]", () => {
    useStore.getState().setSidebarWidth(50);
    expect(useStore.getState().sidebarWidth).toBe(180);
    useStore.getState().setSidebarWidth(9999);
    expect(useStore.getState().sidebarWidth).toBe(600);
    useStore.getState().setSidebarWidth(320);
    expect(useStore.getState().sidebarWidth).toBe(320);
  });

  it("toggles sidebar collapsed", () => {
    expect(useStore.getState().sidebarCollapsed).toBe(false);
    useStore.getState().toggleSidebar();
    expect(useStore.getState().sidebarCollapsed).toBe(true);
    useStore.getState().toggleSidebar();
    expect(useStore.getState().sidebarCollapsed).toBe(false);
  });

  it("pins and unpins workspaces idempotently", () => {
    useStore.getState().pinWorkspace("/a");
    useStore.getState().pinWorkspace("/a"); // no dup
    useStore.getState().pinWorkspace("/b");
    expect(useStore.getState().pinnedWorkspaces).toEqual(["/a", "/b"]);
    useStore.getState().unpinWorkspace("/a");
    expect(useStore.getState().pinnedWorkspaces).toEqual(["/b"]);
  });

  it("hides and unhides workspaces", () => {
    useStore.getState().hideWorkspace("/x");
    expect(useStore.getState().hiddenWorkspaces).toContain("/x");
    useStore.getState().unhideWorkspace("/x");
    expect(useStore.getState().hiddenWorkspaces).not.toContain("/x");
  });

  it("sets focused workspace", () => {
    useStore.getState().setFocusedWorkspace("/foo");
    expect(useStore.getState().focusedWorkspace).toBe("/foo");
    useStore.getState().setFocusedWorkspace(null);
    expect(useStore.getState().focusedWorkspace).toBe(null);
  });
});

describe("Workspace slice", () => {
  it("refreshWorkspaces populates store on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { cwd: "/foo", sessionCount: 2, lastModified: "2026-05-01T00:00:00Z" },
          ]),
          { status: 200 },
        ),
      ),
    );
    await useStore.getState().refreshWorkspaces();
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(useStore.getState().workspaces[0].cwd).toBe("/foo");
    expect(useStore.getState().workspacesError).toBe(null);
    expect(useStore.getState().workspacesLoading).toBe(false);
  });

  it("refreshWorkspaces records error on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await useStore.getState().refreshWorkspaces();
    expect(useStore.getState().workspacesError).toMatch(/500/);
  });

  it("loadSessions URL-encodes the cwd", async () => {
    const fetchMock = vi.fn(
      async (..._args: unknown[]) => new Response("[]", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await useStore.getState().loadSessions("/home/u/Foo Bar");
    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    const url = calls[0][0];
    expect(url).toContain("%2Fhome%2Fu%2FFoo%20Bar");
  });

  it("toggleExpanded inserts/removes cwd from expanded set", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    useStore.getState().toggleExpanded("/a");
    expect(useStore.getState().expandedCwds.has("/a")).toBe(true);
    useStore.getState().toggleExpanded("/a");
    expect(useStore.getState().expandedCwds.has("/a")).toBe(false);
  });
});

describe("Session slice", () => {
  it("loadSession populates chatFlow on success", async () => {
    const cf = { id: "deadbeef-cafe-4000-8000-000000000001", chatNodes: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(cf), { status: 200 })),
    );
    await useStore.getState().loadSession("deadbeef-cafe-4000-8000-000000000001");
    const s = useStore.getState().sessions.get("deadbeef-cafe-4000-8000-000000000001");
    expect(s?.chatFlow?.id).toBe("deadbeef-cafe-4000-8000-000000000001");
    expect(s?.isLoading).toBe(false);
  });

  it("loadSession records error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await useStore.getState().loadSession("xx");
    const s = useStore.getState().sessions.get("xx");
    expect(s?.error).toMatch(/404/);
    expect(s?.isLoading).toBe(false);
  });

  it("setActiveSession stores the id", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    useStore.getState().setActiveSession("abc");
    expect(useStore.getState().activeSessionId).toBe("abc");
  });

  it("toggleFold toggles a node id in foldedNodeIds", () => {
    useStore.getState().toggleFold("sid", "node-1");
    let s = useStore.getState().sessions.get("sid");
    expect(s?.foldedNodeIds.has("node-1")).toBe(true);
    useStore.getState().toggleFold("sid", "node-1");
    s = useStore.getState().sessions.get("sid");
    expect(s?.foldedNodeIds.has("node-1")).toBe(false);
  });

  it("setSelected updates selectedNodeId for the session", () => {
    useStore.getState().setSelected("sid", "node-x");
    expect(useStore.getState().sessions.get("sid")?.selectedNodeId).toBe("node-x");
    useStore.getState().setSelected("sid", null);
    expect(useStore.getState().sessions.get("sid")?.selectedNodeId).toBe(null);
  });

  it("setViewport stores the viewport for the session", () => {
    useStore.getState().setViewport("sid", { x: 10, y: 20, zoom: 1.5 });
    expect(useStore.getState().sessions.get("sid")?.viewport).toEqual({
      x: 10,
      y: 20,
      zoom: 1.5,
    });
  });
});

describe("LiveEvent slice (stub)", () => {
  it("subscribe/unsubscribe are no-ops without throwing", () => {
    expect(() => useStore.getState().subscribeSession("sid")).not.toThrow();
    expect(() => useStore.getState().unsubscribeSession("sid")).not.toThrow();
  });
});

describe("persist middleware", () => {
  it("persists only UI keys (no sessions/workspaces)", () => {
    useStore.getState().setSidebarWidth(220);
    useStore.getState().pinWorkspace("/persist-me");
    useStore.setState({
      // simulate non-UI mutation we should NOT see in localStorage
      workspaces: [{ cwd: "/x", sessionCount: 1, lastModified: "2026-01-01T00:00:00Z" }],
    });
    const raw = localStorage.getItem("loomscope:state");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state.sidebarWidth).toBe(220);
    expect(parsed.state.pinnedWorkspaces).toEqual(["/persist-me"]);
    expect(parsed.state).not.toHaveProperty("workspaces");
    expect(parsed.state).not.toHaveProperty("sessions");
  });
});
