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

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createReadStream } from "node:fs";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { forkSession } from "@anthropic-ai/claude-agent-sdk";

import { findForkClosure } from "@/server/services/forkTree";
import { buildLifecycleSnapshot } from "@/server/services/lifecycleSnapshot";
import { locateSessionJsonl } from "@/server/services/locateJsonl";
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
  // v1.3 R2: per-turn Composer settings overrides. Sent on every
  // turn so the server applies them to SessionRegistry's options
  // before dispatch — respawnPerSend (default true) then picks up
  // the new opts at the next spawn. Composer's localStorage is the
  // source of truth; we don't persist these server-side.
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  fastMode: z.boolean().optional(),
  // PR-1 (2026-05-18, convergence rework §9.5): client-minted
  // Loomscope correlation id. Stored on the queued item; binding to
  // the resulting promptId is the human-gated remainder.
  loomId: z.string().optional(),
});

export interface TurnsRouterOptions {
  registry: SessionRegistry;
  /** Root of `~/.claude/projects` — needed by the auto-fork path
   *  to resolve which jsonl in the entry's fork closure actually
   *  contains the requested upToMessageId. Without this, fork
   *  requests pointing at a record that lives in a sibling jsonl
   *  (= when Loomscope's canvas merged closure ChatNodes into the
   *  active session view) would 500 because SDK forkSession
   *  reads only the named sid's jsonl. */
  rootDir: string;
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
      //
      // Cross-closure resolution: the active session id (URL :id)
      // may not actually own the upToMessageId record — Loomscope's
      // canvas merges fork closure ChatNodes into one view, so a
      // user clicking a closure-extra ChatNode hands us a uuid that
      // lives in a sibling jsonl. Walk the closure to find which
      // member's jsonl contains it; fork from THAT member.
      let forkedSessionId: string | null = null;
      if (body.forkFrom) {
        const resolution = await resolveForkSourceSessionWithDiag(
          opts.rootDir,
          id,
          body.forkFrom.upToMessageId,
        );
        if (!resolution.sourceSid) {
          // Loud server-side log so the operator can correlate with
          // file state (timing, permissions, racing writers). The
          // 400 body echoes the diag for the browser console too.
          console.warn(
            "[loomscope:turns] fork failed — uuid not found in closure",
            {
              entrySessionId: id,
              upToMessageId: body.forkFrom.upToMessageId,
              candidates: resolution.scans,
            },
          );
          return c.json(
            {
              error: `fork failed: upToMessageId not found in any closure member of ${id}`,
              diag: resolution.scans,
            },
            400,
          );
        }
        const sourceSid = resolution.sourceSid;
        try {
          const r = await forkSession(sourceSid, {
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
      // v1.3 R2: sync per-turn Composer settings onto the registry
      // before dispatch. respawnPerSend=true (production default)
      // then picks up the new opts at the very next spawn — i.e. the
      // turn we're about to enqueue. When undefined we leave existing
      // opts unchanged (don't clear someone else's setting).
      if (body.model !== undefined) opts.registry.setModel(body.model);
      if (body.effort !== undefined) opts.registry.setEffort(body.effort);
      if (body.fastMode !== undefined) {
        opts.registry.setFastMode(body.fastMode);
      }
      const itemId = await opts.registry.enqueueTurn(id, body.cwd, {
        text: body.text,
        images: body.images ?? [],
        priority: body.priority ?? "next",
        // PR-1: carry the client-minted correlation id onto the
        // queued item (plumbing only — not yet bound/stamped).
        loomId: body.loomId,
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

  // PR-2.5 slice 1 (design §9.7 item 3 / §9.8): additive read-only
  // server-held, content-versioned LIFECYCLE snapshot. Pure
  // aggregator over facts the server already owns (registry +
  // pendingPermissionTracker), stamped with getCurrentSeq. Exposed
  // here because this router already holds the DI'd registry; the
  // frontend does NOT consume it yet (recorded-not-consumed, PR-1
  // discipline — zero behaviour change). Subscribe-time replay +
  // the terminal hook→lifecycle reducer + frontend OR-collapse are
  // later slices.
  app.get(
    "/:id/lifecycle",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(buildLifecycleSnapshot(opts.registry, id));
    },
  );

  // v2.0.1 PR B: Force-clear an active rate-limit deferral. The banner's
  // "立即重试" button calls this. Server clears the gate and triggers
  // maybeDispatch — if Anthropic still rejects (utilization not actually
  // back), CC will emit another rate_limit_event and the gate re-arms.
  // 中: 取消 deferral 强制恢复。Anthropic 真没恢复时 CC 会再 fire 事件 + 自动 re-arm。
  app.post(
    "/:id/deferral/clear",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const cleared = await opts.registry.clearDeferral(id);
      return c.json({ cleared });
    },
  );

  // v2.0.1 PR B: read-only snapshot of the deferral state. SSE late-
  // join path — when a browser tab opens after the event already
  // fired, fetch this to render the banner without missing the SSE.
  app.get(
    "/:id/deferral",
    zValidator("param", z.object({ id: z.string().regex(SESSION_ID_RE) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const state = opts.registry.getDeferralState(id);
      return c.json(state ?? { deferralUntilEpoch: null, reason: null });
    },
  );

  return app;
}

// (`locateSessionJsonl` hoisted to `services/locateJsonl.ts` once a
//  third caller appeared — see app.ts/staleness check.)

// Walk the entry session's fork closure (incl. parent sessions
// reachable via forkedFrom + child sessions via inverse map) and
// find which jsonl contains the requested record uuid. Returns the
// session id of the matching jsonl, or null if no closure member
// has it.
//
// Used when the user composes from a ChatNode whose physical record
// lives in a sibling jsonl rather than the active session's own
// jsonl (e.g. closure-merged canvas view). Without this resolution,
// SDK forkSession would try to read the wrong jsonl and 500.
interface ScanRecord {
  sid: string;
  path: string;
  linesScanned: number;
  fileSize: number;
  found: boolean;
  error?: string;
}

interface ResolveResult {
  sourceSid: string | null;
  scans: ScanRecord[];
}

async function resolveForkSourceSessionWithDiag(
  rootDir: string,
  entrySessionId: string,
  upToMessageId: string,
): Promise<ResolveResult> {
  const entryJsonl = await locateSessionJsonl(rootDir, entrySessionId);
  if (!entryJsonl) return { sourceSid: null, scans: [] };
  const projectDir = path.dirname(entryJsonl);
  const closure = await findForkClosure({ projectDir, entrySessionId });
  // Closure can be empty for non-fork sessions (just the entry); the
  // entry jsonl IS the only candidate then. findForkClosure usually
  // returns the entry as element 0; still scan in case ordering
  // changes.
  const candidates =
    closure.length > 0
      ? closure.map((m) => ({ sid: m.sessionId, path: m.jsonlPath }))
      : [{ sid: entrySessionId, path: entryJsonl }];
  // Try the entry first (most common case), then sibling members.
  candidates.sort((a, b) => (a.sid === entrySessionId ? -1 : b.sid === entrySessionId ? 1 : 0));
  const scans: ScanRecord[] = [];
  for (const cand of candidates) {
    const stat = await fsp.stat(cand.path).catch(() => null);
    const fileSize = stat?.size ?? -1;
    try {
      const { found, linesScanned } = await scanJsonlForUuid(
        cand.path,
        upToMessageId,
      );
      scans.push({
        sid: cand.sid,
        path: cand.path,
        linesScanned,
        fileSize,
        found,
      });
      if (found) return { sourceSid: cand.sid, scans };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      scans.push({
        sid: cand.sid,
        path: cand.path,
        linesScanned: -1,
        fileSize,
        found: false,
        error: msg,
      });
    }
  }
  return { sourceSid: null, scans };
}

// Stream-scan a jsonl line by line for a record whose `uuid` matches
// `target`. Returns true on first match. Cheap when the record is
// near the head of the file; bounded full scan when not. We don't
// JSON.parse — just substring-match `"uuid":"<target>"` because the
// target is a UUID with hyphens (no escaping concerns).
//
// Returns linesScanned alongside the boolean for diagnostic purposes
// — when a fork attempt fails because the resolver couldn't find
// the uuid, knowing how many lines we read vs the file's actual line
// count helps distinguish "scanned everything, genuinely missing"
// from "stream truncated mid-scan / racing writer".
async function scanJsonlForUuid(
  jsonlPath: string,
  target: string,
): Promise<{ found: boolean; linesScanned: number }> {
  const needle = `"uuid":"${target}"`;
  return new Promise((resolve, reject) => {
    let stream: ReturnType<typeof createReadStream> | null = null;
    try {
      stream = createReadStream(jsonlPath, { encoding: "utf8" });
    } catch (err) {
      reject(err);
      return;
    }
    const rl = readline.createInterface({ input: stream });
    let linesScanned = 0;
    rl.on("line", (line) => {
      linesScanned++;
      if (line.includes(needle)) {
        rl.close();
        stream?.destroy();
        resolve({ found: true, linesScanned });
      }
    });
    rl.on("close", () => resolve({ found: false, linesScanned }));
    rl.on("error", (err) => reject(err));
  });
}
