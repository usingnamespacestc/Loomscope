// Compose the Hono app from routers + middleware. Kept separate from
// `index.ts` so unit tests can spin up an app instance against a tmpfs
// fixture without booting a real listener.

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

// Read package.json at module init so `/api/health` always reports
// the current release. Hard-coding ("0.2.0") had drifted across two
// releases before someone caught it. tsx + Node 22 + ESM JSON
// import attributes work without extra build config.
import pkg from "../../package.json" with { type: "json" };

import { corsMiddleware } from "@/server/middleware/cors";
import { csrfMiddleware } from "@/server/middleware/csrf";
import { ccHookRouter } from "@/server/routes/ccHook";
import { ccHookOnboardingRouter } from "@/server/routes/ccHookOnboarding";
import { preferencesRouter } from "@/server/routes/preferences";
import { searchRouter } from "@/server/routes/search";
import { sessionsRouter } from "@/server/routes/sessions";
import { turnsRouter } from "@/server/routes/turns";
import { workspacesRouter } from "@/server/routes/workspaces";
import { initHookSseForwarder } from "@/server/services/hookSseForwarder";
import { initPendingPermissionTracker } from "@/server/services/pendingPermissionTracker";
import { loadPreferences } from "@/server/services/preferences";
import { realSdkQuery } from "@/server/services/sdkAdapter";
import { SessionRegistry } from "@/server/services/sessionRegistry";

export interface AppOptions {
  rootDir: string; // e.g. ~/.claude/projects
  csrfToken: string;
  // v∞.2: optional SessionRegistry override for testing. Production
  // wiring auto-creates one bound to the real SDK + saved
  // preferences. Tests inject a fake-SDK-backed registry to drive
  // turn endpoints deterministically.
  registry?: SessionRegistry;
  allowedOrigin: string; // e.g. http://localhost:5174
  // v∞.0 PR 1: per-installation secret CC hook fires must carry in
  // `X-Loomscope-Secret`. Boot script generates / loads via
  // `getOrCreateSecret()`. Required because the CSRF bypass for the
  // hook path leaves it unauthenticated otherwise.
  //
  // v0.11: accepted as a pure string OR an accessor. Production
  // wires `getCurrentSecret` so `rotateSecret()` (Settings UI →
  // Hooks tab → 重新生成) takes effect mid-run; tests pass a static
  // string for hermeticity. Internally normalised to an accessor.
  hookSecret: string | (() => string);
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
  const getHookSecret =
    typeof opts.hookSecret === "function"
      ? opts.hookSecret
      : (() => opts.hookSecret as string);

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
    c.json({ ok: true, version: pkg.version, rootDir: opts.rootDir }),
  );

  app.route("/api/workspaces", workspacesRouter({ rootDir: opts.rootDir }));
  app.route("/api/sessions", sessionsRouter({ rootDir: opts.rootDir }));
  app.route("/api/search", searchRouter({ rootDir: opts.rootDir }));
  app.route("/api/cc-hook", ccHookRouter({ getSecret: getHookSecret }));
  // v∞.2: SDK-backed turn endpoints + preferences. Registry is created
  // here unless one was passed in (tests do this for hermeticity).
  // Idle timeout reads the persisted preference at startup; PATCH
  // /api/preferences calls registry.setIdleTimeoutMin to apply changes
  // live without restart. Note: createApp is sync, so we can't await
  // loadPreferences here — we read it synchronously below using a
  // sync read; if missing we fall back to the default.
  const registry =
    opts.registry ??
    new SessionRegistry({
      queryFactory: realSdkQuery,
      idleTimeoutMin: 30, // default; PATCH /preferences updates live
    });
  // Asynchronously sync the persisted preference into the new
  // registry — production path. Tests pass their own registry and
  // skip this.
  if (!opts.registry) {
    void loadPreferences().then((p) => {
      registry.setIdleTimeoutMin(p.idleTimeoutMin);
    });
  }
  app.route("/api/sessions", turnsRouter({ registry }));
  app.route("/api/preferences", preferencesRouter({ registry }));
  // v∞.0 PR 3: parse allowedOrigin to recover the listening port —
  // settings.json hook URLs are constructed against that port. If
  // the URL is malformed (custom deploys), fall back to 5174 which
  // matches our default; the patcher is harmless in that case
  // because users won't be running on a port mismatch by accident.
  const port = parsePortFromOrigin(opts.allowedOrigin) ?? 5174;
  app.route(
    "/api/cc-hook-onboarding",
    ccHookOnboardingRouter({ port, getHookSecret }),
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
