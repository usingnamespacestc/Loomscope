// EN (v∞.0 PR 3): GET status / POST patch endpoints for the
// ~/.claude/settings.json Loomscope hook block. The frontend
// onboarding modal uses these to decide what to show + auto-add /
// auto-remove hooks at the user's explicit request.
//
// 中: 给前端 onboarding modal 用的两个端点：读 settings.json 状态、
// 写入或移除 Loomscope hook 块。

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import {
  addLoomscopeHooks,
  buildPasteableSnippet,
  getHookStatus,
  removeLoomscopeHooks,
} from "@/server/services/ccSettingsPatcher";
import { rotateSecret } from "@/server/services/loomscopeSecret";

export interface CcHookOnboardingRouteOptions {
  /** Loomscope port. Used to construct hook URLs the patcher writes
   * into settings.json + identify our existing entries on read. */
  port: number;
  /** Accessor returning the current secret. Mirrors the ccHook route
   * pattern so a mid-run `rotateSecret()` is visible immediately. */
  getHookSecret: () => string;
}

export function ccHookOnboardingRouter(opts: CcHookOnboardingRouteOptions) {
  const app = new Hono();

  // GET /api/cc-hook-onboarding/status
  app.get("/status", async (c) => {
    try {
      const status = await getHookStatus(opts.port);
      return c.json({
        ...status,
        // Shell-rc snippet the frontend renders for copy. The secret
        // belongs to this installation; users with multi-host setups
        // should use the same value across hosts (or set per-host).
        // We surface a ready-to-paste line rather than just the
        // value so users don't have to know the export syntax.
        shellRcSnippet: `export LOOMSCOPE_SECRET=${opts.getHookSecret()}`,
        pasteableJson: buildPasteableSnippet(opts.port),
      });
    } catch (err) {
      return c.json(
        {
          error: "failed to read settings.json",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  // POST /api/cc-hook-onboarding/rotate-secret — generate a fresh
  // 64-hex secret + persist + swap into the in-memory accessor.
  // Returns the post-rotation status payload (same shape as /status).
  // Side effect: every CC session whose `LOOMSCOPE_SECRET` env var
  // still has the old value will start hitting 403 — the user must
  // update the shell rc + restart their terminal/CC for hooks to
  // resume working. The status response surfaces the new shellRc
  // snippet so the user can copy-and-paste it immediately.
  app.post("/rotate-secret", async (c) => {
    try {
      await rotateSecret();
      const status = await getHookStatus(opts.port);
      return c.json({
        ...status,
        shellRcSnippet: `export LOOMSCOPE_SECRET=${opts.getHookSecret()}`,
        pasteableJson: buildPasteableSnippet(opts.port),
      });
    } catch (err) {
      return c.json(
        {
          error: "rotate-secret failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  // POST /api/cc-hook-onboarding/patch — body: { mode: "add" | "remove" }
  // Writes settings.json. Refuses if existing file is malformed.
  app.post(
    "/patch",
    zValidator("json", z.object({ mode: z.enum(["add", "remove"]) })),
    async (c) => {
      const { mode } = c.req.valid("json");
      try {
        const status =
          mode === "add"
            ? await addLoomscopeHooks(opts.port)
            : await removeLoomscopeHooks(opts.port);
        if (status.malformed) {
          return c.json(
            {
              error: "settings.json is malformed; refusing to write",
              status,
            },
            409,
          );
        }
        return c.json(status);
      } catch (err) {
        return c.json(
          {
            error: "patch failed",
            detail: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    },
  );

  return app;
}
