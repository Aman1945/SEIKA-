#!/usr/bin/env bash
#
# Puts the built demo on the server and wires nginx to serve it.
#
#   bash infra/oracle/demo/deploy-demo.sh ubuntu@137.23.63.19 --key ~/.ssh/oracle-sabre.key
#
# Run build-demo.sh first.
#
# This touches nginx on a machine that may be serving other things, so it works
# the careful way: back up the config, change it only if the change is not
# already there, test it, and restore the backup if the test fails. nginx is
# never reloaded with a config that has not passed `nginx -t`.

set -Eeuo pipefail

TARGET="${1:-}"
KEY=""
SEED=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY="$2"; shift 2 ;;
    --seed) SEED=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WEBROOT="/var/www/seika-demo"
SITE="/etc/nginx/sites-available/seika"

[[ -n "$TARGET" ]] || { echo "Usage: deploy-demo.sh <user>@<host> [--key <path>] [--seed]"; exit 1; }
[[ -d "$ROOT/apps/player/out" ]] || { echo "No build found. Run build-demo.sh first."; exit 1; }

SSH=(ssh -o ConnectTimeout=10); [[ -n "$KEY" ]] && SSH+=(-i "$KEY"); SSH+=("$TARGET")
RSYNC_E="ssh"; [[ -n "$KEY" ]] && RSYNC_E="ssh -i $KEY"

log() { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }

# ─── 1. Files ────────────────────────────────────────────────────────────────

log "Copying the built sites"
"${SSH[@]}" "sudo mkdir -p ${WEBROOT}/demo/dashboard ${WEBROOT}/demo/player && sudo chown -R \$(id -un):\$(id -gn) ${WEBROOT}"
rsync -az --delete -e "$RSYNC_E" "$ROOT/apps/dashboard/out/" "${TARGET}:${WEBROOT}/demo/dashboard/"
rsync -az --delete -e "$RSYNC_E" "$ROOT/apps/player/out/"    "${TARGET}:${WEBROOT}/demo/player/"
"${SSH[@]}" "sudo chown -R www-data:www-data ${WEBROOT} && sudo chmod -R a+rX ${WEBROOT}"
ok "copied to ${WEBROOT}"

# ─── 2. nginx ────────────────────────────────────────────────────────────────

log "Wiring nginx"
"${SSH[@]}" "sudo bash -s" <<'REMOTE'
set -Eeuo pipefail
SITE="/etc/nginx/sites-available/seika"
WEBROOT="/var/www/seika-demo"

if [[ ! -f "$SITE" ]]; then
  echo "  ✗ $SITE not found — is SEIKA installed by provision.sh?"
  exit 1
fi

if grep -q "location /demo/" "$SITE"; then
  echo "  ✓ demo locations already present"
  exit 0
fi

BACKUP="${SITE}.before-demo.$(date +%Y%m%d%H%M%S)"
cp "$SITE" "$BACKUP"
echo "  backed up to $BACKUP"

# Inserted before `location /`, which proxies everything to the API. nginx
# prefers the longest matching prefix, so order is not strictly what decides
# this — but keeping them above the catch-all makes the file readable.
python3 - "$SITE" "$WEBROOT" <<'PY'
import sys, re
site, webroot = sys.argv[1], sys.argv[2]
s = open(site).read()

block = f"""
    # ─── Demo (static exports, same origin as the API so no CORS) ───────────
    #
    # `root`, not `alias`: the URI path /demo/<app>/ matches the directory
    # layout under the web root, and alias+try_files is a well-known nginx
    # trap. try_files resolves /demo/player/play/ to its index.html, which is
    # how a static export addresses a route.
    location /demo/ {{
        root {webroot};
        try_files $uri $uri/ $uri.html =404;

        location ~ ^/demo/(dashboard|player)/_next/static/ {{
            root {webroot};
            expires 1y;
            add_header Cache-Control "public, immutable";
        }}
    }}

"""
m = re.search(r"\n(\s*)location / \{", s)
if not m:
    sys.exit("could not find `location /` to insert before")
s = s[:m.start()] + "\n" + block + s[m.start():].lstrip("\n")
open(site, "w").write(s)
print("  inserted demo locations")
PY

if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  echo "  ✓ nginx reloaded"
else
  echo "  ✗ nginx -t failed — restoring the backup, nothing changed"
  cp "$BACKUP" "$SITE"
  nginx -t
  exit 1
fi
REMOTE

# ─── 3. Seed ─────────────────────────────────────────────────────────────────

if [[ $SEED -eq 1 ]]; then
  log "Seeding demo data"
  # Copied rather than assumed: /opt/seika was put there by rsync, not a clone,
  # so it has no way to pull this file and may predate it entirely.
  rsync -az -e "$RSYNC_E" "$ROOT/infra/oracle/demo/seed-demo.mjs" "${TARGET}:/tmp/seed-demo.mjs"
  "${SSH[@]}" "sudo install -o seika -g seika -m 644 /tmp/seed-demo.mjs /opt/seika/seed-demo.mjs \
     && cd /opt/seika && sudo -u seika node seed-demo.mjs \
     && sudo rm -f /opt/seika/seed-demo.mjs /tmp/seed-demo.mjs"
fi

# ─── 4. Check ────────────────────────────────────────────────────────────────

HOST="${TARGET#*@}"
log "Checking"
for p in /demo/player/ /demo/dashboard/ /health; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://${HOST}${p}")"
  if [[ "$CODE" == "200" ]]; then ok "${p} → ${CODE}"; else printf '\033[31m  ✗ %s → %s\033[0m\n' "$p" "$CODE"; fi
done

cat <<DONE

$(printf '\033[32m━━━ Demo is live ━━━\033[0m')

  Player   http://${HOST}/demo/player/
  Console  http://${HOST}/demo/dashboard/

  Sign in with any phone number — the staging server returns the OTP code
  and the login screen fills it in. That is what makes the demo work without
  an SMS provider, and it is exactly what must be switched off before this
  server handles real money.

DONE
