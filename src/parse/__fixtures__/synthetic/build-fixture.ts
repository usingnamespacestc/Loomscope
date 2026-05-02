// Builds the synthetic.jsonl fixture programmatically. Kept as TS so the
// invariants under test are visible in source rather than buried in a
// hand-mangled JSONL blob. Tests call `buildSyntheticRecords()` and either
// stringify-to-jsonl or feed records to `buildChatFlow` directly.

import type { RawRecord } from "@/parse/raw-record";

export interface FixtureUuids {
  u1: string;
  a1: string;
  tu1: string;
  u2: string;
  a2: string;
  u3: string;
  a3: string;
  tu_agent: string;
  tu_sw: string;
  u4_agent: string;
  u4_sw: string;
  bdry1: string;
  u5: string;
  fire1: string;
  u_fire: string;
  aw1: string;
  u_after: string;
  u_root2: string;
  weird1: string;
}

export const fixtureUuids: FixtureUuids = {
  u1: "u1-aaaaaaaa-0000-0000-0000-000000000001",
  a1: "a1-aaaaaaaa-0000-0000-0000-000000000002",
  tu1: "toolu_glob_001",
  u2: "u2-aaaaaaaa-0000-0000-0000-000000000003",
  a2: "a2-aaaaaaaa-0000-0000-0000-000000000004",
  u3: "u3-aaaaaaaa-0000-0000-0000-000000000005",
  a3: "a3-aaaaaaaa-0000-0000-0000-000000000006",
  tu_agent: "toolu_agent_002",
  tu_sw: "toolu_sw_003",
  u4_agent: "u4-aaaaaaaa-0000-0000-0000-000000000007",
  u4_sw: "u4-aaaaaaaa-0000-0000-0000-000000000008",
  bdry1: "bd-aaaaaaaa-0000-0000-0000-000000000009",
  u5: "u5-aaaaaaaa-0000-0000-0000-000000000010",
  fire1: "fr-aaaaaaaa-0000-0000-0000-000000000011",
  u_fire: "uf-aaaaaaaa-0000-0000-0000-000000000012",
  aw1: "aw-aaaaaaaa-0000-0000-0000-000000000013",
  u_after: "ua-aaaaaaaa-0000-0000-0000-000000000014",
  u_root2: "ur-aaaaaaaa-0000-0000-0000-000000000015",
  weird1: "wd-aaaaaaaa-0000-0000-0000-000000000016",
};

export const SESSION_ID = "synthetic-session";

const baseFields = {
  sessionId: SESSION_ID,
  cwd: "/home/dev/example",
  gitBranch: "main",
  version: "2.1.104",
};

let tCounter = 0;
function ts(): string {
  // Deterministic, sortable.
  tCounter += 1;
  const dt = new Date(Date.UTC(2026, 0, 1, 0, 0, tCounter)).toISOString();
  return dt;
}

export function buildSyntheticRecords(): RawRecord[] {
  tCounter = 0;
  const u = fixtureUuids;
  const recs: RawRecord[] = [];

  // ChatNode #1 (promptId p1)
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u1,
    parentUuid: null,
    promptId: "p1",
    timestamp: ts(),
    message: { role: "user", content: "list all tsx files in src" },
  });
  recs.push({
    ...baseFields,
    type: "assistant",
    uuid: u.a1,
    parentUuid: u.u1,
    promptId: "p1",
    requestId: "req-1",
    timestamp: ts(),
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [
        { type: "thinking", thinking: "Let me glob the src dir.", signature: "sig1" },
        { type: "text", text: "Sure, let me search." },
        {
          type: "tool_use",
          id: u.tu1,
          name: "Glob",
          input: { pattern: "**/*.tsx", path: "/home/dev/example/src" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u2,
    parentUuid: u.a1,
    promptId: "p1",
    sourceToolAssistantUUID: u.a1,
    timestamp: ts(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: u.tu1,
          content: "5 paths returned",
        },
      ],
    },
    toolUseResult: {
      type: "text",
      text: "src/App.tsx\nsrc/main.tsx\n...",
    },
  });
  recs.push({
    ...baseFields,
    type: "assistant",
    uuid: u.a2,
    parentUuid: u.u2,
    promptId: "p1",
    requestId: "req-1",
    timestamp: ts(),
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "Found 5 .tsx files." }],
      stop_reason: "end_turn",
    },
  });

  // ChatNode #2 (promptId p2) — chains via u3.parentUuid=a2
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u3,
    parentUuid: u.a2,
    promptId: "p2",
    timestamp: ts(),
    message: { role: "user", content: "spawn an Agent + schedule a wake-up" },
  });
  recs.push({
    ...baseFields,
    type: "assistant",
    uuid: u.a3,
    parentUuid: u.u3,
    promptId: "p2",
    requestId: "req-2",
    timestamp: ts(),
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [
        { type: "text", text: "On it." },
        {
          type: "tool_use",
          id: u.tu_agent,
          name: "Agent",
          input: {
            subagent_type: "Explore",
            description: "Find perf hot spots",
            prompt: "Walk the perf graph and return the top 3 bottlenecks.",
          },
        },
        {
          type: "tool_use",
          id: u.tu_sw,
          name: "ScheduleWakeup",
          input: {
            delaySeconds: 60,
            prompt: "<<autonomous-loop-dynamic>>",
            reason: "wait for user input",
          },
        },
      ],
    },
  });
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u4_agent,
    parentUuid: u.a3,
    promptId: "p2",
    sourceToolAssistantUUID: u.a3,
    timestamp: ts(),
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: u.tu_agent, content: "agent done" },
      ],
    },
    toolUseResult: {
      status: "completed",
      agentId: "aaa1bbb2",
      agentType: "Explore",
      prompt: "Walk the perf graph and return the top 3 bottlenecks.",
      content: "Three top bottlenecks identified.",
      totalDurationMs: "1234",
      totalTokens: "5678",
      totalToolUseCount: "9",
      usage: { input_tokens: 100, output_tokens: 200 },
      toolStats: { readCount: 3, searchCount: 2 },
    },
  });
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u4_sw,
    parentUuid: u.u4_agent,
    promptId: "p2",
    sourceToolAssistantUUID: u.a3,
    timestamp: ts(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: u.tu_sw,
          content: "Next wakeup scheduled.",
        },
      ],
    },
    toolUseResult: { scheduledFor: 1776154440000, wasClamped: false },
  });

  // Compact ChatNode (promptId p3) — boundary + isCompactSummary user
  recs.push({
    ...baseFields,
    type: "system",
    subtype: "compact_boundary",
    uuid: u.bdry1,
    parentUuid: null,
    logicalParentUuid: u.a3,
    timestamp: ts(),
    compactMetadata: { trigger: "manual", preTokens: 50000 },
  });
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u5,
    parentUuid: u.bdry1,
    promptId: "p3",
    isCompactSummary: true,
    isVisibleInTranscriptOnly: false,
    timestamp: ts(),
    message: {
      role: "user",
      content: "[Compact summary] We searched files and dispatched Explore agent.",
    },
  });

  // Scheduled-fire ChatNode (promptId p4)
  recs.push({
    ...baseFields,
    type: "system",
    subtype: "scheduled_task_fire",
    uuid: u.fire1,
    parentUuid: u.u4_sw,
    timestamp: ts(),
    content: "Running scheduled task",
  });
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u_fire,
    parentUuid: u.fire1,
    promptId: "p4",
    isMeta: true,
    timestamp: ts(),
    message: { role: "user", content: "<<autonomous-loop-dynamic>>" },
  });

  // away_summary → next ChatNode (promptId p5)
  recs.push({
    ...baseFields,
    type: "system",
    subtype: "away_summary",
    uuid: u.aw1,
    parentUuid: u.u_fire,
    timestamp: ts(),
    content: "Heads up: scheduled work resumed; continue with task.",
  });
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u_after,
    parentUuid: u.aw1,
    promptId: "p5",
    timestamp: ts(),
    message: { role: "user", content: "next thing" },
  });

  // Multi-root: another parentUuid=null user record
  recs.push({
    ...baseFields,
    type: "user",
    uuid: u.u_root2,
    parentUuid: null,
    promptId: "p6",
    timestamp: ts(),
    message: { role: "user", content: "fresh root" },
  });

  // Orphan: unknown future type with no promptId
  recs.push({
    ...baseFields,
    type: "marble-origami-snapshot",
    uuid: u.weird1,
    parentUuid: null,
    timestamp: ts(),
  });

  // Skip-types
  recs.push({ ...baseFields, type: "last-prompt", parentUuid: null });
  recs.push({ ...baseFields, type: "queue-operation", parentUuid: null });

  return recs;
}

export function recordsToJsonl(recs: RawRecord[]): string {
  return recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
