#!/usr/bin/env bash
#
# Builds the dashboard and player as static sites for the demo.
#
#   bash infra/oracle/demo/build-demo.sh http://137.23.63.19
#
# Output: apps/dashboard/out and apps/player/out, ready to copy to the server.
#
# They are served from the SAME origin as the API on purpose. A demo on another
# host or port is cross-origin, which means configuring CORS for it; and a demo
# on HTTPS pointing at an HTTP API is blocked outright by the browser as mixed
# content, with nothing in the UI to say why.

set -Eeuo pipefail

API_URL="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ -z "$API_URL" ]]; then
  echo "Usage: build-demo.sh <api-url>      e.g. http://137.23.63.19"
  exit 1
fi
API_URL="${API_URL%/}"

log() { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }

cd "$ROOT"

build() {
  local app="$1" base="$2"
  log "Building ${app} → ${base}"
  rm -rf "apps/${app}/out"
  SEIKA_STATIC_BASE="$base" NEXT_PUBLIC_API_URL="$API_URL" \
    pnpm --filter "@seika/${app}" build >/dev/null
  [[ -f "apps/${app}/out/index.html" ]] || { echo "no static output for ${app}"; exit 1; }
  ok "$(find "apps/${app}/out" -type f | wc -l | tr -d ' ') files"
}

build dashboard /demo/dashboard
build player /demo/player

# The manifest is copied verbatim from public/, so basePath never reaches it.
# Left alone, "Add to Home Screen" installs an icon that opens the API's JSON
# instead of the app — which looks like the app is broken, on a phone, in front
# of whoever you are demoing to.
log "Pointing the PWA manifest at the demo path"
python3 - <<PY
import json, pathlib
p = pathlib.Path("apps/player/out/manifest.webmanifest")
m = json.loads(p.read_text())
m["start_url"] = "/demo/player/"
m["scope"] = "/demo/player/"
m["icons"] = [{**i, "src": "/demo/player" + i["src"]} for i in m.get("icons", [])]
p.write_text(json.dumps(m, indent=2))
print("  start_url:", m["start_url"])
PY
ok "manifest patched"

cat <<DONE

$(printf '\033[32m━━━ Built ━━━\033[0m')

  apps/dashboard/out   →  ${API_URL}/demo/dashboard/
  apps/player/out      →  ${API_URL}/demo/player/

  Next:  bash infra/oracle/demo/deploy-demo.sh <user>@<host> --key ~/.ssh/<key>

DONE
