# loomscope-hook-fanout

Reverse proxy for Claude Code's settings.json HTTP hook path. Lets a
prod Loomscope and a dev Loomscope coexist behind a single CC hook URL
(`http://localhost:5174`) so CC never needs to be reconfigured between
prod/dev workflows.

## Why

`~/.claude/settings.json` configures CC to POST every hook event to
ONE URL. If both prod and dev Loomscope want to receive hooks they
fight for the same port. This fanout middleware listens on the
canonical 5174, validates the same `X-Loomscope-Secret`, and dispatches
to both upstreams concurrently.

## Architecture

```
CC ─POST /api/cc-hook?event=X──▶ this middleware (port 5174)
                                       │
                       ┌───────────────┴───────────────┐
                       ▼                               ▼
            prod Loomscope (5180)            dev Loomscope (5181)
```

### Event dispatch

Two modes, picked by event name:

- **PreToolUse** (interactive permission gate) — *race-with-abort*.
  Send the body to every upstream in parallel, await the first
  DECISIVE response (allow/deny — not "ask"/204). On win, abort every
  other outbound request. The losers' upstream `requestDecision`
  already listens for `AbortSignal` and runs its existing `cleanup()`
  path → existing `permission-prompt-resolved` SSE → UI clears the
  dangling banner. **No upstream code changes needed.**

- **Everything else** (PostToolUse, SessionStart, …) — *fire-and-forget*.
  POST to every upstream concurrently; return 204 to CC immediately
  without waiting. Failures logged, never retried, never propagated.

If every upstream returns non-decisive for PreToolUse (or all error
out), middleware returns 204 and CC falls back to its terminal prompt.

## Run

### Env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `LOOMSCOPE_FANOUT_UPSTREAMS` | ✅ | — | Comma-separated upstream base URLs |
| `LOOMSCOPE_SECRET` | ✅ | — | Same value as `~/.loomscope/secret` on the host |
| `PORT` | | 5174 | TCP port to listen |
| `HOSTNAME` | | `0.0.0.0` | Bind interface (container default) |
| `LOOMSCOPE_FANOUT_PRE_TOOL_USE_TIMEOUT_MS` | | 540000 | Max wait for decisive PreToolUse (9 min) |

### Docker

```bash
# Build (from this directory)
docker build -t loomscope-hook-fanout .

# Run — port mapped to host 127.0.0.1:5174 only
docker run -d --name loom-fanout \
  -p 127.0.0.1:5174:5174 \
  --add-host=host.docker.internal:host-gateway \
  -e LOOMSCOPE_FANOUT_UPSTREAMS=http://host.docker.internal:5180,http://host.docker.internal:5181 \
  -e LOOMSCOPE_SECRET="$(cat ~/.loomscope/secret)" \
  loomscope-hook-fanout
```

### Dev / direct node

```bash
npm install
npm run build
LOOMSCOPE_FANOUT_UPSTREAMS=http://localhost:5180,http://localhost:5181 \
  LOOMSCOPE_SECRET="$(cat ~/.loomscope/secret)" \
  PORT=5174 HOSTNAME=127.0.0.1 \
  npm start
```

## Test

```bash
npm test         # vitest with mock upstreams (no real HTTP)
npm run typecheck
```

27 tests cover: env parsing edge cases, fire-and-forget dispatch +
error swallowing, PreToolUse race (first-decisive wins, ask/204
counted as non-decisive, all-error → ask fallback, timeout fallback),
secret auth on the inbound route, header/body passthrough.

## Health

`GET /api/health` returns `{ok: true, role: "fanout", upstreams: N}`.
Same shape as a Loomscope-prod health check so `~/loomscope-status.sh`
patterns work.
