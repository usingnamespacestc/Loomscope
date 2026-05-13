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

import { setDriftDetectionInterval } from "@/server/services/driftDetection";
import {
  loadPreferences,
  savePreferences,
} from "@/server/services/preferences";
import type { SessionRegistry } from "@/server/services/sessionRegistry";

const patchSchema = z.object({
  idleTimeoutMin: z.number().optional(),
  useApiKey: z.boolean().optional(),
  permissionMode: z
    .enum(["default", "acceptEdits", "bypassPermissions", "plan"])
    .optional(),
  respawnPerSend: z.boolean().optional(),
  enableHookHttpPath: z.boolean().optional(),
  enableHookSdkPath: z.boolean().optional(),
  interactiveMode: z.boolean().optional(),
  autoDeferOnRateLimit: z.boolean().optional(),
  driftDetectionSec: z.number().optional(),
  enableInteractivePermissions: z.boolean().optional(),
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
    if (opts.registry) {
      if (patch.idleTimeoutMin !== undefined) {
        opts.registry.setIdleTimeoutMin(merged.idleTimeoutMin);
      }
      if (patch.useApiKey !== undefined) {
        opts.registry.setUseApiKey(merged.useApiKey);
      }
      if (patch.permissionMode !== undefined) {
        opts.registry.setPermissionMode(merged.permissionMode);
      }
      if (patch.respawnPerSend !== undefined) {
        opts.registry.setRespawnPerSend(merged.respawnPerSend);
      }
      if (patch.enableHookHttpPath !== undefined) {
        opts.registry.setEnableHookHttpPath(merged.enableHookHttpPath);
      }
      if (patch.enableHookSdkPath !== undefined) {
        opts.registry.setEnableHookSdkPath(merged.enableHookSdkPath);
      }
      if (patch.autoDeferOnRateLimit !== undefined) {
        opts.registry.setAutoDeferOnRateLimit(merged.autoDeferOnRateLimit);
      }
      if (patch.enableInteractivePermissions !== undefined) {
        opts.registry.setInteractivePermissionsEnabled(
          merged.enableInteractivePermissions,
        );
      }
    }
    // v2.1 PR D3: drift interval lives outside the registry (it's a
    // server-wide timer, not a per-session thing). Update directly
    // here when the patch carried a new value.
    // 中: drift 是 server 级定时器，不挂 registry；PATCH 直接动这里。
    if (patch.driftDetectionSec !== undefined) {
      setDriftDetectionInterval(merged.driftDetectionSec);
    }
    return c.json(merged);
  });

  return app;
}
