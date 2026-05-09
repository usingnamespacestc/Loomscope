// EN: routes for soft-deleting sessions, listing the trash, and
// emptying it. POST /api/sessions/:sid/trash moves the jsonl into
// `~/.loomscope/trash/`; the rest of the surface lives under
// /api/trash since the sid no longer maps to a live "session".
//
// Trashed sessions stay in the same registry / cache layers in
// memory until any active SDK Query is detached on the trash call —
// SessionRegistry.detach with cancel:true mirrors the Agentloom
// pattern where a delete must cancel in-flight work to avoid races
// (cf. memory: feedback_agentloom_delete_cancels.md).
//
// 中: 软删 / 还原 / 永删 / 列表 / 清空 5 个端点。trash 调用同步取
// 消任何活跃 SDK Query，避免 board_writer 跟磁盘文件抢救竞态。

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { SessionRegistry } from "@/server/services/sessionRegistry";
import { TrashError, TrashService } from "@/server/services/trash";

export interface TrashRouteOptions {
  rootDir: string;
  trashService: TrashService;
  registry: SessionRegistry;
}

const sidParam = z.object({
  sid: z.string().uuid(),
});

export function trashRouter(opts: TrashRouteOptions) {
  const app = new Hono();

  app.get("/", async (c) => {
    const items = await opts.trashService.list();
    return c.json(items);
  });

  app.post("/empty", async (c) => {
    const result = await opts.trashService.empty();
    return c.json(result);
  });

  app.post(
    "/:sid/restore",
    zValidator("param", sidParam),
    async (c) => {
      const { sid } = c.req.valid("param");
      try {
        const result = await opts.trashService.restore(sid);
        return c.json(result);
      } catch (err) {
        return mapTrashError(c, err);
      }
    },
  );

  app.delete(
    "/:sid",
    zValidator("param", sidParam),
    async (c) => {
      const { sid } = c.req.valid("param");
      try {
        await opts.trashService.purge(sid);
        return c.json({ ok: true });
      } catch (err) {
        return mapTrashError(c, err);
      }
    },
  );

  return app;
}

/** Soft-delete handler mounted under /api/sessions/:sid. Split from
 *  the trashRouter above so it can stay grouped with the live-session
 *  surface (mirroring how /api/sessions/:sid/turns lives on the same
 *  prefix). */
export function trashOnSessionRouter(opts: TrashRouteOptions) {
  const app = new Hono();
  app.post(
    "/:sid/trash",
    zValidator("param", sidParam),
    async (c) => {
      const { sid } = c.req.valid("param");
      // Cancel any active SDK Query before moving the jsonl, so the
      // SDK's append doesn't race with `fs.rename` (would either
      // re-create the live file at originalPath or land lines into a
      // file that no longer exists). Mirrors Agentloom's "DELETE
      // cancels in-flight" rule (cf. memory:
      // feedback_agentloom_delete_cancels.md).
      await opts.registry.close(sid).catch(() => undefined);
      try {
        const result = await opts.trashService.trash(opts.rootDir, sid);
        return c.json(result);
      } catch (err) {
        return mapTrashError(c, err);
      }
    },
  );
  return app;
}

function mapTrashError(c: Context, err: unknown) {
  if (err instanceof TrashError) {
    const statusByCode = {
      NOT_FOUND: 404,
      ALREADY_TRASHED: 409,
      RESTORE_COLLISION: 409,
      META_CORRUPT: 500,
    } as const;
    return c.json(
      { error: err.message, code: err.code },
      statusByCode[err.code],
    );
  }
  console.error("[loomscope] trash route unhandled error:", err);
  return c.json({ error: "internal server error" }, 500);
}
