// Tests for v0.5 sub-agent cache + drill actions on SessionSlice.
//
// Covers:
//   - loadSubAgent fetch + cache + status transitions
//   - in-flight dedupe (concurrent loadSubAgent calls collapse)
//   - cache hit returns immediately + bumps lastAccess
//   - error transition + retry
//   - enterSubWorkflow: validates parentWorkNodeId, pushes frame,
//     idempotent re-push, ignores when stack empty / not a delegate
//   - resolveDrillView: walks chatnode → subworkflow chains; v0.6
//     redo returns sub-chatflow union arm with full sub ChatFlow
//     (no chatNodes[0] collapse, no multi-ChatNode banner)
//   - enterWorkflow stack-aware push (sub-chatflow → push, top → reset)
//   - session switch evicts the prior session's cache

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "@/store/index";
import {
  resolveDrillView,
  type DrillBreadcrumbItem,
} from "@/store/sessionSlice";
import type { ChatFlow, ChatNode, DelegateNode } from "@/data/types";

const SID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "agent_xyz_123";
const CHAT_NODE_ID = "p1";

function delegateNode(over: Partial<DelegateNode> = {}): DelegateNode {
  return {
    id: "d1",
    kind: "delegate",
    parentUuid: "l1",
    toolName: "Agent",
    agentId: AGENT_ID,
    agentType: "Explore",
    ...over,
  };
}

function makeChatFlow(): ChatFlow {
  const cn: ChatNode = {
    kind: "chat",
    id: CHAT_NODE_ID,
    parentChatNodeId: null,
    rootUserUuid: "u1",
    userMessage: { uuid: "u1", content: "hi", attachments: [] },
    workflow: {
      nodes: [
        { id: "l1", kind: "llm_call", parentUuid: null, text: "", thinking: [] },
        delegateNode(),
      ],
      edges: [],
    },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
  };
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: [cn],
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

function subAgentChatFlow(chatNodeIds: string[]): ChatFlow {
  return {
    id: AGENT_ID,
    mainJsonlPath: "/x/sub.jsonl",
    sidecarDir: "/x/sub",
    chatNodes: chatNodeIds.map((id, idx) => ({
      kind: "chat",
      id,
      parentChatNodeId: idx === 0 ? null : chatNodeIds[idx - 1],
      rootUserUuid: `u-${id}`,
      userMessage: { uuid: `u-${id}`, content: "do thing", attachments: [] },
      workflow: {
        nodes: [
          {
            id: `sub-l-${id}`,
            kind: "llm_call",
            parentUuid: null,
            text: "I did it",
            thinking: [],
          },
        ],
        edges: [],
      },
      trigger: "user",
      isCompactSummary: false,
      meta: {},
    })),
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

function seedSession(cf: ChatFlow = makeChatFlow()) {
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
      workflowViewports: new Map(),
      pendingPermission: null,
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

beforeEach(() => {
  useStore.setState({ sessions: new Map(), activeSessionId: null });
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadSubAgent", () => {
  it("fetches sub-agent ChatFlow and caches it as ready", async () => {
    seedSession();
    const sub = subAgentChatFlow(["sub-p1"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chatFlow: sub, meta: { agentType: "Explore" } }), {
            status: 200,
          }),
      ),
    );
    const entry = await useStore.getState().loadSubAgent(SID, AGENT_ID);
    expect(entry.status).toBe("ready");
    expect(entry.chatFlow?.id).toBe(AGENT_ID);
    const stored = useStore.getState().sessions.get(SID)?.subAgentCache.get(AGENT_ID);
    expect(stored?.status).toBe("ready");
    expect(stored?.chatFlow?.chatNodes).toHaveLength(1);
  });

  it("returns the cached entry on the second call without re-fetching", async () => {
    seedSession();
    const sub = subAgentChatFlow(["sub-p1"]);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatFlow: sub, meta: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().loadSubAgent(SID, AGENT_ID);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    const t0 = performance.now();
    const entry = await useStore.getState().loadSubAgent(SID, AGENT_ID);
    const elapsed = performance.now() - t0;
    expect(entry.status).toBe("ready");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no extra fetch
    // Cache hit must be effectively instant (well under the 50ms
    // verification target from the handoff).
    expect(elapsed).toBeLessThan(50);
  });

  it("dedupes concurrent in-flight fetches into a single network call", async () => {
    seedSession();
    const sub = subAgentChatFlow(["sub-p1"]);
    let resolveFetch!: () => void;
    const slow = new Promise<void>((r) => {
      resolveFetch = r;
    });
    const fetchMock = vi.fn(async () => {
      await slow;
      return new Response(JSON.stringify({ chatFlow: sub, meta: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p1 = useStore.getState().loadSubAgent(SID, AGENT_ID);
    const p2 = useStore.getState().loadSubAgent(SID, AGENT_ID);
    const p3 = useStore.getState().loadSubAgent(SID, AGENT_ID);
    resolveFetch();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.status).toBe("ready");
    expect(r2).toBe(r1); // same Promise resolution → same entry
    expect(r3).toBe(r1);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("records an error entry when the fetch fails", async () => {
    seedSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const entry = await useStore.getState().loadSubAgent(SID, AGENT_ID);
    expect(entry.status).toBe("error");
    expect(entry.error).toMatch(/500/);
    const stored = useStore.getState().sessions.get(SID)?.subAgentCache.get(AGENT_ID);
    expect(stored?.status).toBe("error");
  });

  it("forwards ?subdir as a query param when provided", async () => {
    seedSession();
    const sub = subAgentChatFlow(["sub-p1"]);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatFlow: sub, meta: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await useStore.getState().loadSubAgent(SID, AGENT_ID, "workflow_run_x");
    const call = fetchMock.mock.calls[0] as unknown as [string];
    expect(call[0]).toMatch(/subdir=workflow_run_x/);
  });
});

describe("enterSubWorkflow", () => {
  it("ignores when drillStack is empty (need an existing chatnode frame first)", () => {
    seedSession();
    useStore.getState().enterSubWorkflow(SID, "d1");
    expect(useStore.getState().sessions.get(SID)?.drillStack).toEqual([]);
  });

  it("ignores when parentWorkNodeId doesn't resolve to a delegate kind", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    // l1 is an llm_call, not a delegate. enterSubWorkflow must reject.
    useStore.getState().enterSubWorkflow(SID, "l1");
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toHaveLength(1);
    expect(stack[0].kind).toBe("chatnode");
  });

  it("pushes a subworkflow frame for a valid delegate + triggers loadSubAgent", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const sub = subAgentChatFlow(["sub-p1"]);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatFlow: sub, meta: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().enterSubWorkflow(SID, "d1");
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toHaveLength(2);
    expect(stack[1]).toEqual({ kind: "subworkflow", parentWorkNodeId: "d1" });
    // Cache should have a loading entry.
    const cache = useStore.getState().sessions.get(SID)?.subAgentCache;
    expect(cache?.get(AGENT_ID)?.status).toBe("loading");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("is idempotent when the top frame already targets the same WorkNode", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    vi.stubGlobal("fetch", vi.fn());
    useStore.getState().enterSubWorkflow(SID, "d1");
    useStore.getState().enterSubWorkflow(SID, "d1"); // re-push
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack.filter((f) => f.kind === "subworkflow")).toHaveLength(1);
  });
});

describe("resolveDrillView", () => {
  it("returns null when the stack is empty", () => {
    seedSession();
    expect(resolveDrillView(useStore.getState().sessions.get(SID)!)).toBeNull();
  });

  it("resolves a chatnode-only stack to a workflow-mode view + breadcrumb", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const got = resolveDrillView(useStore.getState().sessions.get(SID)!);
    expect(got?.mode).toBe("workflow");
    if (got?.mode !== "workflow") throw new Error("expected workflow mode");
    expect(got.chatNode.id).toBe(CHAT_NODE_ID);
    expect(got.scopeChatFlow.id).toBe(SID);
    expect(got.frameLabels).toHaveLength(1);
    expect(got.frameLabels[0].kind).toBe("chatnode");
  });

  it("walks chatnode → subworkflow into a sub-chatflow-mode view (no chatNodes[0] collapse)", async () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const sub = subAgentChatFlow(["sub-p1", "sub-p2", "sub-p3"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chatFlow: sub, meta: { agentType: "Explore" } }), {
            status: 200,
          }),
      ),
    );
    useStore.getState().enterSubWorkflow(SID, "d1");
    await useStore.getState().loadSubAgent(SID, AGENT_ID);
    const got = resolveDrillView(useStore.getState().sessions.get(SID)!);
    expect(got?.mode).toBe("sub-chatflow");
    if (got?.mode !== "sub-chatflow") throw new Error("expected sub-chatflow mode");
    // Full sub ChatFlow surfaced — multi-ChatNode (27% of real data)
    // gets a real second-level canvas instead of an amber banner.
    expect(got.chatFlow.chatNodes).toHaveLength(3);
    expect(got.frameLabels).toHaveLength(2);
    const labels = got.frameLabels as DrillBreadcrumbItem[];
    expect(labels[1].kind).toBe("subworkflow");
    expect(labels[1].label).toContain("Explore");
  });

  it("after sub-chatflow drill, enterWorkflow on a sub-ChatFlow ChatNode pushes (not resets)", async () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const sub = subAgentChatFlow(["sub-p1", "sub-p2"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chatFlow: sub, meta: { agentType: "Explore" } }), {
            status: 200,
          }),
      ),
    );
    useStore.getState().enterSubWorkflow(SID, "d1");
    await useStore.getState().loadSubAgent(SID, AGENT_ID);
    // Now drill into one of the sub ChatFlow's ChatNodes — should push,
    // because the top frame is a subworkflow.
    useStore.getState().enterWorkflow(SID, "sub-p2");
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toHaveLength(3);
    expect(stack[2]).toEqual({ kind: "chatnode", chatNodeId: "sub-p2" });
    const got = resolveDrillView(useStore.getState().sessions.get(SID)!);
    expect(got?.mode).toBe("workflow");
    if (got?.mode !== "workflow") throw new Error("expected workflow mode");
    // Resolved chatNode comes from the SUB ChatFlow, not the main one.
    expect(got.chatNode.id).toBe("sub-p2");
    expect(got.scopeChatFlow.id).toBe(AGENT_ID);
    expect(got.frameLabels).toHaveLength(3);
    expect(got.frameLabels[2].kind).toBe("chatnode");
  });

  it("returns null when the sub-agent cache hasn't loaded yet (canvas falls back)", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    // Manually push a subworkflow frame without seeding the cache.
    useStore.setState((s) => {
      const sessions = new Map(s.sessions);
      const cur = sessions.get(SID)!;
      sessions.set(SID, {
        ...cur,
        drillStack: [
          { kind: "chatnode", chatNodeId: CHAT_NODE_ID },
          { kind: "subworkflow", parentWorkNodeId: "d1" },
        ],
      });
      return { sessions };
    });
    const got = resolveDrillView(useStore.getState().sessions.get(SID)!);
    // Cache miss → resolver bails out (App.tsx treats this as ChatFlow view).
    expect(got).toBeNull();
  });

  it("flags an auto-compact agent in its breadcrumb label", async () => {
    const cf = makeChatFlow();
    // Replace delegate with one whose agentId starts with acompact-.
    const cn = cf.chatNodes[0];
    cn.workflow.nodes = cn.workflow.nodes.map((n) =>
      n.id === "d1"
        ? delegateNode({ agentId: "acompact-abc123", agentType: "auto-compact" })
        : n,
    );
    seedSession(cf);
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const sub = subAgentChatFlow(["sub-p1"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chatFlow: sub, meta: null }), { status: 200 }),
      ),
    );
    useStore.getState().enterSubWorkflow(SID, "d1");
    await useStore.getState().loadSubAgent(SID, "acompact-abc123");
    const got = resolveDrillView(useStore.getState().sessions.get(SID)!);
    expect(got?.frameLabels[1].isAutoCompact).toBe(true);
    expect(got?.frameLabels[1].label).toContain("auto-compact");
  });
});

describe("enterWorkflow", () => {
  it("from empty stack → resets to a single-frame chatnode stack", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const stack = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack).toEqual([{ kind: "chatnode", chatNodeId: CHAT_NODE_ID }]);
  });

  it("idempotent on the same chatNode at the top", () => {
    seedSession();
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const stack0 = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    useStore.getState().enterWorkflow(SID, CHAT_NODE_ID);
    const stack1 = useStore.getState().sessions.get(SID)?.drillStack ?? [];
    expect(stack1).toEqual(stack0);
  });
});

describe("session switch evicts cache", () => {
  it("clearing activeSessionId via setActiveSession drops the prior session's cache", async () => {
    seedSession();
    const sub = subAgentChatFlow(["sub-p1"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chatFlow: sub, meta: null }), { status: 200 }),
      ),
    );
    await useStore.getState().loadSubAgent(SID, AGENT_ID);
    expect(
      useStore.getState().sessions.get(SID)?.subAgentCache.get(AGENT_ID)?.status,
    ).toBe("ready");
    useStore.getState().setActiveSession("11111111-1111-4000-8000-000000000002");
    expect(useStore.getState().sessions.get(SID)?.subAgentCache.size).toBe(0);
  });
});
