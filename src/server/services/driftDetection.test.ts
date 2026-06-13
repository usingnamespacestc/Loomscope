// EN (v2.1 PR D3): unit tests for the drift detection broadcaster.
// 中: drift 检测广播器单测。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTests as resetSseHub,
  subscribe,
  type SseMessage,
} from "@/server/services/sseHub";
import {
  _resetAllForTests as resetDeltaEngine,
  processFresh,
} from "@/server/services/chatFlowDeltaEngine";
import {
  _resetForTests as resetDrift,
  _tickForTests as triggerDriftTick,
  setDriftDetectionInterval,
  getDriftDetectionInterval,
} from "@/server/services/driftDetection";
import type {
  ChatFlow,
  ChatNode,
  WorkflowSummary,
} from "@/data/types";

const SID = "11111111-1111-4000-8000-000000000aaa";

function summary(o: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    assistantPreview: "",
    assistantText: [],
    llmCount: 1,
    hasInFlightWork: false,
    chainCount: 1,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    lastModel: "claude-opus-4-7",
    contextTokens: 0,
    maxContextTokens: 200000,
    totalThinkingChars: 0,
    toolUseFilePaths: [],
    ...o,
  };
}

function cn(id: string, parent: string | null = null): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [] },
    workflow: { nodes: [], edges: [], summary: summary() },
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

beforeEach(() => {
  resetSseHub();
  resetDeltaEngine();
  resetDrift();
});

afterEach(() => {
  resetDrift();
});

describe("driftDetection — tick", () => {
  it("emits drift-ping for each session with a snapshot", async () => {
    const msgs: SseMessage[] = [];
    subscribe(SID, { send: (m) => msgs.push(m) });
    await processFresh(SID, flow([cn("a")]));
    msgs.length = 0; // clear delta events
    triggerDriftTick();
    const pings = msgs.filter((m) => m.event === "drift-ping");
    expect(pings.length).toBe(1);
    const data = pings[0].data as {
      sessionId: string;
      seq: number;
      chatNodeCount: number;
      hash: string;
    };
    expect(data.sessionId).toBe(SID);
    expect(data.chatNodeCount).toBe(1);
    expect(typeof data.hash).toBe("string");
    expect(data.hash.length).toBeGreaterThan(0);
    expect(data.seq).toBeGreaterThan(0);
  });

  it("skips sessions without a snapshot", () => {
    const msgs: SseMessage[] = [];
    subscribe(SID, { send: (m) => msgs.push(m) });
    triggerDriftTick();
    expect(msgs.filter((m) => m.event === "drift-ping").length).toBe(0);
  });

  it("setDriftDetectionInterval(0) disables the loop", () => {
    setDriftDetectionInterval(0);
    expect(getDriftDetectionInterval()).toBe(0);
  });

  it("setDriftDetectionInterval clamps to [1, 600]", () => {
    setDriftDetectionInterval(700);
    expect(getDriftDetectionInterval()).toBe(600);
    setDriftDetectionInterval(-5);
    expect(getDriftDetectionInterval()).toBe(0);
    setDriftDetectionInterval(45);
    expect(getDriftDetectionInterval()).toBe(45);
  });

  it("hash is stable across ticks when chatflow unchanged", async () => {
    const msgs: SseMessage[] = [];
    subscribe(SID, { send: (m) => msgs.push(m) });
    await processFresh(SID, flow([cn("a")]));
    msgs.length = 0;
    triggerDriftTick();
    triggerDriftTick();
    const pings = msgs.filter((m) => m.event === "drift-ping");
    const h1 = (pings[0].data as { hash: string }).hash;
    const h2 = (pings[1].data as { hash: string }).hash;
    expect(h1).toBe(h2);
  });
});
