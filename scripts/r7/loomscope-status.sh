#!/usr/bin/env bash
# r7 prod stack status. Reports fanout container + prod + dev all in
# one shot — used by the Mac side to know what's up before opening
# tunnels.

PROD_PORT="${LOOMSCOPE_PROD_PORT:-5180}"
DEV_PORT="${LOOMSCOPE_DEV_PORT:-5181}"

# --- fanout ---
fanout_health=$(curl -sf http://localhost:5174/api/health 2>/dev/null || echo "")
if [ -n "$fanout_health" ]; then
  echo "fanout    :5174  RUNNING  $fanout_health"
else
  echo "fanout    :5174  NOT running"
fi

# --- prod ---
prod_health=$(curl -sf "http://localhost:${PROD_PORT}/api/health" 2>/dev/null || echo "")
if [ -n "$prod_health" ]; then
  prod_pids=$(pgrep -f "src/server/cli.ts" | head -1)
  up=""
  if [ -n "$prod_pids" ]; then
    up=$(ps -o etime= -p "$prod_pids" 2>/dev/null | tr -d ' ')
  fi
  echo "prod      :${PROD_PORT}  RUNNING  uptime=${up:-?}  $prod_health"
else
  echo "prod      :${PROD_PORT}  NOT running"
fi

# --- dev (best-effort sniff) ---
dev_health=$(curl -sf "http://localhost:${DEV_PORT}/api/health" 2>/dev/null || echo "")
if [ -n "$dev_health" ]; then
  echo "dev       :${DEV_PORT}  RUNNING  $dev_health"
else
  echo "dev       :${DEV_PORT}  not running (normal unless actively developing)"
fi
