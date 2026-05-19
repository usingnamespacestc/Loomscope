// @vitest-environment node
//
// Forces a Node-native environment so `Origin` headers aren't stripped as
// forbidden by happy-dom's spec-compliant `Request` polyfill (browsers
// reject JS-set Origin; we need to set it from tests to exercise CORS).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { _setCacheRootForTests } from "@/server/services/chatFlowDiskCache";

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";
const HOOK_SECRET = "0".repeat(64); // 64 hex chars matches loomscopeSecret format

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-app-test-"));
  // Pin disk cache to tmpRoot so getOrLoad's fire-and-forget writes
  // don't pollute the developer's real ~/.loomscope/cache/.
  _setCacheRootForTests(path.join(tmpRoot, "disk-cache"));
  app = createApp({
    rootDir: tmpRoot,
    csrfToken: TOKEN,
    allowedOrigin: ORIGIN,
    hookSecret: HOOK_SECRET,
  });
});

afterEach(async () => {
  _setCacheRootForTests(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, lines: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("GET /api/health", () => {
  it("returns ok=true", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rootDir: string };
    expect(body.ok).toBe(true);
    expect(body.rootDir).toBe(tmpRoot);
  });
});

describe("GET /api/workspaces", () => {
  it("returns the scanned list without internal projectDir field", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Foo");
    await writeJsonl(path.join(projectDir, "s.jsonl"), [{ cwd: "/home/user/Foo" }]);
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0].cwd).toBe("/home/user/Foo");
    expect(body[0].sessionCount).toBe(1);
    expect(body[0]).not.toHaveProperty("projectDir");
  });
});

describe("GET /api/workspaces/:cwdEnc/sessions", () => {
  it("returns sessions for a cwd", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Foo");
    await writeJsonl(path.join(projectDir, "00000000-0000-4000-8000-000000000001.jsonl"), [
      { type: "user", cwd: "/home/user/Foo", message: { content: "hi" } },
    ]);
    const cwdEnc = encodeURIComponent("/home/user/Foo");
    const res = await app.request(`/api/workspaces/${cwdEnc}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ sessionId: string; title: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].sessionId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("404s for an unknown cwd", async () => {
    const cwdEnc = encodeURIComponent("/does/not/exist");
    const res = await app.request(`/api/workspaces/${cwdEnc}/sessions`);
    expect(res.status).toBe(404);
  });

  // v1.6 fallback: scanWorkspaces races a freshly-spawned jsonl whose
  // initial records (queue-operation, etc.) carry no `cwd` field. The
  // dir gets dropped from scanWorkspaces' results → findWorkspaceByCwd
  // returns null → previously this surfaced as a 404 banner. Fallback
  // maps cwd → projectDir directly (CC's slash-to-dash encoding) and
  // lists files there even if no record yet declares the cwd.
  it("falls back to direct projectDir lookup when no jsonl record yet declares the cwd", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Bar");
    // jsonl exists but only carries pre-cwd records — mimics the
    // race window during fresh spawn.
    await writeJsonl(path.join(projectDir, "22222222-2222-4000-8000-000000000001.jsonl"), [
      { type: "queue-operation", op: "init" },
    ]);
    const cwdEnc = encodeURIComponent("/home/user/Bar");
    const res = await app.request(`/api/workspaces/${cwdEnc}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ sessionId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].sessionId).toBe(
      "22222222-2222-4000-8000-000000000001",
    );
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns parsed ChatFlow for an existing session", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Foo");
    const sid = "11111111-1111-4000-8000-000000000001";
    await writeJsonl(path.join(projectDir, `${sid}.jsonl`), [
      {
        type: "user",
        uuid: "u1",
        sessionId: sid,
        promptId: "p1",
        cwd: "/home/user/Foo",
        gitBranch: "main",
        message: { role: "user", content: "Hi" },
        timestamp: "2026-05-02T00:00:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello." }],
          stop_reason: "end_turn",
        },
        timestamp: "2026-05-02T00:00:01.000Z",
      },
    ]);
    const res = await app.request(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; chatNodes: unknown[] };
    expect(body.id).toBe(sid);
    expect(body.chatNodes.length).toBe(1);
  });

  // PR-2.5 slice 2: the lite GET carries the content-versioned
  // lifecycleSnapshot end-to-end through createApp's real registry
  // thunk. Recorded-not-consumed → existing fields unchanged (the
  // test above still asserts the legacy shape); this only adds the
  // field + pins the §9.8 "one watermark for content + lifecycle".
  it("includes a content-versioned lifecycleSnapshot (additive, recorded-not-consumed)", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Lc");
    const sid = "22222222-2222-4000-8000-000000000002";
    await writeJsonl(path.join(projectDir, `${sid}.jsonl`), [
      {
        type: "user",
        uuid: "u1",
        sessionId: sid,
        promptId: "p1",
        cwd: "/home/user/Lc",
        gitBranch: "main",
        message: { role: "user", content: "Hi" },
        timestamp: "2026-05-02T00:00:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello." }],
          stop_reason: "end_turn",
        },
        timestamp: "2026-05-02T00:00:01.000Z",
      },
    ]);
    const res = await app.request(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      version: number;
      lifecycleSnapshot?: {
        version: number;
        turnRunning: unknown;
        pendingPermission: unknown;
        queueDepth: number;
      };
    };
    expect(body.lifecycleSnapshot).toBeDefined();
    // No SDK registry entry for a pure file fixture → idle/empty,
    // and the snapshot shares the SAME monotonic watermark as
    // content (§9.8: one version for both).
    expect(body.lifecycleSnapshot!.turnRunning).toBeNull();
    expect(body.lifecycleSnapshot!.pendingPermission).toBeNull();
    expect(body.lifecycleSnapshot!.queueDepth).toBe(0);
    expect(body.lifecycleSnapshot!.version).toBe(body.version);
  });

  it("404s for an unknown session id", async () => {
    const res = await app.request("/api/sessions/00000000-0000-4000-8000-deadbeef0000");
    expect(res.status).toBe(404);
  });

  it("400s on a malformed session id", async () => {
    const res = await app.request("/api/sessions/not-a-uuid");
    expect(res.status).toBe(400);
  });
});

// v0.10 polish (lazy ChatFlow B1): default response strips
// workflow.nodes / workflow.edges and inlines summary instead.
// `?full=true` opts back into the legacy full-fat shape.
describe("GET /api/sessions/:id — lite vs full (v0.10 lazy ChatFlow)", () => {
  async function seedSession(): Promise<string> {
    const projectDir = path.join(tmpRoot, "-home-user-LL");
    const sid = "33333333-3333-4000-8000-000000000003";
    await writeJsonl(path.join(projectDir, `${sid}.jsonl`), [
      {
        type: "user",
        uuid: "u1",
        sessionId: sid,
        promptId: "p1",
        cwd: "/home/user/LL",
        message: { role: "user", content: "make a tweak" },
        timestamp: "2026-05-05T00:00:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, cache_read_input_tokens: 1234 },
        },
        timestamp: "2026-05-05T00:00:01.000Z",
      },
    ]);
    return sid;
  }

  it("default (no ?full) returns lite shape: workflow.summary inlined, nodes/edges empty", async () => {
    const sid = await seedSession();
    const res = await app.request(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chatNodes: Array<{
        workflow: {
          summary: { llmCount: number; lastModel?: string; contextTokens: number };
          nodes: unknown[];
          edges: unknown[];
        };
      }>;
    };
    expect(body.chatNodes.length).toBe(1);
    const wf = body.chatNodes[0].workflow;
    expect(wf.nodes).toEqual([]);
    expect(wf.edges).toEqual([]);
    expect(wf.summary.llmCount).toBe(1);
    expect(wf.summary.lastModel).toBe("claude-opus-4-7");
    expect(wf.summary.contextTokens).toBe(1244); // 10 + 1234
  });

  it("?full=true returns the legacy shape with workflow.nodes populated", async () => {
    const sid = await seedSession();
    const res = await app.request(`/api/sessions/${sid}?full=true`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chatNodes: Array<{
        workflow: { summary?: unknown; nodes: Array<{ kind: string }> };
      }>;
    };
    const wf = body.chatNodes[0].workflow;
    expect(wf.nodes.length).toBeGreaterThan(0);
    // summary still present (parser populated it before strip — the
    // full path returns the cached object as-is)
    expect(wf.summary).toBeDefined();
  });
});

// Batch workflow fetch — fills lazy clients in a single round-trip.
describe("GET /api/sessions/:id/chatnodes/workflows (v0.10 lazy ChatFlow)", () => {
  async function seedTwoTurns(): Promise<{ sid: string; cnIds: string[] }> {
    const projectDir = path.join(tmpRoot, "-home-user-Batch");
    const sid = "44444444-4444-4000-8000-000000000004";
    await writeJsonl(path.join(projectDir, `${sid}.jsonl`), [
      {
        type: "user",
        uuid: "u1",
        sessionId: sid,
        promptId: "p1",
        cwd: "/home/user/Batch",
        message: { role: "user", content: "first" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first reply" }],
          model: "claude-opus-4-7",
        },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        sessionId: sid,
        promptId: "p2",
        message: { role: "user", content: "second" },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "u2",
        sessionId: sid,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second reply" }],
          model: "claude-opus-4-7",
        },
      },
    ]);
    // Walk the lite endpoint to learn the ChatNode ids.
    const liteRes = await app.request(`/api/sessions/${sid}`);
    const lite = (await liteRes.json()) as { chatNodes: Array<{ id: string }> };
    return { sid, cnIds: lite.chatNodes.map((c) => c.id) };
  }

  it("returns nodes/edges keyed by ChatNode id for the requested ids", async () => {
    const { sid, cnIds } = await seedTwoTurns();
    expect(cnIds.length).toBe(2);
    const res = await app.request(
      `/api/sessions/${sid}/chatnodes/workflows?ids=${cnIds.join(",")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Record<string, { nodes: Array<{ kind: string }>; edges: unknown[] }>;
    };
    expect(Object.keys(body.workflows).sort()).toEqual([...cnIds].sort());
    for (const id of cnIds) {
      const wf = body.workflows[id];
      expect(Array.isArray(wf.nodes)).toBe(true);
      expect(wf.nodes.some((n) => n.kind === "llm_call")).toBe(true);
    }
  });

  it("omits unknown ids from the result (no error)", async () => {
    const { sid, cnIds } = await seedTwoTurns();
    const res = await app.request(
      `/api/sessions/${sid}/chatnodes/workflows?ids=${cnIds[0]},ghost-id-not-real`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Record<string, unknown> };
    expect(Object.keys(body.workflows)).toEqual([cnIds[0]]);
  });

  it("400s on empty ids query param", async () => {
    const sid = (await seedTwoTurns()).sid;
    const res = await app.request(
      `/api/sessions/${sid}/chatnodes/workflows?ids=`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id — fork closure merge (v0.8 M2)", () => {
  // Reuse the disk-resident fork-pair fixture so this exercises the
  // exact code paths a real session would hit (file system scan +
  // closure resolver + merge). The fixture lives in
  // src/parse/__fixtures__/synthetic/fork-pair/ — copy it into
  // tmpRoot's project subdir at test time so each test gets isolated
  // tmpdir behavior consistent with other endpoint tests.
  const ORIG_SID = "aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa";
  const FORK_SID = "bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb";
  const FIXTURE_DIR = path.resolve(
    __dirname,
    "..",
    "parse",
    "__fixtures__",
    "synthetic",
    "fork-pair",
  );

  async function copyForkPair(projectName: string): Promise<void> {
    const projectDir = path.join(tmpRoot, projectName);
    await fs.mkdir(projectDir, { recursive: true });
    for (const file of [`${ORIG_SID}.jsonl`, `${FORK_SID}.jsonl`]) {
      await fs.copyFile(
        path.join(FIXTURE_DIR, file),
        path.join(projectDir, file),
      );
    }
  }

  it("merges fork-pair into a single ChatFlow with sibling-fork sharing parent ChatNode", async () => {
    await copyForkPair("-home-dev-example");
    const res = await app.request(`/api/sessions/${FORK_SID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      chatNodes: Array<{ id: string; parentChatNodeId: string | null }>;
      linkedSessions?: string[];
      customTitle?: string;
    };
    // entry session id wins as the merged ChatFlow's id.
    expect(body.id).toBe(FORK_SID);
    // 4 ChatNodes: p1 + p2 + p3 (from original) + p4f (NEW in fork).
    const ids = body.chatNodes.map((c) => c.id).sort();
    expect(ids).toEqual(["p1", "p2", "p3", "p4f"]);
    // Sibling fork: p2 has TWO children (p3 from original, p4f from
    // fork), both sharing parentChatNodeId === "p2".
    const p3 = body.chatNodes.find((c) => c.id === "p3");
    const p4f = body.chatNodes.find((c) => c.id === "p4f");
    expect(p3?.parentChatNodeId).toBe("p2");
    expect(p4f?.parentChatNodeId).toBe("p2");
    // linkedSessions records both closure members (BFS order, entry
    // first — fork was the entry).
    expect(body.linkedSessions).toEqual(
      expect.arrayContaining([FORK_SID, ORIG_SID]),
    );
    expect(body.linkedSessions?.[0]).toBe(FORK_SID);
    // customTitle from fork's `{type:"custom-title"}` record.
    expect(body.customTitle).toBe("list files (Branch)");
  });

  it("loading the original session also returns the merged closure (descendant scan)", async () => {
    await copyForkPair("-home-dev-example2");
    const res = await app.request(`/api/sessions/${ORIG_SID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      chatNodes: Array<{ id: string }>;
      linkedSessions?: string[];
    };
    // Same 4 ChatNodes regardless of which side the user enters from
    // (consistent merged view per design choice 1A).
    const ids = body.chatNodes.map((c) => c.id).sort();
    expect(ids).toEqual(["p1", "p2", "p3", "p4f"]);
    // Entry now is original; closure still contains both.
    expect(body.id).toBe(ORIG_SID);
    expect(body.linkedSessions?.[0]).toBe(ORIG_SID);
  });

  it("uuid dedup keeps the first occurrence (original wins for shared records)", async () => {
    await copyForkPair("-home-dev-example3");
    const res = await app.request(`/api/sessions/${ORIG_SID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chatNodes: Array<{
        id: string;
        forkedFrom?: { sessionId: string; messageUuid: string };
      }>;
    };
    // p1 + p2 records exist in BOTH jsonls. When we enter from the
    // ORIGINAL (closure order: orig first), the original's records win
    // — they have NO forkedFrom marker, so the merged ChatNodes for p1
    // / p2 have forkedFrom === undefined.
    const p1 = body.chatNodes.find((c) => c.id === "p1");
    const p2 = body.chatNodes.find((c) => c.id === "p2");
    expect(p1?.forkedFrom).toBeUndefined();
    expect(p2?.forkedFrom).toBeUndefined();
  });

  it("non-fork session: linkedSessions stays undefined (degenerates to v0.7 path)", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Foo");
    const sid = "55555555-5555-4000-8000-000000000020";
    await writeJsonl(path.join(projectDir, `${sid}.jsonl`), [
      {
        type: "user",
        uuid: "u-only",
        sessionId: sid,
        promptId: "p-only",
        message: { role: "user", content: "alone" },
        timestamp: "2026-05-04T00:00:00.000Z",
      },
    ]);
    const res = await app.request(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkedSessions?: string[] };
    expect(body.linkedSessions).toBeUndefined();
  });
});

describe("GET /api/sessions/:id/tool-results/:refId", () => {
  // Minimum overflow file used across cases. We pick a size > the
  // 200 KB chunk threshold so tests can exercise both first-chunk +
  // continuation reads.
  const SID = "22222222-2222-4000-8000-000000000001";
  const PROJECT = "-home-user-Foo";
  const REF_ID = "abc_DEF-123";
  const PAYLOAD_BYTES = 250 * 1024; // > 200 KB chunk
  const PAYLOAD = Buffer.alloc(PAYLOAD_BYTES, "x");
  // Stamp a recognizable boundary marker at byte 200_000 so we can
  // verify the chunk start parameter actually advances the read.
  PAYLOAD.write("BOUNDARY", 200_000);

  beforeEach(async () => {
    const projectDir = path.join(tmpRoot, PROJECT);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, `${SID}.jsonl`),
      JSON.stringify({ type: "user", uuid: "u1", sessionId: SID }) + "\n",
    );
    const sidecarDir = path.join(projectDir, SID, "tool-results");
    await fs.mkdir(sidecarDir, { recursive: true });
    await fs.writeFile(path.join(sidecarDir, `${REF_ID}.txt`), PAYLOAD);
  });

  it("returns the first 200 KB chunk by default with totalSize + hasMore", async () => {
    const res = await app.request(`/api/sessions/${SID}/tool-results/${REF_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refId: string;
      content: string;
      start: number;
      end: number;
      totalSize: number;
      hasMore: boolean;
    };
    expect(body.refId).toBe(REF_ID);
    expect(body.start).toBe(0);
    expect(body.end).toBe(200 * 1024);
    expect(body.totalSize).toBe(PAYLOAD_BYTES);
    expect(body.hasMore).toBe(true);
    expect(Buffer.byteLength(body.content, "utf8")).toBe(200 * 1024);
  });

  it("?start advances the read so subsequent chunks pick up where the first ended", async () => {
    const res = await app.request(
      `/api/sessions/${SID}/tool-results/${REF_ID}?start=200000`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      start: number;
      end: number;
      hasMore: boolean;
    };
    expect(body.start).toBe(200_000);
    expect(body.end).toBe(PAYLOAD_BYTES);
    expect(body.hasMore).toBe(false);
    // The boundary marker we stamped at byte 200_000 must be at the
    // very front of this chunk's content.
    expect(body.content.startsWith("BOUNDARY")).toBe(true);
  });

  it("404s when the refId doesn't exist on disk", async () => {
    const res = await app.request(
      `/api/sessions/${SID}/tool-results/no_such_ref`,
    );
    expect(res.status).toBe(404);
  });

  it("404s when the session itself doesn't exist", async () => {
    const res = await app.request(
      `/api/sessions/00000000-0000-4000-8000-deadbeef0000/tool-results/${REF_ID}`,
    );
    expect(res.status).toBe(404);
  });

  it("400s on a refId that contains path-traversal characters (rejected by zod)", async () => {
    // ``..`` and ``/`` and dots are not in [A-Za-z0-9_-]. Hono's
    // zValidator returns 400 on schema violation.
    const res = await app.request(
      `/api/sessions/${SID}/tool-results/${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });

  it("416s when ?start exceeds the file size", async () => {
    const res = await app.request(
      `/api/sessions/${SID}/tool-results/${REF_ID}?start=999999999`,
    );
    expect(res.status).toBe(416);
  });

  it("400s on malformed ?start", async () => {
    const res = await app.request(
      `/api/sessions/${SID}/tool-results/${REF_ID}?start=oops`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id/subagents/:agentId", () => {
  const SID = "33333333-3333-4000-8000-000000000001";
  const PROJECT = "-home-user-Foo";
  const AGENT_ID = "abc123def456";

  // Tiny but parseable sub-agent jsonl: one user prompt + one
  // assistant reply, all marked isSidechain:true (matches CC's
  // recordSidechainTranscript invariant).
  const subAgentJsonl = [
    {
      type: "user",
      uuid: "su1",
      sessionId: SID,
      promptId: "sp1",
      isSidechain: true,
      message: { role: "user", content: "Find perf hot spots." },
      timestamp: "2026-05-03T00:00:00.000Z",
    },
    {
      type: "assistant",
      uuid: "sa1",
      parentUuid: "su1",
      sessionId: SID,
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Three hot spots identified." }],
        stop_reason: "end_turn",
      },
      timestamp: "2026-05-03T00:00:01.000Z",
    },
  ];
  const META = {
    agentType: "Explore",
    description: "Find perf hot spots",
  };

  beforeEach(async () => {
    const projectDir = path.join(tmpRoot, PROJECT);
    await fs.mkdir(projectDir, { recursive: true });
    await writeJsonl(path.join(projectDir, `${SID}.jsonl`), [
      { type: "user", uuid: "u1", sessionId: SID, promptId: "p1", message: { content: "hi" } },
    ]);
    const subagentsDir = path.join(projectDir, SID, "subagents");
    await fs.mkdir(subagentsDir, { recursive: true });
    await writeJsonl(path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`), subAgentJsonl);
    await fs.writeFile(
      path.join(subagentsDir, `agent-${AGENT_ID}.meta.json`),
      JSON.stringify(META),
    );
  });

  it("returns the parsed sub-agent ChatFlow + meta on happy path", async () => {
    const res = await app.request(`/api/sessions/${SID}/subagents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentId: string;
      subdir: string | null;
      chatFlow: { chatNodes: unknown[] };
      meta: { agentType: string; description?: string } | null;
    };
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.subdir).toBeNull();
    expect(body.chatFlow.chatNodes.length).toBeGreaterThan(0);
    expect(body.meta?.agentType).toBe("Explore");
  });

  it("returns meta=null when meta.json is missing (older CC versions)", async () => {
    await fs.rm(
      path.join(tmpRoot, PROJECT, SID, "subagents", `agent-${AGENT_ID}.meta.json`),
    );
    const res = await app.request(`/api/sessions/${SID}/subagents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: unknown };
    expect(body.meta).toBeNull();
  });

  it("supports the optional ?subdir param for grouped runs", async () => {
    const groupedDir = path.join(
      tmpRoot,
      PROJECT,
      SID,
      "subagents",
      "workflow_run_x",
    );
    await fs.mkdir(groupedDir, { recursive: true });
    await writeJsonl(path.join(groupedDir, `agent-${AGENT_ID}.jsonl`), subAgentJsonl);
    const res = await app.request(
      `/api/sessions/${SID}/subagents/${AGENT_ID}?subdir=workflow_run_x`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subdir: string | null };
    expect(body.subdir).toBe("workflow_run_x");
  });

  it("404s when the sub-agent jsonl doesn't exist", async () => {
    const res = await app.request(`/api/sessions/${SID}/subagents/no_such_agent`);
    expect(res.status).toBe(404);
  });

  it("404s when the session itself doesn't exist", async () => {
    const res = await app.request(
      `/api/sessions/00000000-0000-4000-8000-deadbeef0000/subagents/${AGENT_ID}`,
    );
    expect(res.status).toBe(404);
  });

  it("400s on agentId with path-traversal characters", async () => {
    const res = await app.request(
      `/api/sessions/${SID}/subagents/${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });

  it("400s on subdir with path-traversal characters", async () => {
    const res = await app.request(
      `/api/sessions/${SID}/subagents/${AGENT_ID}?subdir=${encodeURIComponent("../sneaky")}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("CSRF middleware", () => {
  it("rejects POST without X-Loomscope-Token", async () => {
    const res = await app.request("/api/health", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("rejects POST with wrong token", async () => {
    const res = await app.request("/api/health", {
      method: "POST",
      headers: { "x-loomscope-token": "bogus" },
    });
    expect(res.status).toBe(403);
  });

  // v1.6: /api/fs/* (validate-cwd + mkdir) is on the prefix bypass —
  // same Mode A rationale as /api/sessions/*. Without this bypass the
  // new-session modal couldn't validate the cwd or create dirs.
  it("does NOT 403 /api/fs/validate-cwd without a token", async () => {
    const res = await app.request("/api/fs/validate-cwd", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ path: "/tmp" }),
    });
    expect(res.status).not.toBe(403);
  });
});

describe("CORS middleware", () => {
  it("rejects cross-origin requests", async () => {
    const res = await app.request("/api/health", {
      headers: { origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  it("passes same-origin requests", async () => {
    const res = await app.request("/api/health", { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
  });

  it("supports comma-separated allowedOrigin list (dev mode 5174 + 5175)", async () => {
    // v∞.0 PR 3 fix: in dev, Vite at 5175 proxies to Hono at 5174 but
    // browser POSTs carry Origin: localhost:5175. CORS must accept
    // both ports without weakening prod (which still uses one).
    const dualApp = createApp({
      rootDir: tmpRoot,
      csrfToken: TOKEN,
      allowedOrigin: "http://localhost:5174,http://localhost:5175",
      hookSecret: HOOK_SECRET,
    });
    const r5174 = await dualApp.request("/api/health", {
      headers: { origin: "http://localhost:5174" },
    });
    expect(r5174.status).toBe(200);
    expect(r5174.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5174",
    );
    const r5175 = await dualApp.request("/api/health", {
      headers: { origin: "http://localhost:5175" },
    });
    expect(r5175.status).toBe(200);
    expect(r5175.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5175",
    );
    // Origin not in the list still gets rejected.
    const rOther = await dualApp.request("/api/health", {
      headers: { origin: "http://localhost:9999" },
    });
    expect(rOther.status).toBe(403);
  });
});

// v0.10 收尾 / v0.11 prep: incremental parser through the route layer.
// Verifies that an SSE-equivalent re-parse (= LRU miss after the file
// grew) goes through the per-session state stash so we don't re-read
// the entire jsonl. Hermetic — _resetForTests clears both LRU and
// stash so the assertions don't leak across cases.
describe("GET /api/sessions/:id — incremental parse on append", () => {
  let _resetCache: () => void;
  let _peekStash: () => string[];
  beforeEach(async () => {
    const mod = await import("@/server/services/chatFlowCache");
    _resetCache = mod._resetForTests;
    _peekStash = mod._peekStashKeysForTests;
    _resetCache();
  });

  it("populates the per-session state stash on first parse, reuses it after append", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-INCR");
    const sid = "44444444-4444-4000-8000-000000000004";
    const filePath = path.join(projectDir, `${sid}.jsonl`);
    await writeJsonl(filePath, [
      {
        type: "user",
        uuid: "u1",
        sessionId: sid,
        promptId: "p1",
        cwd: "/home/user/INCR",
        message: { role: "user", content: "first" },
        timestamp: "2026-05-08T00:00:00.000Z",
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        },
        timestamp: "2026-05-08T00:00:01.000Z",
      },
    ]);

    // First request — full parse, state stash populated.
    const r1 = await app.request(`/api/sessions/${sid}`);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { chatNodes: unknown[] };
    expect(b1.chatNodes.length).toBe(1);
    expect(_peekStash()).toContain(sid);

    // Append a second turn. Bumping mtime so LRU misses + stash is
    // consulted.
    await new Promise((res) => setTimeout(res, 10));
    await fs.appendFile(
      filePath,
      [
        {
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          sessionId: sid,
          promptId: "p2",
          message: { role: "user", content: "second" },
          timestamp: "2026-05-08T00:00:02.000Z",
        },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          sessionId: sid,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok2" }],
            stop_reason: "end_turn",
          },
          timestamp: "2026-05-08T00:00:03.000Z",
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );

    const r2 = await app.request(`/api/sessions/${sid}`);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { chatNodes: Array<{ id: string }> };
    expect(b2.chatNodes.length).toBe(2);
    // The stash now reflects the larger file.
    expect(_peekStash()).toContain(sid);
  });

  it("file shrunk (truncation/rewrite) → stash falls back to full parse on the next request", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-INCR2");
    const sid = "55555555-5555-4000-8000-000000000005";
    const filePath = path.join(projectDir, `${sid}.jsonl`);
    // Large initial file.
    await writeJsonl(
      filePath,
      Array.from({ length: 6 }, (_, i) => ({
        type: "user",
        uuid: `u${i}`,
        sessionId: sid,
        promptId: `p${i}`,
        cwd: "/home/user/INCR2",
        message: { role: "user", content: `msg ${i}` },
        timestamp: `2026-05-08T00:00:${String(i).padStart(2, "0")}.000Z`,
      })),
    );
    const r1 = await app.request(`/api/sessions/${sid}`);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { chatNodes: unknown[] };
    expect(b1.chatNodes.length).toBe(6);

    // Replace file with strictly smaller content (rewrite). Incremental
    // would diverge from truth — it should fall back to a full parse.
    await new Promise((res) => setTimeout(res, 10));
    await writeJsonl(filePath, [
      {
        type: "user",
        uuid: "only",
        sessionId: sid,
        promptId: "only",
        cwd: "/home/user/INCR2",
        message: { role: "user", content: "smaller" },
        timestamp: "2026-05-08T00:01:00.000Z",
      },
    ]);
    const r2 = await app.request(`/api/sessions/${sid}`);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { chatNodes: Array<{ id: string }> };
    expect(b2.chatNodes.length).toBe(1);
  });
});
