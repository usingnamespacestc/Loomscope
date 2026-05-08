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

import { forkSession } from "@anthropic-ai/claude-agent-sdk";

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
  // v∞.2 auto-fork: when set, the user is submitting a turn from a
  // non-leaf ChatNode. Server first calls SDK forkSession to spawn
  // a new jsonl with the transcript sliced up to upToMessageId, then
  // enqueues the turn on the FORK (not the origin). Replaces the
  // explicit ⑂ fork button — Loomscope now just auto-forks whenever
  // the user composes from anywhere other than the leaf, matching
  // Agentloom's "submitting from non-leaf must fork" semantic.
  forkFrom: z
    .object({
      upToMessageId: z.string(),
      title: z.string().optional(),
    })
    .optional(),
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
      let { id } = c.req.valid("param");
      const body = c.req.valid("json");
      // Empty prompt rejected — this would either no-op or confuse
      // CC. The composer enforces canSend client-side, but defend
      // server-side too in case a stale tab fires bad.
      if (body.text.length === 0 && (body.images?.length ?? 0) === 0) {
        return c.json({ error: "empty prompt" }, 400);
      }
      // Auto-fork before enqueue: forkFrom set ⇒ user is composing
      // from a non-leaf ChatNode. Slice the transcript via SDK's
      // forkSession, then redirect the rest of this request onto the
      // fork's session id so the new turn lands on the new branch.
      let forkedSessionId: string | null = null;
      if (body.forkFrom) {
        try {
          const r = await forkSession(id, {
            upToMessageId: body.forkFrom.upToMessageId,
            title: body.forkFrom.title,
          });
          forkedSessionId = r.sessionId;
          id = forkedSessionId;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `fork failed: ${msg}` }, 500);
        }
      }
      const itemId = await opts.registry.enqueueTurn(id, body.cwd, {
        text: body.text,
        images: body.images ?? [],
        priority: body.priority ?? "next",
      });
      return c.json({
        itemId,
        // Echo the (post-fork) sessionId so the client knows where
        // the turn actually landed and can switch active session
        // when forkedSessionId differs from the URL :id.
        sessionId: id,
        forkedSessionId,
      });
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
