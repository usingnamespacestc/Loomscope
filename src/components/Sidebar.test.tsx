import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Sidebar } from "@/components/Sidebar";
import { useStore } from "@/store/index";
import type { TrashedSession } from "@/api/trash";

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
      activeSessionId: null,
      workspaces: [],
      workspacesError: null,
      workspacesLoading: false,
      sidebarCollapsed: false,
      trashedSessions: [],
      trashLoading: false,
      trashError: null,
      trashExpanded: false,
    },
    false,
  );
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeTrashed(
  partial: Partial<TrashedSession> & { sessionId: string },
): TrashedSession {
  return {
    sessionId: partial.sessionId,
    originalPath: partial.originalPath ?? `/tmp/proj/${partial.sessionId}.jsonl`,
    originalCwd: partial.originalCwd ?? "/tmp/proj",
    trashedAt: partial.trashedAt ?? "2026-05-09T01:00:00.000Z",
    title: partial.title ?? "trashed session",
    modifiedAt: partial.modifiedAt ?? "2026-05-09T00:30:00.000Z",
    fileSize: partial.fileSize ?? 1024,
    messageCount: partial.messageCount ?? 5,
    trashedPath: partial.trashedPath ?? `/tmp/.trash/${partial.sessionId}.jsonl`,
  };
}

describe("Sidebar", () => {
  it("renders 'No CC sessions' when scan returns empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    render(<Sidebar />);
    await waitFor(() => {
      // v0.9.1 i18n: test setup pins zh-CN, so the empty-state copy
      // is the Chinese version. Loose match keeps the assertion
      // resilient to future copy tweaks.
      expect(screen.getByText(/未在.+CC session/)).toBeTruthy();
    });
  });

  it("lists workspaces from the workspaces endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/workspaces") && !url.includes("/sessions")) {
          return new Response(
            JSON.stringify([
              { cwd: "/home/u/alpha", sessionCount: 3, lastModified: "2026-05-01T00:00:00Z" },
              { cwd: "/home/u/beta", sessionCount: 1, lastModified: "2026-04-01T00:00:00Z" },
            ]),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }),
    );
    render(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeTruthy();
      expect(screen.getByText("beta")).toBeTruthy();
    });
  });

  it("expands a workspace + lazy-loads sessions on click", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("/sessions")) {
        return new Response(
          JSON.stringify([
            { cwd: "/proj", sessionCount: 1, lastModified: "2026-05-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          {
            sessionId: "11111111-1111-4000-8000-000000000001",
            title: "Refactor parser",
            modified: "2026-05-01T00:00:00Z",
            messageCount: 42,
            gitBranch: "main",
            fileSize: 1024,
            isSidechain: false,
          },
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("proj")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("workspace-row-/proj"));
    await waitFor(() => {
      expect(screen.getByText("Refactor parser")).toBeTruthy();
    });
  });

  it("right-click on workspace folder opens 'Create session here' menu (interactive mode)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("/sessions")) {
        return new Response(
          JSON.stringify([
            { cwd: "/proj", sessionCount: 1, lastModified: "2026-05-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    useStore.setState({ interactiveMode: true });
    render(<Sidebar />);
    const row = await screen.findByTestId("workspace-row-/proj");
    fireEvent.contextMenu(row);
    // ContextMenu portals to body — query via text.
    await waitFor(() => {
      expect(screen.getByText(/在此创建 session|Create session here/)).toBeTruthy();
    });
    // Clicking the item opens the modal pre-filled with this cwd.
    fireEvent.click(screen.getByText(/在此创建 session|Create session here/));
    await waitFor(() => {
      expect(screen.getByTestId("new-session-modal")).toBeTruthy();
    });
  });

  it("right-click on workspace folder in viewer mode shows menu with create item disabled", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("/sessions")) {
        return new Response(
          JSON.stringify([
            { cwd: "/proj", sessionCount: 1, lastModified: "2026-05-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    useStore.setState({ interactiveMode: false });
    render(<Sidebar />);
    const row = await screen.findByTestId("workspace-row-/proj");
    fireEvent.contextMenu(row);
    // v1.6 #187: menu appears in viewer mode too (visible-but-disabled
    // pattern matching the composer). Create item is disabled.
    const item = await screen.findByTestId(
      "context-menu-item-new-session-here",
    );
    expect(item.hasAttribute("disabled")).toBe(true);
  });

  it("clicking a session row sets it active in the store", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes("/sessions")) {
        return new Response(
          JSON.stringify([
            { cwd: "/proj", sessionCount: 1, lastModified: "2026-05-01T00:00:00Z" },
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          {
            sessionId: "11111111-1111-4000-8000-000000000001",
            title: "T",
            modified: "2026-05-01T00:00:00Z",
            messageCount: 1,
            gitBranch: null,
            fileSize: 12,
            isSidechain: false,
          },
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Sidebar />);
    await waitFor(() => screen.getByText("proj"));
    fireEvent.click(screen.getByTestId("workspace-row-/proj"));
    await waitFor(() =>
      screen.getByTestId("session-row-11111111-1111-4000-8000-000000000001"),
    );
    fireEvent.click(screen.getByTestId("session-row-11111111-1111-4000-8000-000000000001"));
    expect(useStore.getState().activeSessionId).toBe(
      "11111111-1111-4000-8000-000000000001",
    );
  });
});

describe("Sidebar — TrashSection", () => {
  // No-op fetch by default — TrashSection is driven by store state,
  // not network. Individual tests stub more specific fetches when
  // testing actions that hit /api/trash.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
  });

  it("trash header always renders, even with empty trash", async () => {
    render(<Sidebar />);
    const section = await screen.findByTestId("sidebar-trash-section");
    expect(section).toBeTruthy();
    expect(screen.getByTestId("sidebar-trash-toggle")).toBeTruthy();
  });

  it("count badge reflects trashedSessions length", () => {
    useStore.setState({
      trashedSessions: [
        makeTrashed({ sessionId: "aaaaaaaa-aaaa-4000-8000-000000000001" }),
        makeTrashed({ sessionId: "aaaaaaaa-aaaa-4000-8000-000000000002" }),
      ],
    });
    render(<Sidebar />);
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("expanding the trash shows trashed session rows", () => {
    const sid = "bbbbbbbb-bbbb-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid, title: "Old work" })],
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("sidebar-trash-toggle"));
    expect(screen.getByTestId(`sidebar-trash-row-${sid}`)).toBeTruthy();
    expect(screen.getByText("Old work")).toBeTruthy();
  });

  it("empty button only renders when expanded AND trash has items", () => {
    // Empty + collapsed → no empty button.
    const { unmount } = render(<Sidebar />);
    expect(screen.queryByTestId("sidebar-trash-empty")).toBeNull();
    unmount();

    // Expanded but still empty → no button (avoids dangling action).
    useStore.setState({ trashExpanded: true });
    const { unmount: u2 } = render(<Sidebar />);
    expect(screen.queryByTestId("sidebar-trash-empty")).toBeNull();
    u2();

    // Expanded + populated → button shows.
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: "ccccccc1-cccc-4000-8000-000000000001" })],
      trashExpanded: true,
    });
    render(<Sidebar />);
    expect(screen.getByTestId("sidebar-trash-empty")).toBeTruthy();
  });

  it("clicking restore calls DELETE /api/trash/:sid via the store action", async () => {
    const sid = "dddddddd-dddd-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid })],
      trashExpanded: true,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      // restoreTrashedSession hits POST /api/trash/:sid/restore
      if (url.includes("/restore") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ restoredPath: "/tmp/proj/restored.jsonl" }),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId(`sidebar-trash-restore-${sid}`));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/trash/${sid}/restore`),
        expect.objectContaining({ method: "POST" }),
      );
    });
    // Store action drops the session from trashedSessions on success.
    await waitFor(() => {
      expect(useStore.getState().trashedSessions.length).toBe(0);
    });
  });

  it("clicking purge opens ConfirmBanner (does NOT delete immediately)", () => {
    const sid = "eeeeeeee-eeee-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid, title: "Critical" })],
      trashExpanded: true,
    });
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId(`sidebar-trash-purge-${sid}`));
    // Banner appears with the session title interpolated.
    const banner = screen.getByTestId("confirm-banner");
    expect(banner).toBeTruthy();
    expect(banner.textContent ?? "").toContain("Critical");
    // No DELETE fetch yet — only happens after explicit confirm click.
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes(`/api/trash/${sid}`)
        && (c[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("purge confirm fires DELETE /api/trash/:sid; cancel does nothing", async () => {
    const sid = "ffffffff-ffff-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid })],
      trashExpanded: true,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes(`/api/trash/${sid}`)
        && init?.method === "DELETE"
      ) {
        return new Response("{}", { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId(`sidebar-trash-purge-${sid}`));
    fireEvent.click(screen.getByTestId("confirm-banner-confirm"));
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      expect(
        calls.some(
          (c) =>
            String(c[0]).includes(`/api/trash/${sid}`)
            && (c[1] as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });

  it("empty trash confirm fires POST /api/trash/empty", async () => {
    useStore.setState({
      trashedSessions: [
        makeTrashed({ sessionId: "12345678-aaaa-4000-8000-000000000001" }),
      ],
      trashExpanded: true,
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/trash/empty") && init?.method === "POST") {
        return new Response(JSON.stringify({ count: 1 }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("sidebar-trash-empty"));
    fireEvent.click(screen.getByTestId("confirm-banner-confirm"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (c) =>
            String(c[0]).includes("/api/trash/empty")
            && (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
  });

  it("ConfirmBanner cancel button closes banner without firing the action", () => {
    const sid = "abcdef00-aaaa-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid })],
      trashExpanded: true,
    });
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId(`sidebar-trash-purge-${sid}`));
    expect(screen.getByTestId("confirm-banner")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-banner-cancel"));
    expect(screen.queryByTestId("confirm-banner")).toBeNull();
    // No DELETE call.
    expect(
      fetchMock.mock.calls.some(
        (c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("clicking trash row body sets active session (read-only browse)", () => {
    const sid = "11112222-3333-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid })],
      trashExpanded: true,
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId(`sidebar-trash-open-${sid}`));
    expect(useStore.getState().activeSessionId).toBe(sid);
  });

  it("Enter on focused trash row body opens it (keyboard accessibility)", () => {
    const sid = "22223333-4444-4000-8000-000000000001";
    useStore.setState({
      trashedSessions: [makeTrashed({ sessionId: sid })],
      trashExpanded: true,
    });
    render(<Sidebar />);
    const row = screen.getByTestId(`sidebar-trash-open-${sid}`);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(useStore.getState().activeSessionId).toBe(sid);
  });

  // v1.1 viewer-only gating; v1.6 #187 reworked the pattern: write
  // affordances stay visible (so users still discover them) but are
  // rendered disabled, matching the composer's visible-but-disabled
  // approach.
  describe("viewer-only mode (interactiveMode=false)", () => {
    beforeEach(() => {
      useStore.setState({ interactiveMode: false });
    });

    it("renders per-row restore + purge buttons disabled (not hidden)", () => {
      const sid = "33334444-5555-4000-8000-000000000001";
      useStore.setState({
        trashedSessions: [makeTrashed({ sessionId: sid })],
        trashExpanded: true,
      });
      render(<Sidebar />);
      const restore = screen.getByTestId(`sidebar-trash-restore-${sid}`);
      const purge = screen.getByTestId(`sidebar-trash-purge-${sid}`);
      expect(restore.hasAttribute("disabled")).toBe(true);
      expect(purge.hasAttribute("disabled")).toBe(true);
      // Row body still renders so observers can browse.
      expect(screen.getByTestId(`sidebar-trash-open-${sid}`)).toBeTruthy();
    });

    it("renders the empty-trash button disabled (not hidden)", () => {
      useStore.setState({
        trashedSessions: [
          makeTrashed({ sessionId: "44445555-6666-4000-8000-000000000001" }),
        ],
        trashExpanded: true,
      });
      render(<Sidebar />);
      const btn = screen.getByTestId("sidebar-trash-empty");
      expect(btn.hasAttribute("disabled")).toBe(true);
    });

    it("renders the + new-session button disabled (not hidden)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("[]", { status: 200 })),
      );
      render(<Sidebar />);
      const btn = await screen.findByTestId("sidebar-new-session");
      expect(btn.hasAttribute("disabled")).toBe(true);
    });
  });
});
