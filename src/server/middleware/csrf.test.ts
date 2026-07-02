// Pins the CSRF bypass allowlist — the security-load-bearing surface
// that decides which mutating endpoints skip the token check. The
// expected bypass paths/prefixes are intentionally re-declared here
// (NOT imported from the middleware) so that changing the middleware's
// list without consciously updating this test fails CI: any new bypass
// must be a deliberate, reviewed decision.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { csrfMiddleware } from "@/server/middleware/csrf";

const TOKEN = "csrf-token-fixture";

function makeApp() {
  const app = new Hono();
  app.use("*", csrfMiddleware(TOKEN));
  app.all("/*", (c) => c.text("passed"));
  return app;
}

// The exact set the middleware is expected to bypass, mirrored here.
// v2.6 security batch (backlog #16): narrowed to the server-to-server
// cc-hook surface only — every browser mutation now carries the token
// via apiFetch (src/api/http.ts).
// 中: v2.6 收窄——只剩 server-to-server 的 cc-hook 面;浏览器变更
// 请求一律经 apiFetch 带 token。
const EXPECTED_BYPASS_PATHS = [
  "/api/cc-hook",
  "/api/cc-hook/decision",
];
const EXPECTED_BYPASS_PREFIXES = [
  "/api/cc-hook/",
];

// Routes that USED to be on the bypass list and must now require the
// token — pinned so a future "convenience" re-broadening fails CI.
// 中: 曾在 bypass 名单、现在必须带 token 的路由,钉死防止回宽。
const MUST_REQUIRE_TOKEN = [
  "/api/sessions/deadbeef/turns",
  "/api/sessions/new",
  "/api/preferences",
  "/api/permission-rules",
  "/api/trash/empty",
  "/api/fs/mkdir",
  "/api/cc-hook-onboarding/patch",
  "/api/cc-hook-onboarding/rotate-secret",
];

async function post(app: ReturnType<typeof makeApp>, path: string, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: token ? { "x-loomscope-token": token } : {},
  });
}

describe("csrfMiddleware — bypass allowlist", () => {
  it("lets all safe methods through without a token", async () => {
    const app = makeApp();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await app.request("/api/anything", { method });
      expect(res.status).toBe(200);
    }
  });

  it("rejects a non-bypassed mutation without a valid token", async () => {
    const app = makeApp();
    expect((await post(app, "/api/not-bypassed")).status).toBe(403);
    expect((await post(app, "/api/not-bypassed", "wrong")).status).toBe(403);
    expect((await post(app, "/api/not-bypassed", TOKEN)).status).toBe(200);
  });

  it("bypasses every exact-match path in the allowlist (no token)", async () => {
    const app = makeApp();
    for (const p of EXPECTED_BYPASS_PATHS) {
      expect((await post(app, p)).status).toBe(200);
    }
  });

  it("bypasses every prefix in the allowlist, including sub-paths (no token)", async () => {
    const app = makeApp();
    for (const prefix of EXPECTED_BYPASS_PREFIXES) {
      expect((await post(app, prefix)).status).toBe(200);
      expect((await post(app, `${prefix}dismiss-prompt/x`)).status).toBe(200);
    }
  });

  it("requires the token on every formerly-bypassed browser route", async () => {
    const app = makeApp();
    for (const p of MUST_REQUIRE_TOKEN) {
      expect((await post(app, p)).status).toBe(403);
      expect((await post(app, p, TOKEN)).status).toBe(200);
    }
  });

  it("does NOT bypass a path that only resembles a bypass prefix", async () => {
    const app = makeApp();
    expect((await post(app, "/api/cc-hookX")).status).toBe(403);
    // CRITICAL: the "/api/cc-hook/" prefix must NOT wave through the
    // onboarding namespace (browser POSTs; rotate-secret rotates the
    // hook secret). A bare "/api/cc-hook" prefix would.
    // 中: 前缀带尾斜杠,不能连 onboarding 一起放行。
    expect(
      (await post(app, "/api/cc-hook-onboarding/rotate-secret")).status,
    ).toBe(403);
  });
});
