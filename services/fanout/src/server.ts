// Hono app factory. createApp() returns an app instance ready to mount
// with @hono/node-server (production) or app.request (tests). Pure
// function — no side effects, no listening port — so tests can build
// instances with mock fetcher + custom config without process.env.

import { Hono } from "hono";

import type { FanoutConfig } from "./config.js";
import {
  fireAndForgetFanout,
  racePreToolUseFanout,
  type FanoutDeps,
} from "./fanout.js";

export interface CreateAppDeps {
  /** Injectable fetcher for tests (mock upstreams). Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Optional sink for non-fatal errors. Default: console.warn. */
  onWarn?: (msg: string, err: unknown) => void;
}

export function createApp(config: FanoutConfig, deps: CreateAppDeps = {}) {
  const app = new Hono();
  const fanoutDeps: FanoutDeps = {
    upstreams: config.upstreams,
    secret: config.secret,
    fetcher: deps.fetcher,
    preToolUseDecisiveTimeoutMs: config.preToolUseDecisiveTimeoutMs,
    onWarn: deps.onWarn,
  };

  // Health endpoint — used by ~/loomscope-status.sh and any monitoring.
  // No secret required; reports basic plumbing state only.
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      role: "fanout",
      upstreams: config.upstreams.length,
    }),
  );

  // Main hook entry. CC's settings.json points here; we authenticate
  // the same way upstream Loomscope's /api/cc-hook does (constant-time
  // secret check) so settings.json doesn't need any custom config —
  // the same `$LOOMSCOPE_SECRET` env reference works.
  // 中: 主入口。鉴权跟上游同套 X-Loomscope-Secret,settings.json 不用改。
  app.post("/api/cc-hook", async (c) => {
    const provided = c.req.header("x-loomscope-secret") ?? "";
    if (!timingSafeEqual(provided, config.secret)) {
      return c.json({ error: "invalid secret" }, 403);
    }
    const event = c.req.query("event");
    if (!event) {
      return c.json({ error: "missing event query param" }, 400);
    }
    // We pass through the raw JSON body — no parsing, no validation.
    // Upstream Loomscope validates the body shape (zValidator) and
    // returns 400 if malformed; the middleware just forwards bytes.
    // 中: 中间件不解析 body,zod 校验在上游做。
    const body = await c.req.text();

    if (event === "PreToolUse") {
      const result = await racePreToolUseFanout(fanoutDeps, body);
      if (result.status === 204) return c.body(null, 204);
      const headers: Record<string, string> = {};
      if (result.contentType) headers["content-type"] = result.contentType;
      return c.body(result.body, result.status as 200, headers);
    }
    fireAndForgetFanout(fanoutDeps, event, body);
    return c.body(null, 204);
  });

  return app;
}

/** Constant-time string compare. Mirrors Loomscope's timingSafeEqualHex
 *  semantics (both sides are hex-encoded random strings of equal length
 *  in practice). We keep this inline so the fanout container has zero
 *  Loomscope source dependencies. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
