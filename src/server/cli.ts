// Entry binary — boots the listener. Wired into `npm run dev:server` and
// (eventually) the published `loomscope-server` bin.

import * as crypto from "node:crypto";

import { serve } from "@hono/node-server";

import { createApp, parseArgs } from "@/server/index";

function main(): void {
  // Drop the `node`/`tsx` and script paths — commander expects the user
  // arg list when called with `from: 'user'`.
  const cli = parseArgs(process.argv.slice(2));
  const csrfToken = process.env.LOOMSCOPE_CSRF_TOKEN ?? crypto.randomBytes(24).toString("hex");
  const allowedOrigin =
    process.env.LOOMSCOPE_ALLOWED_ORIGIN ?? `http://localhost:${cli.port}`;

  const app = createApp({ rootDir: cli.rootDir, csrfToken, allowedOrigin });

  serve({ fetch: app.fetch, port: cli.port, hostname: cli.bind }, (info) => {
    console.log(
      `[loomscope] backend listening at http://${info.address}:${info.port}  (rootDir=${cli.rootDir})`,
    );
  });
}

main();
