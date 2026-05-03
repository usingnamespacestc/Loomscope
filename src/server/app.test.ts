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

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-app-test-"));
  app = createApp({ rootDir: tmpRoot, csrfToken: TOKEN, allowedOrigin: ORIGIN });
});

afterEach(async () => {
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

  it("404s for an unknown session id", async () => {
    const res = await app.request("/api/sessions/00000000-0000-4000-8000-deadbeef0000");
    expect(res.status).toBe(404);
  });

  it("400s on a malformed session id", async () => {
    const res = await app.request("/api/sessions/not-a-uuid");
    expect(res.status).toBe(400);
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
});
