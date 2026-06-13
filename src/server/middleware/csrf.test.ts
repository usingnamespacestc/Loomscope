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
const EXPECTED_BYPASS_PATHS = [
  "/api/cc-hook",
  "/api/cc-hook/decision",
  "/api/cc-hook-onboarding/patch",
  "/api/cc-hook-onboarding/rotate-secret",
];
const EXPECTED_BYPASS_PREFIXES = [
  "/api/sessions/",
  "/api/preferences",
  "/api/permission-rules",
  "/api/trash",
  "/api/fs/",
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
      expect((await post(app, `${prefix}deadbeef/turns`)).status).toBe(200);
    }
  });

  it("does NOT bypass a path that only resembles a bypass prefix", async () => {
    const app = makeApp();
    // "/api/sessions/" requires the trailing slash — "/api/sessionsX"
    // is a different namespace and must still carry the token.
    expect((await post(app, "/api/sessionsX")).status).toBe(403);
    expect((await post(app, "/api/cc-hookX")).status).toBe(403);
  });
});
