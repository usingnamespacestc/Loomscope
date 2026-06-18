#!/usr/bin/env bash
# r7 prod stack down. Stops the prod Loomscope process + the fanout
# container. Dev (port 5181) is independent and not touched.

set -euo pipefail

REPO_DIR="${LOOMSCOPE_REPO_DIR:-$HOME/Loomscope}"
PROD_PORT="${LOOMSCOPE_PROD_PORT:-5180}"

echo "Stopping prod Loomscope (:${PROD_PORT}) ..."
pids=$(pgrep -f "src/server/cli.ts" || true)
if [ -n "$pids" ]; then
  echo "  kill $pids"
  kill $pids
fi

echo "Stopping fanout container ..."
cd "$REPO_DIR"
docker compose down

echo "Down."
