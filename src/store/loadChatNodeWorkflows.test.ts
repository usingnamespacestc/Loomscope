// v0.10 lazy ChatFlow B2: tests for the per-ChatNode workflow lazy
// load action. Pattern mirrors subAgentDrill.test.ts — stub global
// fetch, drive the action, assert on store state transitions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSessionState } from "@/test/factories";

import type { ChatFlow, ChatNode, WorkFlow } from "@/data/types";
import { useStore } from "@/store/index";

const SID = "00000000-0000-4000-8000-0000000000bb";

function chatNode(id: string, parent: string | null = null): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [] },
    workflow: {
      summary: {
        assistantPreview: `${id} reply preview`,
        assistantText: [],
        hasInFlightWork: false,
        llmCount: 1,
        chainCount: 1,
        toolCount: 0,
        totalThinkingChars: 0,
        contextTokens: 100,
        maxContextTokens: 200_000,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        toolUseFilePaths: [],
      },
      nodes: [],
      edges: [],
    },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
}

function chatFlow(nodes: ChatNode[]): ChatFlow {
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
      lastUpdated: Date.now(),
      lastInvalidateAt: 0,
    });
    return { sessions, activeSessionId: SID };
  });
}

function fakeWorkflow(text: string): { nodes: WorkFlow["nodes"]; edges: WorkFlow["edges"] } {
  return {
    nodes: [
      {
        id: `l-${text}`,
        kind: "llm_call",
        parentUuid: null,
        text,
        thinking: [],
      },
    ],
    edges: [],
  };
}

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadChatNodeWorkflows", () => {
  it("fetches the requested ids and stores them as ready", async () => {
    seed(chatFlow([chatNode("a"), chatNode("b")]));
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            workflows: { a: fakeWorkflow("hi-a"), b: fakeWorkflow("hi-b") },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().loadChatNodeWorkflows(SID, ["a", "b"]);
    const cache = useStore.getState().sessions.get(SID)!.workflowCache;
    expect(cache.get("a")?.status).toBe("ready");
    expect(cache.get("b")?.status).toBe("ready");
    const firstNode = cache.get("a")?.workflow?.nodes[0];
    expect(firstNode?.kind).toBe("llm_call");
    if (firstNode?.kind === "llm_call") {
      expect(firstNode.text).toBe("hi-a");
    }
    expect(fetchMock.mock.calls.length).toBe(1);
    // URL carries comma-joined ids
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toMatch(/[?&]ids=a,b\b/);
  });

  it("back-fills WorkFlow.summary from the existing ChatFlow on success", async () => {
    seed(chatFlow([chatNode("a")]));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ workflows: { a: fakeWorkflow("hi") } }),
            { status: 200 },
          ),
      ),
    );
    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    const wf = useStore.getState().sessions.get(SID)!.workflowCache.get("a")!.workflow!;
    expect(wf.summary?.assistantPreview).toBe("a reply preview");
  });

  it("skips ids already in cache as ready (no extra fetch)", async () => {
    seed(chatFlow([chatNode("a")]));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ workflows: { a: fakeWorkflow("first") } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    expect(fetchMock.mock.calls.length).toBe(1);

    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    expect(fetchMock.mock.calls.length).toBe(1); // no new fetch
  });

  it("retries entries that previously errored", async () => {
    seed(chatFlow([chatNode("a")]));
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return new Response("boom", { status: 500 });
        return new Response(
          JSON.stringify({ workflows: { a: fakeWorkflow("ok") } }),
          { status: 200 },
        );
      }),
    );

    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    expect(useStore.getState().sessions.get(SID)!.workflowCache.get("a")?.status).toBe(
      "error",
    );

    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    expect(useStore.getState().sessions.get(SID)!.workflowCache.get("a")?.status).toBe(
      "ready",
    );
    expect(attempt).toBe(2);
  });

  it("dedupes concurrent calls so each id is fetched at most once", async () => {
    seed(chatFlow([chatNode("a"), chatNode("b")]));
    let resolveFetch!: () => void;
    const slow = new Promise<void>((r) => {
      resolveFetch = r;
    });
    const fetchMock = vi.fn(async () => {
      await slow;
      return new Response(
        JSON.stringify({ workflows: { a: fakeWorkflow("a"), b: fakeWorkflow("b") } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const p1 = useStore.getState().loadChatNodeWorkflows(SID, ["a", "b"]);
    const p2 = useStore.getState().loadChatNodeWorkflows(SID, ["a", "b"]);
    resolveFetch();
    await Promise.all([p1, p2]);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("marks ids omitted by the server as error (treat as not-found)", async () => {
    seed(chatFlow([chatNode("a"), chatNode("ghost")]));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ workflows: { a: fakeWorkflow("ok") } }),
            { status: 200 },
          ),
      ),
    );
    await useStore.getState().loadChatNodeWorkflows(SID, ["a", "ghost"]);
    const cache = useStore.getState().sessions.get(SID)!.workflowCache;
    expect(cache.get("a")?.status).toBe("ready");
    expect(cache.get("ghost")?.status).toBe("error");
    expect(cache.get("ghost")?.error).toMatch(/not found/);
  });

  it("network error → all requested ids marked error with the error message", async () => {
    seed(chatFlow([chatNode("a"), chatNode("b")]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server down", { status: 500 })),
    );
    await useStore.getState().loadChatNodeWorkflows(SID, ["a", "b"]);
    const cache = useStore.getState().sessions.get(SID)!.workflowCache;
    expect(cache.get("a")?.status).toBe("error");
    expect(cache.get("b")?.status).toBe("error");
    expect(cache.get("a")?.error).toMatch(/500/);
  });

  it("WorkFlow follow-on-leaf: advances workflowSelectedNodeId when refresh delivers a new tail and user was on the old tail", async () => {
    seed(chatFlow([chatNode("a")]));
    // Pre-seed cache with an old workflow whose tail is "tail-old".
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      const cache = new Map(cur.workflowCache);
      cache.set("a", {
        status: "ready",
        workflow: {
          summary: cur.chatFlow!.chatNodes[0].workflow.summary,
          nodes: [
            { id: "l1", kind: "llm_call", parentUuid: null, text: "first", thinking: [] },
            { id: "tail-old", kind: "llm_call", parentUuid: "l1", text: "tail-old", thinking: [] },
          ],
          edges: [],
        },
        error: null,
        staleSince: 1,
      });
      sessions.set(SID, {
        ...makeSessionState(),
        ...cur,
        workflowCache: cache,
        workflowSelectedNodeId: "tail-old",
      });
      return { sessions };
    });
    // Server returns a longer workflow ending at "tail-new".
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              workflows: {
                a: {
                  nodes: [
                    { id: "l1", kind: "llm_call", parentUuid: null, text: "first", thinking: [] },
                    { id: "tail-old", kind: "llm_call", parentUuid: "l1", text: "tail-old", thinking: [] },
                    { id: "tail-new", kind: "llm_call", parentUuid: "tail-old", text: "tail-new", thinking: [] },
                  ],
                  edges: [],
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    expect(useStore.getState().sessions.get(SID)!.workflowSelectedNodeId).toBe("tail-new");
  });

  it("WorkFlow follow-on-leaf: leaves workflowSelectedNodeId alone when user was mid-workflow (not on tail)", async () => {
    seed(chatFlow([chatNode("a")]));
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      const cache = new Map(cur.workflowCache);
      cache.set("a", {
        status: "ready",
        workflow: {
          summary: cur.chatFlow!.chatNodes[0].workflow.summary,
          nodes: [
            { id: "l1", kind: "llm_call", parentUuid: null, text: "first", thinking: [] },
            { id: "l2", kind: "llm_call", parentUuid: "l1", text: "second", thinking: [] },
          ],
          edges: [],
        },
        error: null,
        staleSince: 1,
      });
      sessions.set(SID, {
        ...makeSessionState(),
        ...cur,
        workflowCache: cache,
        workflowSelectedNodeId: "l1", // user inspecting an EARLIER WorkNode
      });
      return { sessions };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              workflows: {
                a: {
                  nodes: [
                    { id: "l1", kind: "llm_call", parentUuid: null, text: "first", thinking: [] },
                    { id: "l2", kind: "llm_call", parentUuid: "l1", text: "second", thinking: [] },
                    { id: "l3", kind: "llm_call", parentUuid: "l2", text: "third", thinking: [] },
                  ],
                  edges: [],
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await useStore.getState().loadChatNodeWorkflows(SID, ["a"]);
    expect(useStore.getState().sessions.get(SID)!.workflowSelectedNodeId).toBe("l1");
  });

  it("no-op when given an empty id array", async () => {
    seed(chatFlow([chatNode("a")]));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await useStore.getState().loadChatNodeWorkflows(SID, []);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("no-op when sessionId doesn't match an active session", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await useStore
      .getState()
      .loadChatNodeWorkflows("missing-session-id", ["a"]);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("chunks request when id count exceeds 100 (server max=200)", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `n${i}`);
    seed(chatFlow(ids.map((id) => chatNode(id))));
    const fetchMock = vi.fn(async (url: string) => {
      const idsParam = url.match(/[?&]ids=([^&]+)/)?.[1] ?? "";
      const requested = idsParam.split(",");
      const workflows: Record<string, unknown> = {};
      for (const id of requested) workflows[id] = fakeWorkflow(id);
      return new Response(JSON.stringify({ workflows }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await useStore.getState().loadChatNodeWorkflows(SID, ids);
    // 150 ids / 100 per chunk = 2 fetches
    expect(fetchMock.mock.calls.length).toBe(2);
    const cache = useStore.getState().sessions.get(SID)!.workflowCache;
    for (const id of ids) {
      expect(cache.get(id)?.status).toBe("ready");
    }
  });
});
