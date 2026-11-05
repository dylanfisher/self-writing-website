#!/bin/zsh
# Switch the model that writes the page: scripts/use-model.sh <omlx model id>
# No argument: lists the models omlx has and which one is in use.
# Writes data/model and reloads the server (USR2: the suggestion being written finishes on the old model first).
# omlx loads the new model on the next request (the first suggestion after a switch waits for that).
set -euo pipefail
cd "${0:A:h}/.."
MODELS=~/.omlx/models
current=$(node -e 'import("./lib/model.mjs").then((m) => console.log(m.MODEL))' 2>/dev/null || echo "?")

if [[ $# -eq 0 ]]; then
  echo "In use: $current"
  echo "Available (in $MODELS):"
  for d in $MODELS/*(/); do
    n=${d:t}
    [[ -f $d/config.json ]] || continue
    [[ $n == *DFlash* ]] && continue   # draft models for speculative decoding, not page writers
    print "  ${n}$([[ $n == $current ]] && echo '  ← in use')"
  done
  exit 0
fi

want=$1
[[ -f $MODELS/$want/config.json ]] || { echo "No model '$want' in $MODELS (run with no argument to list them)" >&2; exit 1; }
[[ -n ${MODEL:-} ]] && echo "Note: \$MODEL is set in this shell; the server only sees data/secrets.env and data/model." >&2
if grep -q '^ *\(export \)\?MODEL=' data/secrets.env 2>/dev/null; then
  echo "data/secrets.env sets MODEL, which wins over data/model: remove that line first." >&2; exit 1
fi
[[ $want == $current ]] && { echo "Already using $want"; exit 0; }

busy=$(sqlite3 data/site.db "select count(*) from suggestions where status in ('queued','running')")
[[ $busy -gt 0 ]] && echo "$busy suggestion(s) queued or running: the running one finishes on $current, the rest go to $want."

echo $want > data/model
pid=$(lsof -tiTCP:3000 -sTCP:LISTEN | head -1)
[[ -n $pid ]] || { echo "data/model now says $want; the server isn't running, so it takes effect when it starts."; exit 0; }
kill -USR2 $pid
echo "Switched data/model: $current → $want. Reloading (waits for a running suggestion)…"
for i in {1..120}; do
  line=$(tail -n 20 data/server.log | grep -E 'run: reload (done|failed)' | tail -1 || true)
  if [[ -n $line && $line != ${last:-} && $i -gt 1 ]]; then echo $line; exit 0; fi
  [[ $i -eq 1 ]] && last=$line
  sleep 5
done
echo "No 'run: reload done' in data/server.log after 10 min; check it." >&2
