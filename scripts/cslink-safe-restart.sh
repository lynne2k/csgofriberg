#!/usr/bin/env bash
# Run on the app host, with the service user's access to the local control socket.
# Refuses to restart during an active CS Link match or while Redis is unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/cslink-control.mjs drain >/dev/null
if ! node scripts/cslink-control.mjs check-restart; then
  node scripts/cslink-control.mjs resume >/dev/null
  echo '尚有对局或 Redis 不可用：已取消重启、恢复开局。' >&2
  exit 1
fi
if ! sudo systemctl restart cslink.service; then
  node scripts/cslink-control.mjs resume || true
  exit 1
fi
sudo systemctl is-active --quiet cslink.service
