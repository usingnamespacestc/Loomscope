// v1.6: filesystem support endpoints for the "新建 session" flow.
// Specifically:
//   - POST /api/fs/validate-cwd  → check that a path is an existing,
//     readable directory. Used by NewSessionModal to decide
//     whether to allow submit OR show the "create directory?"
//     warning before spawn.
//   - POST /api/fs/mkdir         → create a directory recursively
//     (when user confirms the warning). Server-side bound only:
//     refuses paths outside the user's $HOME / project roots to
//     avoid being a generic-purpose `mkdir` for the host machine.
//
// Authority model: same Mode A single-user-localhost as the rest of
// Loomscope. CSRF is handled at the app layer via the same token
// other write endpoints use.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

const validateSchema = z.object({
  path: z.string().min(1),
});

const mkdirSchema = z.object({
  path: z.string().min(1),
});

export type ValidateCwdResult =
  | { ok: true; path: string }
  | {
      ok: false;
      // Reason classifications drive UX:
      //   not_found   → modal shows "create?" prompt (path exists
      //                 nowhere on disk, user might be typing fresh)
      //   not_dir     → hard error (path exists but is a file)
      //   not_readable→ hard error (permission denied)
      //   absolute_required → user gave a relative path
      //   unsafe      → path resolves outside $HOME (refuse to
      //                 create-on-confirm). Reading IS still allowed
      //                 because the user can always cd into anywhere
      //                 manually; this gate only restricts mkdir.
      reason: "not_found" | "not_dir" | "not_readable" | "absolute_required" | "unsafe";
      message?: string;
    };

export function fsRouter() {
  const app = new Hono();

  app.post(
    "/validate-cwd",
    zValidator("json", validateSchema),
    async (c) => {
      const { path: rawPath } = c.req.valid("json");
      const result = await classifyPath(rawPath);
      return c.json(result);
    },
  );

  app.post(
    "/mkdir",
    zValidator("json", mkdirSchema),
    async (c) => {
      const { path: rawPath } = c.req.valid("json");
      const cls = classifySafetyForMkdir(rawPath);
      if (!cls.ok) {
        return c.json(cls, 400);
      }
      try {
        await fsp.mkdir(cls.path, { recursive: true });
        return c.json({ ok: true, path: cls.path });
      } catch (err) {
        return c.json(
          {
            ok: false,
            reason: "mkdir_failed" as const,
            message: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    },
  );

  return app;
}

async function classifyPath(rawPath: string): Promise<ValidateCwdResult> {
  if (!path.isAbsolute(rawPath)) {
    return {
      ok: false,
      reason: "absolute_required",
      message: "cwd must be an absolute path (e.g. /home/user/project)",
    };
  }
  const resolved = path.resolve(rawPath);
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      return { ok: false, reason: "not_found" };
    }
    return {
      ok: false,
      reason: "not_readable",
      message: e?.message ?? String(err),
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      reason: "not_dir",
      message: "Path exists but is a file, not a directory",
    };
  }
  // Read-access probe — stat succeeded but readdir might still EACCES.
  try {
    await fsp.access(resolved, fsp.constants.R_OK);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      reason: "not_readable",
      message: e?.message ?? String(err),
    };
  }
  return { ok: true, path: resolved };
}

function classifySafetyForMkdir(
  rawPath: string,
):
  | { ok: true; path: string }
  | { ok: false; reason: "absolute_required" | "unsafe"; message?: string } {
  if (!path.isAbsolute(rawPath)) {
    return {
      ok: false,
      reason: "absolute_required",
      message: "Directory creation requires an absolute path",
    };
  }
  const resolved = path.resolve(rawPath);
  const home = os.homedir();
  // Must be inside $HOME — refuses /, /etc/, /usr/, etc. to avoid
  // accidental damage outside the user's space.
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return {
      ok: false,
      reason: "unsafe",
      message: `Refusing to create directory outside $HOME (${home})`,
    };
  }
  return { ok: true, path: resolved };
}
