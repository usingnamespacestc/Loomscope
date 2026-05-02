// Mode A CSRF guard: any mutation request (POST/PUT/PATCH/DELETE) must carry
// `X-Loomscope-Token` header matching the server-side token. Browsers can't
// send a custom header on simple cross-origin POSTs without triggering a CORS
// preflight, which our strict same-origin CORS policy rejects — so a hostile
// page on `evil.com` cannot ride a victim's localhost cookies to attack us.
//
// v0.2 has no mutation endpoints yet, but wiring this up now means later
// endpoints inherit the protection by default.

import type { MiddlewareHandler } from "hono";

export function csrfMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    const provided = c.req.header("x-loomscope-token");
    if (!provided || provided !== token) {
      return c.json({ error: "csrf token missing or invalid" }, 403);
    }
    return next();
  };
}
