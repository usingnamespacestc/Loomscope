// Boot entrypoint. Reads env config, builds the Hono app, hands off to
// @hono/node-server. Errors at boot (missing env) crash fast — better
// than silently listening with no upstreams.

import { serve } from "@hono/node-server";

import { loadConfigFromEnv } from "./config.js";
import { createApp } from "./server.js";

const config = loadConfigFromEnv();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.hostname,
  },
  (info) => {
    console.log(
      `[fanout] listening on ${info.address}:${info.port} — fanout to ${config.upstreams.length} upstream(s): ${config.upstreams.join(", ")}`,
    );
  },
);
