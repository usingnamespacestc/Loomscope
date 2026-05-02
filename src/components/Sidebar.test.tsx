import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Sidebar } from "@/components/Sidebar";
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
      activeSessionId: null,
      workspaces: [],
      workspacesError: null,
      workspacesLoading: false,
      sidebarCollapsed: false,
    },
    false,
  );
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sidebar", () => {
  it("renders 'No CC sessions' when scan returns empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    render(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText(/No CC sessions found/i)).toBeTruthy();
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
