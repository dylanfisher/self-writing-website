#!/bin/sh
# Prints the admin link (the server log only shows it masked). It's a secret: don't paste it anywhere public.
cd "$(dirname "$0")/.." || exit 1
origin=$(grep -E '^main ' data/server.log | tail -1 | awk '{print $2}')
echo "${origin:-http://localhost:3000}/#admin=$(tr -d '\n' < data/admin-token)"
