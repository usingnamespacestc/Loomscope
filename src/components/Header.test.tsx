import { beforeEach, describe, expect, it } from "vitest";
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
        chatFlow: cf,
        foldedNodeIds: new Set(),
        foldedCompactIds: new Set(),
        viewport: { x: 0, y: 0, zoom: 1 },
        selectedNodeId: null,
        workflowSelectedNodeId: null,
        drillStack: [],
      branchMemory: {},
        subAgentCache: new Map(),
        isLoading: false,
        error: null,
        lastUpdated: 1,
      });
      return { sessions, activeSessionId: cf.id };
    });
    render(<Header />);
    expect(screen.getByText(/\/home\/u\/proj/)).toBeTruthy();
    expect(screen.getByText(/feat\/x/)).toBeTruthy();
    expect(screen.getByText(/2026-05-01 10:00/)).toBeTruthy();
  });
});
