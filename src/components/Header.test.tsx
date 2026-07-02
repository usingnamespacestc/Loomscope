import { beforeEach, describe, expect, it } from "vitest";
import { makeSessionState } from "@/test/factories";
import { render, screen } from "@testing-library/react";

import { Header } from "@/components/Header";
import { useStore } from "@/store/index";
import type { ChatFlow } from "@/data/types";

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...INITIAL, sessions: new Map(), activeSessionId: null }, false);
});

describe("Header", () => {
  it("shows 'Pick a session →' when no session is active", () => {
    render(<Header />);
    expect(screen.getByText("Loomscope")).toBeTruthy();
    expect(screen.getByText(/Pick a session/i)).toBeTruthy();
  });

  it("shows session metadata when a session is active", () => {
    const cf: ChatFlow = {
      id: "00000000-0000-4000-8000-000000000001",
      mainJsonlPath: "/path/to/x.jsonl",
      sidecarDir: "/path/to/x",
      cwd: "/home/u/proj",
      gitBranch: "feat/x",
      createdAt: "2026-05-01T10:00:00.000Z",
      lastUpdatedAt: "2026-05-01T11:30:00.000Z",
      chatNodes: [],
      orphans: [],
      flowEvents: [],
      trigger: "user",
    };
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(cf.id, {
        ...makeSessionState(),
        chatFlow: cf,
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
      lastNotification: null,
      currentTurn: null,
      lastTurnHookAt: 0,
        isLoading: false,
        error: null,
        lastUpdated: 1,
        lastInvalidateAt: 0,
      });
      return { sessions, activeSessionId: cf.id };
    });
    render(<Header />);
    expect(screen.getByText(/\/home\/u\/proj/)).toBeTruthy();
    expect(screen.getByText(/feat\/x/)).toBeTruthy();
    expect(screen.getByText(/2026-05-01 10:00/)).toBeTruthy();
  });

  // v2.6 security batch: bypassPermissions badge.
  // 中: bypass 常驻徽标——bypass 时显示,其他模式/未知时不显示。
  it("shows the bypass badge when serverPermissionMode is bypassPermissions", () => {
    useStore.setState({ serverPermissionMode: "bypassPermissions" }, false);
    render(<Header />);
    const badge = screen.getByTestId("bypass-permissions-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("title")).toBeTruthy();
  });

  it("hides the badge for other modes and before preferences load", () => {
    useStore.setState({ serverPermissionMode: "default" }, false);
    const r1 = render(<Header />);
    expect(screen.queryByTestId("bypass-permissions-badge")).toBeNull();
    r1.unmount();
    useStore.setState({ serverPermissionMode: null }, false);
    render(<Header />);
    expect(screen.queryByTestId("bypass-permissions-badge")).toBeNull();
  });
});
