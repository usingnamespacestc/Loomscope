// Strict same-origin CORS for Mode A. Allow only the configured origin; in
// dev we expect Vite (port 5175) to proxy `/api/*` to us so the request
// origin is same-origin and CORS doesn't kick in. Direct cross-origin
// browser calls land here and get rejected.
//
// We deliberately avoid Hono's `cors` middleware to keep behavior auditable.

import type { MiddlewareHandler } from "hono";

export function corsMiddleware(allowedOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next(); // same-origin requests don't carry Origin
    if (origin !== allowedOrigin) {
      return c.json({ error: "cors: origin not allowed" }, 403);
    }
    c.header("Access-Control-Allow-Origin", allowedOrigin);
    c.header("Access-Control-Allow-Headers", "Content-Type, X-Loomscope-Token");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    c.header("Vary", "Origin");
    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: c.res.headers });
    }
    return next();
  };
}
