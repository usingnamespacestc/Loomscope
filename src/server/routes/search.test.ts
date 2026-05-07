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

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";
const SECRET = "a".repeat(64);

const SESSION_ID = "abcdef00-1111-2222-3333-444444444444";
const CHATNODE_ID = "01234567-1111-2222-3333-444444444444";
const ROOT_USER_UUID = "11111111-aaaa-bbbb-cccc-dddddddddddd";
const ASSISTANT_UUID = "22222222-aaaa-bbbb-cccc-dddddddddddd";

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
        content: [{ type: "text", text: "an answer" }],
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

  it("rejects non-hex input with invalid flag", async () => {
    const { status, body } = await search("notHexInputAtAll");
    expect(status).toBe(200);
    expect(body.invalid).toBe(true);
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
});
