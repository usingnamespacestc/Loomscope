// EN: HTTP entry points for v∞.2 write actions on existing sessions.
// All routes operate on a session id from the URL; the SessionRegistry
// singleton (initialised at app startup) handles the SDK plumbing.
//
// Routes:
//   POST   /:id/turns               — enqueue a new prompt
//   DELETE /:id/queue/:itemId       — cancel a queued (not running) prompt
//   POST   /:id/interrupt           — abort the in-flight turn
//   GET    /:id/queue               — read-only snapshot for reconnect-time reconciliation
//
// `priority: "now"` doubles as stop-and-send: registry interrupts
// the current turn and pre-empts pending items with the new prompt.
// No separate endpoint needed.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { SessionRegistry } from "@/server/services/sessionRegistry";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const turnSchema = z.object({
  text: z.string(),
  images: z
    .array(
      z.object({
        mediaType: z.string(),
        base64: z.string(),
      }),
    )
    .optional(),
  priority: z.enum(["now", "next", "later"]).optional(),
  cwd: z.string(),
});

export interface TurnsRouterOptions {
  registry: SessionRegistry;
}

export function turnsRouter(opts: TurnsRouterOptions) {
  const app = new Hono();

  app.post(
    "/:id/turns",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    zValidator("json", turnSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      // Empty prompt rejected — this would either no-op or confuse
      // CC. The composer enforces canSend client-side, but defend
      // server-side too in case a stale tab fires bad.
      if (body.text.length === 0 && (body.images?.length ?? 0) === 0) {
        return c.json({ error: "empty prompt" }, 400);
      }
      const itemId = await opts.registry.enqueueTurn(id, body.cwd, {
        text: body.text,
        images: body.images ?? [],
        priority: body.priority ?? "next",
      });
      return c.json({ itemId });
    },
  );

  app.delete(
    "/:id/queue/:itemId",
    zValidator(
      "param",
      z.object({
        id: z.string().regex(SESSION_ID_RE),
        itemId: z.string().min(1),
      }),
    ),
    async (c) => {
      const { id, itemId } = c.req.valid("param");
      const canceled = opts.registry.cancelPending(id, itemId);
      return c.json({ canceled });
    },
  );

  app.post(
    "/:id/interrupt",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const interrupted = await opts.registry.interrupt(id);
      return c.json({ interrupted });
    },
  );

  app.get(
    "/:id/queue",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const snap = opts.registry.snapshot(id);
      // Snapshot null = registry has no entry for this session (no
      // active Query). UI treats this as "idle, empty queue".
      return c.json(
        snap ?? { state: "idle", pendingCount: 0, currentRun: null },
      );
    },
  );

  return app;
}
