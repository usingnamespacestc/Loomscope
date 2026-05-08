// EN (v∞.3 PR1): HTTP routes for the canUseTool browser-driven
// decision flow.
//
// Routes:
//   POST /api/sessions/:id/permission-prompts/:promptId/decision
//     — browser → here when the user clicks Allow / Always allow / Deny
//   GET  /api/permission-rules            — list saved rules (Settings UI)
//   POST /api/permission-rules            — add a rule (called by the
//                                            decision endpoint when
//                                            persist=true; optionally
//                                            usable directly)
//   DELETE /api/permission-rules/:id      — remove a rule
//
// The decision endpoint returns 200 + {ok: true} on success, 404 if
// promptId doesn't exist (= already resolved or never existed —
// stale tab firing late). When persist=true && behavior=allow the
// rule is saved and SessionRegistry's in-memory cache reloads so
// subsequent canUseTool calls match instantly.
//
// 中: canUseTool 浏览器决策流的 HTTP 入口。promptId 路由由
// SessionRegistry 持有的 in-memory map 解析；persist 时存到
// ~/.loomscope/permissions.json + 让 registry 缓存刷新。

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  deletePermissionRule,
  loadPermissionRules,
  savePermissionRule,
} from "@/server/services/permissionRules";
import type { SessionRegistry } from "@/server/services/sessionRegistry";

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_ID_RE = /^pp-[0-9a-f-]{36}$/i;

const decisionBodySchema = z.object({
  behavior: z.enum(["allow", "deny"]),
  // When true + behavior=allow, also save a rule so subsequent
  // canUseTool calls for the same toolName auto-match. No-op when
  // behavior=deny — Loomscope doesn't surface "always deny" as a
  // user action (single-shot deny is safer; user can still curate
  // deny rules via settings.json or future Settings UI).
  persist: z.boolean().optional(),
  // Optional message attached to deny decisions (shown to the model
  // as the rejection reason). When omitted the SDK callback fills a
  // generic Chinese-localized default.
  message: z.string().optional(),
});

export interface PermissionPromptsRouterOptions {
  registry: SessionRegistry;
}

/** Routes scoped under /api/sessions — mounts the per-session
 *  decision endpoint. Symmetric with turnsRouter / forkRouter. */
export function permissionPromptsRouter(opts: PermissionPromptsRouterOptions) {
  const app = new Hono();

  app.post(
    "/:id/permission-prompts/:promptId/decision",
    zValidator(
      "param",
      z.object({
        id: z.string().regex(SESSION_ID_RE),
        promptId: z.string().regex(PROMPT_ID_RE),
      }),
    ),
    zValidator("json", decisionBodySchema),
    async (c) => {
      const { promptId } = c.req.valid("param");
      const body = c.req.valid("json");
      const resolved = opts.registry.resolvePermissionPrompt(promptId, {
        behavior: body.behavior,
        message: body.message,
      });
      if (!resolved) {
        // Prompt not in registry — usually stale (already resolved /
        // session closed before user clicked). 404 so the browser
        // can silently swallow.
        return c.json({ error: "permission prompt not found" }, 404);
      }
      // Persist as a rule when asked. Save → reload registry's
      // cached rule list so the NEXT canUseTool call for this tool
      // matches instantly without prompting. toolName comes from
      // the registry's pending entry (server-trusted) rather than
      // the request body — keeps clients from saving rules for
      // tools they didn't actually grant.
      if (body.persist === true && body.behavior === "allow") {
        await savePermissionRule({
          toolName: resolved.toolName,
          behavior: "allow",
        });
        await opts.registry.refreshPermissionRules();
      }
      return c.json({ ok: true });
    },
  );

  return app;
}

// ────────────────────────────────────────────────────────────────────
// /api/permission-rules — CRUD for the persisted rule list
// ────────────────────────────────────────────────────────────────────

const saveRuleBodySchema = z.object({
  toolName: z.string().min(1),
  behavior: z.enum(["allow", "deny"]),
});

export interface PermissionRulesRouterOptions {
  registry: SessionRegistry;
}

export function permissionRulesRouter(opts: PermissionRulesRouterOptions) {
  const app = new Hono();

  app.get("/", async (c) => {
    const file = await loadPermissionRules();
    return c.json(file);
  });

  app.post("/", zValidator("json", saveRuleBodySchema), async (c) => {
    const body = c.req.valid("json");
    const saved = await savePermissionRule(body);
    // Refresh registry's in-memory cache so subsequent canUseTool
    // hits see the new rule instantly.
    await opts.registry.refreshPermissionRules();
    return c.json({ rule: saved });
  });

  app.delete(
    "/:id",
    zValidator("param", z.object({ id: z.string().min(1) })),
    async (c) => {
      const { id } = c.req.valid("param");
      const removed = await deletePermissionRule(id);
      if (!removed) return c.json({ error: "rule not found" }, 404);
      await opts.registry.refreshPermissionRules();
      return c.json({ ok: true });
    },
  );

  return app;
}
