// v1.6: POST /api/sessions/new — spawn a fresh CC session via the
// SDK and return the CC-generated session id. Differs from the
// regular /api/sessions/:id/turns path because there's no existing
// sid yet — SessionRegistry's spawnNewSession learns the sid from
// the SDK's first message and registers the entry under it.
//
// Request body mirrors the turns route (text + cwd + images +
// model/effort/fastMode) so the same Composer settings flow into
// the fresh session as flow into existing-session turns.
//
// Request body REQUIRES a non-empty prompt — the SDK won't actually
// spawn until input arrives, so a "create empty session" wouldn't
// produce a sid anyway. The frontend draft-mode flow short-circuits
// the modal-with-empty-prompt case to a client-only placeholder
// (no server call), so the server never needs to handle that.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import type { SessionRegistry } from "@/server/services/sessionRegistry";

const schema = z.object({
  text: z.string().min(1, "prompt required"),
  cwd: z.string().min(1, "cwd required"),
  images: z
    .array(
      z.object({
        mediaType: z.string(),
        base64: z.string(),
      }),
    )
    .optional(),
  // v1.3 settings — same shape as turns route
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  fastMode: z.boolean().optional(),
});

export interface NewSessionRouterOptions {
  registry: SessionRegistry;
}

export function newSessionRouter(opts: NewSessionRouterOptions) {
  const app = new Hono();

  app.post("/new", zValidator("json", schema), async (c) => {
    const body = c.req.valid("json");

    // Sync per-turn settings before spawn — same pattern as
    // turns route. Settings stick on registry opts; spawnNewSession
    // reads them when building SDK options.
    if (body.model !== undefined) opts.registry.setModel(body.model);
    if (body.effort !== undefined) opts.registry.setEffort(body.effort);
    if (body.fastMode !== undefined) {
      opts.registry.setFastMode(body.fastMode);
    }

    try {
      const result = await opts.registry.spawnNewSession(body.cwd, {
        text: body.text,
        images: body.images ?? [],
      });
      return c.json({
        sessionId: result.sessionId,
        itemId: result.itemId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `new session spawn failed: ${msg}` },
        500,
      );
    }
  });

  return app;
}
