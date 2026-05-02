// `/api/workspaces` and `/api/workspaces/:cwdEnc/sessions`.
//
// `cwdEnc` is the URL-encoded real cwd (e.g. `%2Fhome%2Fuser%2FLoomscope`).
// We don't try to reverse-engineer the dash-substituted directory name —
// instead we re-scan and match by cwd, which is unambiguous.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { findWorkspaceByCwd, listSessions, scanWorkspaces } from "@/server/services/workspaceScanner";

export interface WorkspacesRouteOptions {
  rootDir: string;
}

export function workspacesRouter(opts: WorkspacesRouteOptions) {
  const app = new Hono();

  app.get("/", async (c) => {
    const items = await scanWorkspaces(opts.rootDir);
    // Strip projectDir from response — internal-only.
    return c.json(
      items.map(({ cwd, sessionCount, lastModified }) => ({
        cwd,
        sessionCount,
        lastModified,
      })),
    );
  });

  app.get(
    "/:cwdEnc/sessions",
    zValidator("param", z.object({ cwdEnc: z.string().min(1) })),
    async (c) => {
      const { cwdEnc } = c.req.valid("param");
      let cwd: string;
      try {
        cwd = decodeURIComponent(cwdEnc);
      } catch {
        return c.json({ error: "invalid cwdEnc encoding" }, 400);
      }
      const ws = await findWorkspaceByCwd(opts.rootDir, cwd);
      if (!ws) return c.json({ error: "workspace not found" }, 404);
      const sessions = await listSessions(ws.projectDir);
      return c.json(sessions);
    },
  );

  return app;
}
