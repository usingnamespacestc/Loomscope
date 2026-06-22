// Env-driven config for the cc-hook fanout middleware. Loaded once at
// boot; the server passes it into the app factory so tests can build
// app instances with hand-rolled config without touching process.env.

export interface FanoutConfig {
  /** TCP port the Hono server binds to. Container exposes this to host
   *  via `docker run -p 127.0.0.1:5174:5174` so CC's hook URL
   *  (`http://localhost:5174/...`) hits us first.
   *  中: 容器内监听口,docker -p 映射到 host 127.0.0.1:5174。 */
  port: number;
  /** Hostname to bind. In container we want 0.0.0.0 so Docker's port
   *  mapping picks us up; locally for dev you may want 127.0.0.1. */
  hostname: string;
  /** List of upstream Loomscope base URLs (no trailing slash). e.g.
   *  ["http://host.docker.internal:5180", "http://host.docker.internal:5181"]
   *  for prod + dev when both run on the docker host.
   *  中: 上游 Loomscope 基址,逗号分隔. */
  upstreams: string[];
  /** Shared X-Loomscope-Secret. Same secret is in `~/.loomscope/secret`
   *  on the host — every upstream Loomscope and this middleware
   *  validate against the SAME value, so settings.json's
   *  `$LOOMSCOPE_SECRET` substitution works untouched. */
  secret: string;
  /** Max time we'll wait for ANY upstream to return a decisive PreToolUse
   *  response before falling back to "ask" (= CC handles via terminal
   *  prompt). Defaults match upstream's 9-min internal gate timeout. */
  preToolUseDecisiveTimeoutMs: number;
}

const DEFAULT_PORT = 5174;
const DEFAULT_HOSTNAME = "0.0.0.0";
const DEFAULT_PRE_TOOL_USE_TIMEOUT_MS = 9 * 60 * 1000;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FanoutConfig {
  const upstreamsRaw = env.LOOMSCOPE_FANOUT_UPSTREAMS ?? "";
  const upstreams = upstreamsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\/$/, "")); // strip trailing slash for clean concat
  if (upstreams.length === 0) {
    throw new Error(
      "LOOMSCOPE_FANOUT_UPSTREAMS env var required (comma-separated base URLs, e.g. http://host.docker.internal:5180,http://host.docker.internal:5181)",
    );
  }
  const secret = env.LOOMSCOPE_SECRET ?? "";
  if (!secret) {
    throw new Error(
      "LOOMSCOPE_SECRET env var required (same value as upstreams' ~/.loomscope/secret)",
    );
  }
  return {
    port: env.PORT ? Number(env.PORT) : DEFAULT_PORT,
    hostname: env.HOSTNAME ?? DEFAULT_HOSTNAME,
    upstreams,
    secret,
    preToolUseDecisiveTimeoutMs: env.LOOMSCOPE_FANOUT_PRE_TOOL_USE_TIMEOUT_MS
      ? Number(env.LOOMSCOPE_FANOUT_PRE_TOOL_USE_TIMEOUT_MS)
      : DEFAULT_PRE_TOOL_USE_TIMEOUT_MS,
  };
}
