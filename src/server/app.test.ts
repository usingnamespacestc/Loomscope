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
