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
  // ──────────────────────────────────────────────────────────────────
  // sourceSessionId — DORMANT API surface (no current caller).
  // ──────────────────────────────────────────────────────────────────
  //
  // What it does: when set, the server forks `sourceSessionId`'s jsonl
  // instead of the URL :id session's jsonl. The URL :id is still the
  // route param (so existing routing / auth / per-route middleware
  // stays), but `forkSession` is invoked against the alternate sid.
  //
  // Why it exists: in Loomscope's merged-closure canvas view, ChatNodes
  // from sibling-fork sessions appear alongside the active session's
  // own ChatNodes (parser merges records from every closure member,
  // bucketing by promptId). For each merged ChatNode, the records may
  // physically live in a sibling jsonl rather than the active session's
  // — see ChatNode.contributingSessions for the per-node ownership
  // breakdown. SDK forkSession reads bytes from a specific sid's jsonl,
  // so forking from such an "off-chain" ChatNode requires telling the
  // server which jsonl to read.
  //
  // Why it's currently unused: PR 2 of the fork-UX rework
  // (commit 0e9fb6a, 2026-05-08) removed the right-click "Fork from
  // here" affordance on off-chain (gray) ChatNodes. The decision: when
  // a user wants to fork from a ChatNode that lives on a sibling
  // session, the cleaner two-step flow is "Jump to source session →
  // then fork from there", which keeps the fork's source session
  // unambiguous and avoids accidental forks from misclicks on gray
  // nodes. With that decision in place, every remaining caller (the
  // ChatFlow canvas's right-click action) only forks from on-chain
  // nodes where `sourceSessionId == URL :id`, so the field is redundant
  // for current callers and they don't pass it.
  //
  // Why it's kept anyway: the surface is tiny (the schema field +
  // one-line `?? id` fallback in the handler), and keeping it leaves
  // the cross-jsonl fork path *available* for future UI re-additions
  // — e.g. a "fork from any visible ChatNode regardless of which
  // session it belongs to" power-user mode, or a programmatic /api/
  // caller that wants direct cross-jsonl forks. Re-enabling it costs
  // zero backend work — frontend just needs to pass the sid that
  // `ChatNode.contributingSessions` reports for the targeted node.
  //
  // Cross-reference: docs/fork-ux-notes.md captures the broader
  // architecture decision; api/turns.ts mirrors this comment on the
  // postFork client side.
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
