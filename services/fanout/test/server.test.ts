// End-to-end test of the Hono app — drives it via `app.request(...)`
// without a listener. Mock fetcher simulates the upstreams so we can
// observe both the inbound request handling and the outbound fanout
// from one place.

import { describe, expect, it, vi } from "vitest";

import type { FanoutConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const SECRET = "test-secret";
const WRONG_SECRET = "nope";

function makeConfig(overrides: Partial<FanoutConfig> = {}): FanoutConfig {
  return {
    port: 5174,
    hostname: "0.0.0.0",
    upstreams: ["http://a", "http://b"],
    secret: SECRET,
    preToolUseDecisiveTimeoutMs: 1000,
    ...overrides,
  };
}

function allowResponse(): Response {
  return new Response(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("GET /api/health", () => {
  it("reports plumbing state without secret", async () => {
    const app = createApp(makeConfig());
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      role: string;
      upstreams: number;
    };
    expect(body.ok).toBe(true);
    expect(body.role).toBe("fanout");
    expect(body.upstreams).toBe(2);
  });
});

describe("POST /api/cc-hook — auth", () => {
  it("403 without secret", async () => {
    const app = createApp(makeConfig(), { fetcher: vi.fn() });
    const res = await app.request(
      "/api/cc-hook?event=PostToolUse",
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(403);
  });

  it("403 with wrong secret", async () => {
    const app = createApp(makeConfig(), { fetcher: vi.fn() });
    const res = await app.request("/api/cc-hook?event=PostToolUse", {
      method: "POST",
      body: "{}",
      headers: { "X-Loomscope-Secret": WRONG_SECRET },
    });
    expect(res.status).toBe(403);
  });

  it("constant-time check tolerates length mismatch without leaking", async () => {
    // Just smoke that a way-too-short secret still returns 403 (length
    // mismatch fast path). Real timing is hard to assert from a test,
    // but the implementation early-returns on length mismatch which
    // we already covered above.
    const app = createApp(makeConfig(), { fetcher: vi.fn() });
    const res = await app.request("/api/cc-hook?event=PostToolUse", {
      method: "POST",
      body: "{}",
      headers: { "X-Loomscope-Secret": "x" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/cc-hook — schema", () => {
  it("400 when event query param is missing", async () => {
    const app = createApp(makeConfig(), { fetcher: vi.fn() });
    const res = await app.request("/api/cc-hook", {
      method: "POST",
      body: "{}",
      headers: { "X-Loomscope-Secret": SECRET },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cc-hook — fire-and-forget events", () => {
  it("PostToolUse: 204 immediately + fans to all upstreams", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = vi.fn().mockImplementation(async (input) => {
      calls.push(input.toString());
      return new Response(null, { status: 204 });
    });
    const app = createApp(makeConfig(), { fetcher });

    const res = await app.request("/api/cc-hook?event=PostToolUse", {
      method: "POST",
      body: JSON.stringify({ session_id: "s1" }),
      headers: { "X-Loomscope-Secret": SECRET },
    });

    expect(res.status).toBe(204);
    // Wait for the void promises inside the route to settle.
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(2);
    for (const url of calls) {
      expect(url).toContain("/api/cc-hook?event=PostToolUse");
    }
  });

  it("forwards the secret to upstreams via X-Loomscope-Secret header", async () => {
    const seenHeaders: Headers[] = [];
    const fetcher: typeof fetch = vi.fn().mockImplementation(async (_input, init) => {
      seenHeaders.push(new Headers((init as RequestInit)?.headers ?? {}));
      return new Response(null, { status: 204 });
    });
    const app = createApp(makeConfig(), { fetcher });

    await app.request("/api/cc-hook?event=SessionStart", {
      method: "POST",
      body: "{}",
      headers: { "X-Loomscope-Secret": SECRET },
    });

    await new Promise((r) => setImmediate(r));
    expect(seenHeaders).toHaveLength(2);
    for (const h of seenHeaders) {
      expect(h.get("X-Loomscope-Secret")).toBe(SECRET);
    }
  });

  it("passes the request body through verbatim (no parsing)", async () => {
    const seenBodies: string[] = [];
    const fetcher: typeof fetch = vi.fn().mockImplementation(async (_input, init) => {
      const body = (init as RequestInit)?.body;
      seenBodies.push(typeof body === "string" ? body : "");
      return new Response(null, { status: 204 });
    });
    const app = createApp(makeConfig(), { fetcher });

    const payload = JSON.stringify({
      session_id: "abc",
      tool_input: { command: "ls -la /tmp" },
      extras: { nested: { thing: 42 } },
    });
    await app.request("/api/cc-hook?event=PostToolUse", {
      method: "POST",
      body: payload,
      headers: { "X-Loomscope-Secret": SECRET },
    });

    await new Promise((r) => setImmediate(r));
    for (const b of seenBodies) {
      expect(b).toBe(payload);
    }
  });
});

describe("POST /api/cc-hook — PreToolUse race", () => {
  it("returns the winning upstream's body + status to CC", async () => {
    const fetcher: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(allowResponse())
      .mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );
    const app = createApp(makeConfig(), { fetcher });

    const res = await app.request("/api/cc-hook?event=PreToolUse", {
      method: "POST",
      body: JSON.stringify({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      headers: { "X-Loomscope-Secret": SECRET },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(json.hookSpecificOutput?.permissionDecision).toBe("allow");
  });

  it("204 to CC when all upstreams non-decisive (fall back to terminal prompt)", async () => {
    const fetcher: typeof fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const app = createApp(makeConfig(), { fetcher });

    const res = await app.request("/api/cc-hook?event=PreToolUse", {
      method: "POST",
      body: JSON.stringify({ session_id: "s2" }),
      headers: { "X-Loomscope-Secret": SECRET },
    });

    expect(res.status).toBe(204);
  });
});
