#!/usr/bin/env bash
# r7 prod stack up. Brings up the fanout container (port 5174) + the
# main Loomscope server on port 5180. Idempotent.
#
# Invoked from the Mac via:
#   ssh -t -L 5180:localhost:5180 r7 'bash ~/loomscope-up.sh'
#
# Why 5180 (not 5174): the fanout container now occupies 5174 on the
# host so CC's settings.json never has to change between prod-only and
# prod+dev setups. Mac tunnels straight to the prod server's 5180.
#
# Architecture:
#   Mac SSH-L:5180 ────────▶ r7:5180  (prod Loomscope, bare node)
#   CC ──hooks──▶ r7:5174 fanout container ─▶ r7:5180 (prod) + r7:5181 (dev)

set -euo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

REPO_DIR="${LOOMSCOPE_REPO_DIR:-$HOME/Loomscope}"
PROD_PORT="${LOOMSCOPE_PROD_PORT:-5180}"
LOG="${LOOMSCOPE_LOG:-$HOME/loomscope.log}"

if [ ! -f "$HOME/.loomscope/secret" ]; then
  echo "ERROR: ~/.loomscope/secret not found. First-run: start Loomscope once" >&2
  echo "       directly (the server will generate one) or copy from another host." >&2
  exit 1
fi
export LOOMSCOPE_SECRET="$(cat "$HOME/.loomscope/secret")"

# --- 1. fanout container ----------------------------------------------------
if curl -sf http://localhost:5174/api/health >/dev/null 2>&1; then
  echo "fanout: already up on :5174"
else
  echo "fanout: starting via docker compose ..."
  cd "$REPO_DIR"
  docker compose up -d --build fanout
  for i in $(seq 1 30); do
    curl -sf http://localhost:5174/api/health >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf http://localhost:5174/api/health >/dev/null 2>&1; then
    echo "fanout: up"
  else
    echo "fanout: FAILED — docker compose logs fanout" >&2
    exit 1
  fi
fi

# --- 2. prod loomscope server ----------------------------------------------
if curl -sf "http://localhost:${PROD_PORT}/api/health" >/dev/null 2>&1; then
  echo "prod: already up on :${PROD_PORT}"
else
  echo "prod: building + starting on :${PROD_PORT} ..."
  cd "$REPO_DIR"
  npx vite build >/tmp/loomscope-build.log 2>&1 || \
    echo "prod: build warning (see /tmp/loomscope-build.log)"
  setsid nohup npm start -- -p "$PROD_PORT" >"$LOG" 2>&1 </dev/null &
  for i in $(seq 1 60); do
    curl -sf "http://localhost:${PROD_PORT}/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf "http://localhost:${PROD_PORT}/api/health" >/dev/null 2>&1; then
    echo "prod: up on :${PROD_PORT}"
  else
    echo "prod: FAILED — tail $LOG" >&2
    exit 1
  fi
fi

cat <<EOF

────────────────────────────────────────
Prod stack up.

  fanout    :5174  (docker:loom-fanout)
  prod      :${PROD_PORT}  (bare node)

Open http://localhost:${PROD_PORT} on your Mac (tunneled).
CC hooks go through localhost:5174 → fan to prod + dev (if dev is up).

Ctrl-C closes the tunnel; everything stays up on r7.
────────────────────────────────────────
EOF
exec sleep infinity
