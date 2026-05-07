// Compose the Hono app from routers + middleware. Kept separate from
// `index.ts` so unit tests can spin up an app instance against a tmpfs
// fixture without booting a real listener.

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

import { corsMiddleware } from "@/server/middleware/cors";
import { csrfMiddleware } from "@/server/middleware/csrf";
import { ccHookRouter } from "@/server/routes/ccHook";
import { ccHookOnboardingRouter } from "@/server/routes/ccHookOnboarding";
import { searchRouter } from "@/server/routes/search";
import { sessionsRouter } from "@/server/routes/sessions";
import { workspacesRouter } from "@/server/routes/workspaces";
import { initHookSseForwarder } from "@/server/services/hookSseForwarder";
import { initPendingPermissionTracker } from "@/server/services/pendingPermissionTracker";

export interface AppOptions {
  rootDir: string; // e.g. ~/.claude/projects
  csrfToken: string;
  allowedOrigin: string; // e.g. http://localhost:5174
  // v∞.0 PR 1: per-installation secret CC hook fires must carry in
  // `X-Loomscope-Secret`. Boot script generates / loads via
  // `getOrCreateSecret()`. Required because the CSRF bypass for the
  // hook path leaves it unauthenticated otherwise.
  hookSecret: string;
  // v1.0 ship prep: when set, Hono serves a production frontend
  // bundle from this directory at the root path. `index.html` is
  // returned for any non-API path so the SPA router (if we ever
  // add one) handles client-side navigation. Leave undefined in
  // dev mode where Vite at port 5175 serves the frontend +
  // proxies /api to us. Path is resolved relative to process.cwd
  // by the caller — the cli.ts boot script handles that.
  staticDir?: string;
}

export function createApp(opts: AppOptions) {
  const app = new Hono();
  app.use("*", corsMiddleware(opts.allowedOrigin));
  app.use("*", csrfMiddleware(opts.csrfToken));

  // v∞.0 PR 2: idempotent — bridges hookEventBus → sseHub so CC
  // hook fires reach SSE-subscribed browser clients.
  initHookSseForwarder();
  // v∞.0 hook catchup: idempotent — server-side per-session memory
  // of unresolved PermissionRequest fires. SSE route reads this
  // on subscribe to send a snapshot to late-joining clients.
  initPendingPermissionTracker();

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: "0.2.0", rootDir: opts.rootDir }),
  );

  app.route("/api/workspaces", workspacesRouter({ rootDir: opts.rootDir }));
  app.route("/api/sessions", sessionsRouter({ rootDir: opts.rootDir }));
  app.route("/api/search", searchRouter({ rootDir: opts.rootDir }));
  app.route("/api/cc-hook", ccHookRouter({ secret: opts.hookSecret }));
  // v∞.0 PR 3: parse allowedOrigin to recover the listening port —
  // settings.json hook URLs are constructed against that port. If
  // the URL is malformed (custom deploys), fall back to 5174 which
  // matches our default; the patcher is harmless in that case
  // because users won't be running on a port mismatch by accident.
  const port = parsePortFromOrigin(opts.allowedOrigin) ?? 5174;
  app.route(
    "/api/cc-hook-onboarding",
    ccHookOnboardingRouter({ port, hookSecret: opts.hookSecret }),
  );

  // v1.0 ship prep: production-mode static frontend serving. Mount
  // AFTER the API routes so /api/* always reaches its handlers; the
  // serveStatic middleware only fields requests that didn't match.
  // Single-process serve makes the bin entry a one-liner — no Vite
  // proxy + no separate static-server hop.
  if (opts.staticDir) {
    app.use("/*", serveStatic({ root: opts.staticDir }));
    // SPA fallback for any non-API path that didn't resolve to a
    // file on disk — return index.html so client-side routing (if
    // we ever add it) handles navigation.
    app.get("*", serveStatic({ path: "index.html", root: opts.staticDir }));
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[loomscope] unhandled error:", err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

function parsePortFromOrigin(origin: string): number | null {
  try {
    const u = new URL(origin);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}
