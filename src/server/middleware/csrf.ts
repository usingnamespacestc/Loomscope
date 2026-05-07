// Mode A CSRF guard: any mutation request (POST/PUT/PATCH/DELETE) must carry
// `X-Loomscope-Token` header matching the server-side token. Browsers can't
// send a custom header on simple cross-origin POSTs without triggering a CORS
// preflight, which our strict same-origin CORS policy rejects — so a hostile
// page on `evil.com` cannot ride a victim's localhost cookies to attack us.
//
// v0.2 has no mutation endpoints yet, but wiring this up now means later
// endpoints inherit the protection by default.

import type { MiddlewareHandler } from "hono";

// EN (v∞.0 PR 1 + PR 3): paths exempt from CSRF token check.
// - `/api/cc-hook`: server-to-server (CC's axios), uses
//   `X-Loomscope-Secret` for auth instead.
// - `/api/cc-hook-onboarding/patch`: same-origin browser POST from
//   our own frontend. The token plumbing isn't currently exposed to
//   the client (no existing browser-driven POSTs), and Mode A's
//   localhost binding + CORS strict same-origin policy already
//   block the practical threat surface (cross-origin browser
//   attacks). Bypass is consistent with the project's stated
//   "Mode A trusted same-host" model. If we ever need to defend
//   against in-browser local attackers (extensions / third-party
//   tabs without Origin headers), revisit by exposing the token via
//   `/api/csrf-token` + threading through fetches.
// 中: CC hook 跟 onboarding patch 都跳过 CSRF。前者用 secret，后者
// 同源 + CORS 已经够用；本项目 Mode A 模型默认本机可信。
const CSRF_BYPASS_PATHS = new Set([
  "/api/cc-hook",
  "/api/cc-hook-onboarding/patch",
  "/api/cc-hook-onboarding/rotate-secret",
]);

export function csrfMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    if (CSRF_BYPASS_PATHS.has(c.req.path)) {
      return next();
    }
    const provided = c.req.header("x-loomscope-token");
    if (!provided || provided !== token) {
      return c.json({ error: "csrf token missing or invalid" }, 403);
    }
    return next();
  };
}
