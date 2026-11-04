#!/bin/zsh
# Serves the site to other computers. The main site and the sandbox get two different hostnames for this Mac,
# because the separate sandbox origin is the security boundary.
#   ./start-remote.sh lan        home network: http://<lan-ip>:3000 (any device on the Wi-Fi)
#   ./start-remote.sh tailscale  tailnet only: http://<magicdns-name>:3000 (devices running Tailscale)
#   ./start-remote.sh tunnel     public, through two Cloudflare quick tunnels (random *.trycloudflare.com URLs,
#                                new ones on every start; no account or domain needed). See LAUNCH.md.
#   ./start-remote.sh tunnel <site-host> <sandbox-host>
#                                public, through your own named tunnel (cloudflared runs separately and routes
#                                <site-host> → localhost:3000, <sandbox-host> → localhost:3001). See LAUNCH.md.
cd "$(dirname "$0")"
# Optional private settings, e.g. TURNSTILE_SITE_KEY / TURNSTILE_SECRET (keep the file chmod 600).
[[ -f data/secrets.env ]] && { set -a; source data/secrets.env; set +a; }

# Public modes: listen on 127.0.0.1 only, so the tunnel is the only way in and CF-Connecting-IP can be trusted
# for rate limiting. (Listening on the LAN as well would let anyone on the Wi-Fi fake that header.)
if [[ "$1" == tunnel ]]; then
  export HOST=127.0.0.1 TRUST_PROXY=cloudflare
  SERVER= P1= P2= W=
  # Ctrl-C or kill: stop the server and any quick tunnels, without restarting (exit 0).
  trap 'kill $W $SERVER $P1 $P2 2>/dev/null; wait; exit 0' INT TERM
  # A quick tunnel died (see the watcher below): stop everything and exit 1, so launchd starts it all again.
  trap 'echo "$(date "+%F %T") a quick tunnel stopped; exiting so launchd restarts everything (new URLs)";
        kill $W $SERVER $P1 $P2 2>/dev/null; wait; exit 1' USR1
  trap 'kill $W $SERVER $P1 $P2 2>/dev/null' EXIT
  serve() {  # runs the server and restarts it after a crash (exit code ≠ 0); a clean stop (code 0) ends it
    while true; do
      [[ -f data/secrets.env ]] && { set -a; source data/secrets.env; set +a; }   # re-read, so a reload picks up new keys
      node server.mjs & SERVER=$!
      wait $SERVER; local code=$?
      (( code == 0 )) && return 0
      # 75 is a reload (SIGUSR2): start again at once, since visitors get a 502 until something listens.
      # A crash waits 5 s, so a server that dies at startup doesn't spin.
      if (( code == 75 )); then echo "$(date '+%F %T') server reloading"; continue; fi
      echo "$(date '+%F %T') server exited with code $code; restarting in 5 s"
      sleep 5
    done
  }
  if [[ -n "$2" ]]; then
    [[ -z "$3" ]] && { echo "usage: $0 tunnel <site-host> <sandbox-host>"; exit 1; }
    echo "Public: https://$2  (sandbox https://$3)"
    export MAIN_ORIGIN=https://$2 SANDBOX_ORIGIN=https://$3
    serve
    exit $?
  fi
  command -v cloudflared >/dev/null || { echo "cloudflared not installed: brew install cloudflared"; exit 1; }
  # One quick tunnel per origin. trycloudflare.com is on the Public Suffix List, so the two random hostnames
  # are different sites, like two separately registered domains.
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 >data/tunnel-site.log 2>&1 &
  P1=$!
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3001 >data/tunnel-sandbox.log 2>&1 &
  P2=$!
  url_in() {  # waits up to 30 s for the tunnel's URL to appear in its log
    for _ in {1..60}; do
      grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$1" | head -1 | grep . && return
      sleep 0.5
    done
  }
  MAIN=$(url_in data/tunnel-site.log)
  SANDBOX=$(url_in data/tunnel-sandbox.log)
  [[ -z "$MAIN" || -z "$SANDBOX" ]] && { echo "a quick tunnel didn't start; see data/tunnel-*.log"; exit 1; }
  echo "Public: $MAIN  (sandbox $SANDBOX)"
  # The tunnels stay up while the server restarts, so the URLs don't change after a crash.
  export MAIN_ORIGIN=$MAIN SANDBOX_ORIGIN=$SANDBOX
  # Watch both tunnels; if either process exits, tell this script (USR1 trap above).
  ( while kill -0 $P1 2>/dev/null && kill -0 $P2 2>/dev/null; do sleep 10; done; kill -USR1 $$ ) &
  W=$!
  serve
  exit $?
fi

case "${1:-lan}" in
  lan)
    # Same IP, different ports: separate origins (enough while the iframe is sandboxed and the site sets no
    # cookies). .local names don't resolve on many phones/PCs, so use the IP for both.
    IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1)"
    NAME=$IP
    BIND=0.0.0.0 ;;
  tailscale)
    TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
    command -v tailscale >/dev/null && TS=tailscale
    read -r NAME IP <<<"$($TS status --self --json | python3 -c 'import json,sys;d=json.load(sys.stdin)["Self"];print(d["DNSName"].rstrip("."), d["TailscaleIPs"][0])')"
    BIND=$IP ;;
  *) echo "usage: $0 [lan|tailscale|tunnel [<site-host> <sandbox-host>]]"; exit 1 ;;
esac
[[ -z "$NAME" || -z "$IP" ]] && { echo "couldn't find this Mac's name/IP for $1"; exit 1; }
echo "Open http://$NAME:3000 from the other computer."
HOST=$BIND MAIN_ORIGIN=http://$NAME:3000 SANDBOX_ORIGIN=http://$IP:3001 exec node server.mjs
