// GET /api/models — returns the SDK's `supportedModels()` list with
// display names. Composer's model picker uses this so the dropdown
// always matches whichever CC binary is currently installed.

import { Hono } from "hono";

import type { ModelsRegistry } from "@/server/services/modelsRegistry";

export interface ModelsRouterOptions {
  modelsRegistry: ModelsRegistry;
}

export function modelsRouter(opts: ModelsRouterOptions) {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      const models = await opts.modelsRegistry.getModels();
      // Pass ModelInfo through verbatim. The client only needs `value`
      // + `displayName` today, but exposing the full shape lets a
      // future Composer revision drive effort/fastMode UI gating from
      // supportsEffort / supportsFastMode without a route change.
      // 中: 原样透传 ModelInfo,未来 effort/fastMode UI 可按 supports* 字
      // 段联动,免改路由。
      return c.json({ models });
    } catch (err) {
      console.warn("[/api/models] supportedModels fetch failed:", err);
      // 503 (not 500) so the client can distinguish "SDK fetch failed,
      // keep the baked-in fallback" from a true server crash.
      // 中: 503 标记降级,客户端 fallback 列表继续撑住。
      return c.json(
        {
          models: [],
          error: err instanceof Error ? err.message : "fetch_failed",
        },
        503,
      );
    }
  });

  return app;
}
