// EN: GET / PATCH for ~/.loomscope/preferences.json. PATCH applies a
// shallow merge — so the UI can flip a single field without
// round-tripping the full object.
//
// On PATCH we ALSO push the new idleTimeoutMin into the live
// SessionRegistry instance so the change takes effect without a
// server restart.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  loadPreferences,
  savePreferences,
} from "@/server/services/preferences";
import type { SessionRegistry } from "@/server/services/sessionRegistry";

const patchSchema = z.object({
  idleTimeoutMin: z.number().optional(),
});

export interface PreferencesRouterOptions {
  // Optional — registry isn't always wired (e.g. test scenarios).
  // When present, idleTimeoutMin updates flow into it.
  registry?: SessionRegistry;
}

export function preferencesRouter(opts: PreferencesRouterOptions = {}) {
  const app = new Hono();

  app.get("/", async (c) => {
    const p = await loadPreferences();
    return c.json(p);
  });

  app.patch("/", zValidator("json", patchSchema), async (c) => {
    const patch = c.req.valid("json");
    const merged = await savePreferences(patch);
    if (
      patch.idleTimeoutMin !== undefined &&
      opts.registry &&
      "setIdleTimeoutMin" in opts.registry
    ) {
      (
        opts.registry as SessionRegistry & {
          setIdleTimeoutMin: (m: number) => void;
        }
      ).setIdleTimeoutMin(merged.idleTimeoutMin);
    }
    return c.json(merged);
  });

  return app;
}
