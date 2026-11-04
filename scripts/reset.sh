#!/bin/zsh
# Starts the site over: no history except the first page, empty queue.
# Keeps the admin token, IP salt and data/secrets.env. The old database is saved in data/backups/.
#   scripts/reset.sh       asks first
#   scripts/reset.sh -y    doesn't ask
# If the site runs as the launch agent, it's stopped and started again; otherwise the server must be stopped first.
set -e
cd "$(dirname "$0")/.."
AGENT=gui/$(id -u)/com.dylanfisher.self-rewriting-page
PLIST=~/Library/LaunchAgents/com.dylanfisher.self-rewriting-page.plist

if [[ "$1" != -y ]]; then
  read -q "?Delete all versions and suggestions? (a backup is kept) [y/N] " || { echo; echo "Nothing changed."; exit 1; }
  echo
fi

agent=0
if launchctl print $AGENT >/dev/null 2>&1; then
  agent=1
  launchctl bootout $AGENT
fi
for _ in {1..40}; do lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null || break; sleep 0.25; done
if lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null; then
  echo "A server is still running on port 3000 (not the launch agent). Stop it, then run this again."
  exit 1
fi

if [[ -f data/site.db ]]; then
  mkdir -p data/backups
  backup=data/backups/site-$(date +%Y%m%d-%H%M%S).db
  sqlite3 data/site.db ".backup '$backup'"
  chmod 600 "$backup"
  rm -f data/site.db data/site.db-wal data/site.db-shm
  echo "Old database saved as $backup"
fi

if (( agent )); then
  launchctl bootstrap gui/$(id -u) $PLIST
  for _ in {1..40}; do lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null && break; sleep 0.25; done
  lsof -tiTCP:3000 -sTCP:LISTEN >/dev/null && echo "Started fresh: $(grep -E '^Public' data/server.log | tail -1)" \
    || echo "The server didn't come back; see data/server.log"
else
  echo "Fresh database ready; it's created on the next server start."
fi
