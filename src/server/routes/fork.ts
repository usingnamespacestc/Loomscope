// EN: HTTP entry for v∞.3-style mid-chain fork. Calls the SDK's
// `forkSession(sid, { upToMessageId, title })` which copies the
// transcript up to (inclusive) `upToMessageId` into a new jsonl
// with a freshly-allocated session id, preserving forkedFrom
// traceability for every entry.
//
// Loomscope's UI uses this for both leaf fork (omit
// `upToMessageId`) and any-ChatNode fork (resolve to the last
// record uuid of that ChatNode and pass it). Mid-chain fork is
// the SDK-only path — CC's terminal /branch slash command lacks
// this capability and is also disabled in SDK mode anyway (spike
// #3).
//
// Frontend calls `forkSession(sid, ...)` immediately after server
// returns so the new session shows up in sidebar via chokidar's
// jsonl-create watch path; UI then can offer "switch to fork"
// affordance if the user wants.
//
// 中: SDK forkSession 的 HTTP 入口。前端传 upToMessageId（来自
// ChatNode 最后一条 record 的 uuid）+ 可选 title。SDK 把 jsonl
// 切到该 uuid（含）拷成新 session。

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { forkSession } from "@anthropic-ai/claude-agent-sdk";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const forkSchema = z.object({
  upToMessageId: z.string().optional(),
  title: z.string().optional(),
  // PR 2 of fork-UX rework: when forking from an off-chain ChatNode
  // (user right-clicked a sibling-fork node in the merged-closure
  // canvas view), upToMessageId lives in the SIBLING jsonl, not the
  // URL :id session's. Frontend already knows which session owns the
  // node via ChatNode.contributingSessions, so it passes that here.
  // Server uses sourceSessionId for forkSession when set; otherwise
  // falls back to URL :id (the on-chain fork case).
  sourceSessionId: z
    .string()
    .regex(SESSION_ID_RE)
    .optional(),
});

export function forkRouter() {
  const app = new Hono();

  app.post(
    "/:id/fork",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    zValidator("json", forkSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const sourceSid = body.sourceSessionId ?? id;
      try {
        const result = await forkSession(sourceSid, {
          upToMessageId: body.upToMessageId,
          title: body.title,
        });
        return c.json({ sessionId: result.sessionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 500);
      }
    },
  );

  return app;
}
