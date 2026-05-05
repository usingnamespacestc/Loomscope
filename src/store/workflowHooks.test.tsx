// v0.10 lazy-ChatFlow B4: useChatNodeWorkflow hook tests.
//
// The hook is the single integration point components use to read a
// ChatNode's workflow + lazily fetch when needed. Coverage:
//   - inline workflow.nodes loaded → returns ready synchronously
//   - lite + summaryHasContent → triggers fetch via store action
//   - empty turn (no llm/tool) → returns ready without fetching
//   - cache=ready → returns cached workflow
//   - cache=error → returns error state
//   - cache=pending → stays pending without re-firing fetch

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

import type { ChatFlow, ChatNode, WorkFlow } from "@/data/types";
import { useStore } from "@/store/index";
import { useChatNodeWorkflow } from "@/store/workflowHooks";

const SID = "00000000-0000-4000-8000-0000000000cc";

function summary(over: Partial<WorkFlow["summary"] & object> = {}) {
  return {
    assistantPreview: "preview",
    llmCount: 1,
    chainCount: 1,
    toolCount: 0,
    totalThinkingChars: 0,
    contextTokens: 100,
    maxContextTokens: 200_000,
    toolUseFilePaths: [],
    ...over,
  };
}

function chatNode(id: string, wf: Partial<WorkFlow> = {}): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: null,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [] },
    workflow: {
      summary: summary(),
      nodes: [],
      edges: [],
      ...wf,
    },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function flow(nodes: ChatNode[]): ChatFlow {
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

function seed(cf: ChatFlow): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
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
      isLoading: false,
      error: null,
      lastUpdated: Date.now(),
    });
    return { sessions, activeSessionId: SID };
  });
}

interface Snapshot {
  status: string;
  hasWorkflow: boolean;
  isLazy: boolean;
  error: string | null;
}

function Probe({
  cn,
  onRender,
}: {
  cn: ChatNode;
  onRender: (s: Snapshot) => void;
}) {
  const r = useChatNodeWorkflow(SID, cn);
  onRender({
    status: r.status,
    hasWorkflow: r.workflow !== null,
    isLazy: r.isLazy,
    error: r.error,
  });
  return null;
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useChatNodeWorkflow", () => {
  it("inline workflow.nodes already populated → ready synchronously, isLazy=false", () => {
    const cn = chatNode("a", {
      nodes: [
        { id: "l1", kind: "llm_call", parentUuid: null, text: "hi", thinking: [] },
      ],
    });
    seed(flow([cn]));
    const snapshots: Snapshot[] = [];
    render(<Probe cn={cn} onRender={(s) => snapshots.push(s)} />);
    const last = snapshots[snapshots.length - 1];
    expect(last.status).toBe("ready");
    expect(last.hasWorkflow).toBe(true);
    expect(last.isLazy).toBe(false);
  });

  it("lite + summaryHasContent → starts pending, triggers fetch, transitions to ready", async () => {
    const cn = chatNode("b"); // nodes:[], summary.llmCount:1
    seed(flow([cn]));
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workflows: {
              b: {
                nodes: [
                  {
                    id: "l1",
                    kind: "llm_call",
                    parentUuid: null,
                    text: "lazy",
                    thinking: [],
                  },
                ],
                edges: [],
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snapshots: Snapshot[] = [];
    render(<Probe cn={cn} onRender={(s) => snapshots.push(s)} />);
    // First render: pending, isLazy=true
    const first = snapshots[0];
    expect(first.status).toBe("pending");
    expect(first.hasWorkflow).toBe(false);
    expect(first.isLazy).toBe(true);
    // After useEffect fires + fetch resolves
    await waitFor(() => {
      expect(snapshots[snapshots.length - 1].status).toBe("ready");
    });
    expect(snapshots[snapshots.length - 1].hasWorkflow).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("empty turn (summary llm=0, tool=0) → ready without fetching", () => {
    const cn = chatNode("c", {
      summary: summary({ llmCount: 0, toolCount: 0 }),
    });
    seed(flow([cn]));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshots: Snapshot[] = [];
    render(<Probe cn={cn} onRender={(s) => snapshots.push(s)} />);
    const last = snapshots[snapshots.length - 1];
    expect(last.status).toBe("ready");
    expect(last.hasWorkflow).toBe(true); // returns inline empty workflow
    expect(last.isLazy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cache=error → returns error, useEffect retries on next mount", async () => {
    const cn = chatNode("d");
    seed(flow([cn]));
    // Pre-populate cache with error state
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      const cache = new Map(cur.workflowCache);
      cache.set("d", { status: "error", workflow: null, error: "boom" });
      sessions.set(SID, { ...cur, workflowCache: cache });
      return { sessions };
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workflows: {
              d: {
                nodes: [
                  {
                    id: "l1",
                    kind: "llm_call",
                    parentUuid: null,
                    text: "ok now",
                    thinking: [],
                  },
                ],
                edges: [],
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snapshots: Snapshot[] = [];
    render(<Probe cn={cn} onRender={(s) => snapshots.push(s)} />);
    // Initial: error from cache
    expect(snapshots[0].status).toBe("error");
    expect(snapshots[0].error).toBe("boom");
    // useEffect fires retry → eventually ready
    await waitFor(() => {
      expect(snapshots[snapshots.length - 1].status).toBe("ready");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cache=ready → returns cached workflow without re-fetching", () => {
    const cn = chatNode("e");
    seed(flow([cn]));
    const cachedWorkflow: WorkFlow = {
      summary: summary(),
      nodes: [
        { id: "l1", kind: "llm_call", parentUuid: null, text: "cached", thinking: [] },
      ],
      edges: [],
    };
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      const cache = new Map(cur.workflowCache);
      cache.set("e", { status: "ready", workflow: cachedWorkflow, error: null });
      sessions.set(SID, { ...cur, workflowCache: cache });
      return { sessions };
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshots: Snapshot[] = [];
    render(<Probe cn={cn} onRender={(s) => snapshots.push(s)} />);
    expect(snapshots[snapshots.length - 1].status).toBe("ready");
    expect(snapshots[snapshots.length - 1].hasWorkflow).toBe(true);
    expect(snapshots[snapshots.length - 1].isLazy).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cache=pending → stays pending without firing another fetch", () => {
    const cn = chatNode("f");
    seed(flow([cn]));
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      const cache = new Map(cur.workflowCache);
      cache.set("f", { status: "pending", workflow: null, error: null });
      sessions.set(SID, { ...cur, workflowCache: cache });
      return { sessions };
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshots: Snapshot[] = [];
    render(<Probe cn={cn} onRender={(s) => snapshots.push(s)} />);
    expect(snapshots[snapshots.length - 1].status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
