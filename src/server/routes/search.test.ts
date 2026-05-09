// @vitest-environment node
//
// Search endpoint — hex-prefix lookup over the project tree, returning
// up to MAX_HITS candidates classified as session / chatnode / worknode.
// Hermetic: a tmpRoot with a synthetic project dir + jsonl. Drives the
// Hono app directly via app.request (no listener).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { _setCacheRootForTests } from "@/server/services/chatFlowDiskCache";
import { TrashService } from "@/server/services/trash";

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";
const SECRET = "a".repeat(64);

const SESSION_ID = "abcdef00-1111-2222-3333-444444444444";
const CHATNODE_ID = "01234567-1111-2222-3333-444444444444";
const ROOT_USER_UUID = "11111111-aaaa-bbbb-cccc-dddddddddddd";
const ASSISTANT_UUID = "22222222-aaaa-bbbb-cccc-dddddddddddd";
const TOOL_USE_ID = "toolu_01V1fLQA8TEH78ynQtTNjBjb";
const TOOL_RESULT_USER_UUID = "33333333-aaaa-bbbb-cccc-dddddddddddd";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-search-"));
  _setCacheRootForTests(path.join(tmpRoot, "disk-cache"));
  // Fixture: one project dir with one jsonl containing one user
  // record (with promptId = CHATNODE_ID) and one assistant record.
  const projectDir = path.join(tmpRoot, "-tmp-fixture");
  await fs.mkdir(projectDir, { recursive: true });
  const lines = [
    {
      type: "user",
      uuid: ROOT_USER_UUID,
      promptId: CHATNODE_ID,
      message: { role: "user", content: "hello world prompt" },
    },
    {
      type: "assistant",
      uuid: ASSISTANT_UUID,
      parentUuid: ROOT_USER_UUID,
      message: {
        id: "msg_test",
        role: "assistant",
        content: [
          { type: "text", text: "an answer" },
          {
            type: "tool_use",
            id: TOOL_USE_ID,
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: TOOL_RESULT_USER_UUID,
      promptId: CHATNODE_ID,
      parentUuid: ASSISTANT_UUID,
      toolUseResult: { stdout: "ok" },
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: TOOL_USE_ID, content: "ok" },
        ],
      },
    },
  ];
  await fs.writeFile(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  app = createApp({
    rootDir: tmpRoot,
    csrfToken: TOKEN,
    allowedOrigin: ORIGIN,
    hookSecret: SECRET,
  });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function search(q: string) {
  const res = await app.request(`/api/search/uuid?q=${encodeURIComponent(q)}`, {
    headers: { "X-CSRF-Token": TOKEN, origin: ORIGIN },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("/api/search/uuid", () => {
  it("rejects too-short prefix (< 8 hex chars) with tooShort flag", async () => {
    const { status, body } = await search("abc");
    expect(status).toBe(200);
    expect(body.tooShort).toBe(true);
    expect(body.hits).toEqual([]);
  });

  it("non-hex input is allowed (no invalid flag) — falls back to 0 hits if nothing matches", async () => {
    // Per latest design: jump mode trusts user intent; only length
    // gating remains. Inputs like "Loomscope" simply yield 0 hits
    // when nothing matches, no upfront rejection.
    const { status, body } = await search("notHexInputAtAll");
    expect(status).toBe(200);
    expect(body.invalid).toBeUndefined();
    expect(body.hits).toEqual([]);
  });

  it("matches session id by 8-char prefix → session hit", async () => {
    const { body } = await search(SESSION_ID.slice(0, 8));
    const hits = body.hits as Array<Record<string, unknown>>;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const sessionHit = hits.find((h) => h.type === "session");
    expect(sessionHit).toBeTruthy();
    expect(sessionHit?.sessionId).toBe(SESSION_ID);
  });

  it("matches ChatNode by promptId prefix → chatnode hit + preview", async () => {
    const { body } = await search(CHATNODE_ID.slice(0, 8));
    const hits = body.hits as Array<Record<string, unknown>>;
    const chatHit = hits.find((h) => h.type === "chatnode");
    expect(chatHit).toBeTruthy();
    expect(chatHit?.chatNodeId).toBe(CHATNODE_ID);
    expect(chatHit?.preview).toContain("hello world");
  });

  it("matches WorkNode (assistant record uuid) → worknode hit + kindHint", async () => {
    const { body } = await search(ASSISTANT_UUID.slice(0, 8));
    const hits = body.hits as Array<Record<string, unknown>>;
    const workHit = hits.find((h) => h.type === "worknode");
    expect(workHit).toBeTruthy();
    expect(workHit?.workNodeId).toBe(ASSISTANT_UUID);
    expect(workHit?.kindHint).toBe("assistant");
    expect(workHit?.preview).toContain("an answer");
  });

  it("matches root user record uuid → worknode hit (kindHint=user)", async () => {
    const { body } = await search(ROOT_USER_UUID.slice(0, 8));
    const hits = body.hits as Array<Record<string, unknown>>;
    // The root user record has BOTH a uuid and a promptId. The grep
    // pattern `"uuid":` matches its uuid line; the chatnode entry
    // would only appear via `"promptId":` which doesn't match this
    // prefix. So this is a worknode hit.
    expect(hits.find((h) => h.workNodeId === ROOT_USER_UUID)).toBeTruthy();
  });

  it("returns full uuid as exact match (subset of 8+ char prefix path)", async () => {
    const { body } = await search(CHATNODE_ID);
    const hits = body.hits as Array<Record<string, unknown>>;
    const chatHit = hits.find((h) => h.chatNodeId === CHATNODE_ID);
    expect(chatHit).toBeTruthy();
  });

  it("returns no hits + truncated:false when prefix doesn't exist", async () => {
    const { body } = await search("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(body.hits).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it("matches Anthropic tool_use id (toolu_…) → worknode hit with parentChatNodeId resolved", async () => {
    const { body } = await search(TOOL_USE_ID);
    const hits = body.hits as Array<Record<string, unknown>>;
    const workHit = hits.find(
      (h) => h.type === "worknode" && h.workNodeId === TOOL_USE_ID,
    );
    expect(workHit).toBeTruthy();
    expect(workHit?.kindHint).toBe("tool_use");
    // Parent ChatNode id is resolved via the second-pass parse (the
    // assistant record carrying the tool_use block lacks promptId on
    // disk, so the cheap inline path doesn't fill it).
    expect(workHit?.parentChatNodeId).toBe(CHATNODE_ID);
    expect(workHit?.preview).toContain("Bash");
  });

  it("matches assistant record uuid → worknode with parentChatNodeId resolved (assistant has no promptId on disk)", async () => {
    const { body } = await search(ASSISTANT_UUID.slice(0, 8));
    const hits = body.hits as Array<Record<string, unknown>>;
    const workHit = hits.find(
      (h) => h.type === "worknode" && h.workNodeId === ASSISTANT_UUID,
    );
    expect(workHit).toBeTruthy();
    // Backend should have resolved parentChatNodeId via second-pass parse.
    expect(workHit?.parentChatNodeId).toBe(CHATNODE_ID);
  });

  // Trash exclusion regression — search must never surface trashed
  // sessions. Structural guarantee: TrashService physically moves
  // the jsonl out of rootDir into a sibling trashDir; search.ts
  // only ever reads from rootDir, so post-trash there's no candidate
  // file to grep. This test pins that invariant by trashing the
  // fixture and asserting all search modes go cold.
  describe("trash exclusion", () => {
    let trashDir: string;
    let trash: TrashService;

    beforeEach(async () => {
      trashDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "loomscope-search-trash-"),
      );
      trash = new TrashService({
        trashDir,
        // Search test doesn't care about meta detail — return shape
        // matching workspaceScanner's contract.
        extractMeta: async () => ({
          title: "fixture",
          messageCount: 3,
          cwd: "/tmp/fixture",
        }),
      });
    });

    afterEach(async () => {
      await fs.rm(trashDir, { recursive: true, force: true });
    });

    it("returns 0 hits for trashed session id, ChatNode id, and WorkNode uuid", async () => {
      // Sanity: pre-trash all three kinds of hits exist.
      const pre = await search(SESSION_ID.slice(0, 8));
      expect((pre.body.hits as unknown[]).length).toBeGreaterThan(0);

      // Trash the fixture session.
      await trash.trash(tmpRoot, SESSION_ID);

      // Post-trash: jsonl is gone from rootDir → search has no
      // candidate file to scan. All three lookup modes (session id /
      // ChatNode promptId / WorkNode uuid) must come back empty.
      const sessionMiss = await search(SESSION_ID.slice(0, 8));
      expect(sessionMiss.body.hits).toEqual([]);

      const chatMiss = await search(CHATNODE_ID.slice(0, 8));
      expect(chatMiss.body.hits).toEqual([]);

      const workMiss = await search(ASSISTANT_UUID.slice(0, 8));
      expect(workMiss.body.hits).toEqual([]);

      const toolMiss = await search(TOOL_USE_ID);
      expect(toolMiss.body.hits).toEqual([]);
    });
  });
});
