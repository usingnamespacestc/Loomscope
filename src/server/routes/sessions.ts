// `/api/sessions/:id` — return the parsed ChatFlow JSON for the given
// session. Looks up the JSONL across all project dirs (we don't yet maintain
// a sessionId→path index; the scan is fast enough for v0.2).

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { parseJsonlFile } from "@/parse/jsonl";

export interface SessionsRouteOptions {
  rootDir: string;
}

const SESSION_ID_RE = /^[a-f0-9-]{8,}$/i;

export function sessionsRouter(opts: SessionsRouteOptions) {
  const app = new Hono();

  app.get(
    "/:id",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const jsonlPath = await locateSessionJsonl(opts.rootDir, id);
      if (!jsonlPath) return c.json({ error: "session not found" }, 404);
      const result = await parseJsonlFile(jsonlPath);
      return c.json(result.chatFlow);
    },
  );

  return app;
}

async function locateSessionJsonl(rootDir: string, sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  for (const dir of entries) {
    const candidate = path.join(rootDir, dir, `${sessionId}.jsonl`);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}
