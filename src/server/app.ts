// Compose the Hono app from routers + middleware. Kept separate from
// `index.ts` so unit tests can spin up an app instance against a tmpfs
// fixture without booting a real listener.

import { Hono } from "hono";

import { corsMiddleware } from "@/server/middleware/cors";
import { csrfMiddleware } from "@/server/middleware/csrf";
import { sessionsRouter } from "@/server/routes/sessions";
import { workspacesRouter } from "@/server/routes/workspaces";

export interface AppOptions {
  rootDir: string; // e.g. ~/.claude/projects
  csrfToken: string;
  allowedOrigin: string; // e.g. http://localhost:5174
}

export function createApp(opts: AppOptions) {
  const app = new Hono();
  app.use("*", corsMiddleware(opts.allowedOrigin));
  app.use("*", csrfMiddleware(opts.csrfToken));

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: "0.2.0", rootDir: opts.rootDir }),
  );

  app.route("/api/workspaces", workspacesRouter({ rootDir: opts.rootDir }));
  app.route("/api/sessions", sessionsRouter({ rootDir: opts.rootDir }));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[loomscope] unhandled error:", err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}
