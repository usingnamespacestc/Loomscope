// EN (v∞.0 PR 1): receives CC settings.json hook fires. CC posts each
// event as JSON body to `POST /api/cc-hook?event=<EventName>` with
// `X-Loomscope-Secret: <secret>`. We validate the secret in constant
// time, validate the envelope shape via zod (loose — keep unknown
// fields under `extras`), and publish on the in-process `hookEventBus`.
// Subscribers (PR 2: SSE forwarder; future: logging / audit) handle
// fan-out.
//
// The route is intentionally side-effect-free apart from the bus
// publish + 204 ack — no store mutation, no SSE write, nothing that
// could block CC's hook fire. CC's axios is configured with a 5 s
// timeout in our recommended settings.json template; we want the
// happy path to take a couple of milliseconds.
//
// 中: CC hook fires 进 Loomscope 的入口。verify secret + shape，发布到
// hookEventBus，立刻 204 ack。零阻塞、零跨进程依赖、不直接动 store/SSE，
// 那些是 PR 2 的事。

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import {
  HOOK_EVENTS,
  publishHook,
  type HookEnvelope,
  type HookEventName,
} from "@/server/services/hookEventBus";
import { timingSafeEqualHex } from "@/server/services/loomscopeSecret";

// EN: schema for the common envelope. `passthrough()` preserves any
// event-specific fields (tool_name, tool_input, compact_metadata,
// permission_request_id, etc.) — we promote them into `extras` after
// validation rather than enumerating per-event schemas, because CC's
// hook payload set isn't fully stable across CC versions and we'd
// rather forward unknown fields than reject them.
// 中: 通用 envelope schema；事件特化字段 passthrough 到 extras，避免
// 跟 CC 版本绑死。
const HookBodySchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
  })
  .passthrough();

const QuerySchema = z.object({
  event: z.enum(HOOK_EVENTS),
});

export interface CcHookRouteOptions {
  /** Accessor returning the current secret. Reading on every request
   * (rather than closing over a static string) lets `rotateSecret()`
   * take effect mid-run without reconstructing the Hono app. */
  getSecret: () => string;
}

export function ccHookRouter(opts: CcHookRouteOptions) {
  const app = new Hono();

  app.post(
    "/",
    zValidator("query", QuerySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "unknown event" }, 400);
      }
    }),
    zValidator("json", HookBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid hook body" }, 400);
      }
    }),
    async (c) => {
      // Auth: constant-time compare. Header missing OR mismatch → 403.
      // Use the `?? ""` so the constant-time fn always operates on
      // strings (guards against the comparison short-circuiting on
      // `undefined !== string`, which can leak presence vs absence).
      const provided = c.req.header("x-loomscope-secret") ?? "";
      if (!timingSafeEqualHex(provided, opts.getSecret())) {
        return c.json({ error: "invalid secret" }, 403);
      }

      const event = c.req.valid("query").event as HookEventName;
      const body = c.req.valid("json") as Record<string, unknown> & {
        session_id: string;
      };

      // Promote known envelope fields up; everything else into extras.
      const knownKeys = new Set([
        "session_id",
        "transcript_path",
        "cwd",
        "permission_mode",
        "agent_id",
        "agent_type",
      ]);
      const extras: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (!knownKeys.has(k)) extras[k] = v;
      }
      const envelope: HookEnvelope = {
        session_id: body.session_id,
        transcript_path:
          typeof body.transcript_path === "string"
            ? body.transcript_path
            : undefined,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        permission_mode:
          typeof body.permission_mode === "string"
            ? body.permission_mode
            : undefined,
        agent_id:
          typeof body.agent_id === "string" ? body.agent_id : undefined,
        agent_type:
          typeof body.agent_type === "string" ? body.agent_type : undefined,
        extras,
      };

      publishHook(event, envelope);
      return c.body(null, 204);
    },
  );

  return app;
}
