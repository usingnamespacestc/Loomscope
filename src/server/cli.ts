// Entry binary — boots the listener. Wired into `npm run dev:server` and
// (eventually) the published `loomscope-server` bin.

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";

import { serve } from "@hono/node-server";

import { createApp, parseArgs } from "@/server/index";
import {
  getCurrentSecret,
  getOrCreateSecret,
} from "@/server/services/loomscopeSecret";

async function main(): Promise<void> {
  // Drop the `node`/`tsx` and script paths — commander expects the user
  // arg list when called with `from: 'user'`.
  const cli = parseArgs(process.argv.slice(2));
  const csrfToken = process.env.LOOMSCOPE_CSRF_TOKEN ?? crypto.randomBytes(24).toString("hex");
  const allowedOrigin =
    process.env.LOOMSCOPE_ALLOWED_ORIGIN ?? `http://localhost:${cli.port}`;

  // v∞.0 PR 1: load (or generate-and-persist) the per-installation
  // hook secret. CC's settings.json template references it via
  // `$LOOMSCOPE_SECRET` (substituted from the user's shell env at
  // hook fire time); onboarding (PR 3) walks the user through both
  // setup steps. Failing to read/write is non-fatal — see service
  // for graceful-degradation semantics.
  // Prime the in-memory cache; routes use `getCurrentSecret` so a
  // mid-run rotate-secret takes effect without restart.
  await getOrCreateSecret();

  // v1.0 ship prep: detect a built frontend bundle. If `dist/` exists
  // next to the cwd, serve it (production mode = single process for
  // backend + frontend). Otherwise leave undefined so dev mode keeps
  // working — Vite at 5175 owns the frontend and proxies /api.
  // Override path via LOOMSCOPE_STATIC_DIR for non-standard layouts.
  const staticDirOverride = process.env.LOOMSCOPE_STATIC_DIR;
  const candidate =
    staticDirOverride ?? path.resolve(process.cwd(), "dist");
  const staticDir = existsSync(path.join(candidate, "index.html"))
    ? candidate
    : undefined;

  const app = createApp({
    rootDir: cli.rootDir,
    csrfToken,
    allowedOrigin,
    hookSecret: getCurrentSecret,
    staticDir,
  });

  serve({ fetch: app.fetch, port: cli.port, hostname: cli.bind }, (info) => {
    console.log(
      `[loomscope] backend listening at http://${info.address}:${info.port}  (rootDir=${cli.rootDir})`,
    );
    if (staticDir) {
      console.log(`[loomscope] serving frontend bundle from ${staticDir}`);
    } else {
      console.log(
        `[loomscope] frontend bundle not found at ${candidate}; expecting Vite dev server (npm run dev:client)`,
      );
    }
  });
}

void main();
