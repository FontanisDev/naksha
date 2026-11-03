#!/bin/sh
# Naksha — nano-pty keeper. Double-fork friendly: run via
#   ( setsid sh mini-services/nano-pty/keeper.sh >/dev/null 2>&1 & )
# MULTIPLE keeper instances are safe: every instance monitors the port's
# health endpoint first and only spawns the service when nobody answers.
# Runs NODE (not bun): bun + node-pty SIGHUPs interactive children —
# probed and documented in index.ts. `node --watch` (via bun run dev)
# provides file-change restarts; this loop handles crashes.
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/naksha-nano-pty.log
while true; do
  if curl -s --max-time 2 http://127.0.0.1:3005/ | grep -q nano-pty; then
    sleep 5
    continue
  fi
  cd "$DIR" || exit 1
  echo "[keeper $(date -Iseconds)] starting nano-pty (node)" >> "$LOG"
  bun run dev >> "$LOG" 2>&1
  echo "[keeper $(date -Iseconds)] nano-pty exited (code $?); restarting in 2s" >> "$LOG"
  sleep 2
done
