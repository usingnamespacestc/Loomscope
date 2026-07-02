// v2.6 security batch: apiFetch (CSRF-token-carrying fetch wrapper).
// 中: apiFetch 单测——token 缓存、GET 透传、服务重启后 403 刷新重试
// 一次、真拒绝(token 未变)不无限重试。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCsrfTokenForTests, apiFetch } from "./http";

type Call = { url: string; init?: RequestInit };

function tokenResponse(token: string): Response {
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("apiFetch", () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    _resetCsrfTokenForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  function stub(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      }),
    );
  }

  function sentToken(init?: RequestInit): string | null {
    return new Headers(init?.headers).get("x-loomscope-token");
  }

  it("GET passes through without a token probe", async () => {
    stub(() => new Response("{}", { status: 200 }));
    await apiFetch("/api/workspaces");
    expect(calls.map((c) => c.url)).toEqual(["/api/workspaces"]);
  });

  it("first mutation probes the token once, then caches it", async () => {
    stub((url) =>
      url === "/api/csrf-token"
        ? tokenResponse("tok-1")
        : new Response(null, { status: 204 }),
    );
    await apiFetch("/api/x", { method: "POST" });
    await apiFetch("/api/y", { method: "PATCH" });
    const urls = calls.map((c) => c.url);
    expect(urls).toEqual(["/api/csrf-token", "/api/x", "/api/y"]);
    expect(sentToken(calls[1].init)).toBe("tok-1");
    expect(sentToken(calls[2].init)).toBe("tok-1");
  });

  it("on 403 with a ROTATED token (server restart) refreshes and retries once", async () => {
    let phase = 0;
    stub((url, init) => {
      if (url === "/api/csrf-token") {
        phase += 1;
        return tokenResponse(phase === 1 ? "old" : "new");
      }
      return sentToken(init) === "new"
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 403 });
    });
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(204);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/csrf-token",
      "/api/x",
      "/api/csrf-token",
      "/api/x",
    ]);
  });

  it("on a GENUINE 403 (token unchanged) returns the 403 without endless retries", async () => {
    stub((url) =>
      url === "/api/csrf-token"
        ? tokenResponse("same")
        : new Response(null, { status: 403 }),
    );
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(403);
    // probe, attempt, re-probe — then give up (no second attempt).
    expect(calls.map((c) => c.url)).toEqual([
      "/api/csrf-token",
      "/api/x",
      "/api/csrf-token",
    ]);
  });

  it("token endpoint unreachable → mutation still goes out, headerless", async () => {
    stub((url) =>
      url === "/api/csrf-token"
        ? new Response(null, { status: 500 })
        : new Response(null, { status: 204 }),
    );
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(204);
    expect(sentToken(calls[1].init)).toBeNull();
  });
});
