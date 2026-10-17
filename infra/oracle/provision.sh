#!/usr/bin/env bash
#
# SEIKA — provision a fresh Oracle Cloud VM into a running zone server.
#
# Takes an empty Ubuntu 22.04 ARM instance (Ampere A1, the Always Free shape)
# and leaves you with MongoDB as a replica set, Redis, the API under systemd,
# nginx in front of it, and backups on a cron. Idempotent: safe to re-run.
#
#   scp -i ~/.ssh/oracle_key -r infra/oracle ubuntu@<IP>:/tmp/
#   ssh -i ~/.ssh/oracle_key ubuntu@<IP>
#   sudo bash /tmp/oracle/provision.sh --repo https://github.com/Aman1945/SEIKA-.git
#
# Read infra/oracle/README.md first — two Oracle-specific things will stop you
# dead otherwise, and neither of them is obvious from any error message.

set -Eeuo pipefail

REPO=""
BRANCH="main"
APP_DIR="/opt/seika"
NODE_MAJOR="20"
MONGO_VERSION="7.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --dir) APP_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log()  { printf '\n\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }
trap 'fail "failed at line $LINENO"' ERR

[[ $EUID -eq 0 ]] || fail "Run with sudo."
[[ -n "$REPO" ]] || fail "Pass --repo <git url>."

ARCH="$(uname -m)"
log "Provisioning SEIKA on $(. /etc/os-release && echo "$PRETTY_NAME") ($ARCH)"

# ─── 1. The Oracle firewall ──────────────────────────────────────────────────
#
# Oracle's images ship with an iptables REJECT rule covering everything except
# SSH, *inside* the instance. Opening the VCN security list in the console is
# necessary and not sufficient — people lose hours here, because the port looks
# open from the console and still times out.

log "Opening ports 80 and 443 on the instance firewall"
if command -v netfilter-persistent >/dev/null 2>&1 || apt-get install -y iptables-persistent >/dev/null 2>&1; then
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      # Insert at the top: appending puts it after Oracle's catch-all REJECT,
      # where it never matches.
      iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  done
  netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4
  ok "instance firewall open (and persisted across reboot)"
else
  warn "could not persist iptables — check manually with: iptables -L INPUT -n"
fi

# ─── 2. Packages ─────────────────────────────────────────────────────────────

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates git ufw nginx redis-server \
  python3 gpg cron >/dev/null
ok "base packages"

log "Installing Node ${NODE_MAJOR} and pnpm"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null
corepack prepare pnpm@11.10.0 --activate >/dev/null
ok "node $(node -v), pnpm $(pnpm -v)"

# ─── 3. MongoDB ──────────────────────────────────────────────────────────────
#
# As a single-node REPLICA SET, not a standalone. SEIKA commits every money
# path — wallet debits, refunds, bookings, shop orders, cross-zone payouts —
# inside a multi-document transaction, and transactions require a replica set.
# A standalone mongod starts happily and then fails every one of them.

log "Installing MongoDB ${MONGO_VERSION}"
if ! command -v mongod >/dev/null; then
  curl -fsSL "https://pgp.mongodb.com/server-${MONGO_VERSION}.asc" \
    | gpg -o /usr/share/keyrings/mongodb-server.gpg --dearmor --yes
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/${MONGO_VERSION} multiverse" \
    > /etc/apt/sources.list.d/mongodb-org.list
  apt-get update -qq
  apt-get install -y -qq mongodb-org mongodb-mongosh >/dev/null
fi

# Bind to loopback only. The database must never be reachable from the
# internet; the API talks to it over localhost.
if ! grep -q "replSetName: rs0" /etc/mongod.conf; then
  cat > /etc/mongod.conf <<'CONF'
storage:
  dbPath: /var/lib/mongodb
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 127.0.0.1
replication:
  replSetName: rs0
CONF
fi

systemctl enable --now mongod >/dev/null
sleep 3

if ! mongosh --quiet --eval 'rs.status().ok' >/dev/null 2>&1; then
  mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
  sleep 4
fi
mongosh --quiet --eval 'rs.status().ok' >/dev/null || fail "replica set did not come up"
ok "mongodb running as a single-node replica set (transactions work)"

log "Starting Redis"
systemctl enable --now redis-server >/dev/null
ok "redis on 127.0.0.1:6379"

# ─── 4. The application ──────────────────────────────────────────────────────

log "Fetching the application"
id -u seika >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/seika --shell /usr/sbin/nologin seika

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" pull --quiet
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
SHA="$(git -C "$APP_DIR" rev-parse --short HEAD)"
ok "at $SHA"

log "Building the API"
cd "$APP_DIR"
pnpm install --frozen-lockfile --silent
pnpm --filter @seika/api build >/dev/null
ok "built"

# ─── 5. Configuration ────────────────────────────────────────────────────────
#
# Generated once and never overwritten, so a re-run cannot silently rotate the
# JWT secrets and sign every player out.

ENV_FILE="$APP_DIR/apps/api/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Writing $ENV_FILE"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=4000
SEIKA_RELEASE=${SHA}

# directConnection: the replica set advertises itself as 127.0.0.1, which a
# driver resolving the set topology would otherwise refuse to use.
MONGO_URI=mongodb://127.0.0.1:27017/seika?replicaSet=rs0&directConnection=true
REDIS_URL=redis://127.0.0.1:6379

JWT_ACCESS_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
OTP_TTL_SECONDS=300

RATE_LIMIT_ENABLED=true

# ─── You must fill these in before the API will start ───────────────────────
# Production refuses to boot without them, on purpose: each one fails
# silently and expensively if it is wrong.

# Without a provider nobody can receive a login code.
OTP_PROVIDER=
MSG91_AUTH_KEY=
MSG91_TEMPLATE_ID=
MSG91_SENDER_ID=SEIKA
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
RESEND_API_KEY=
RESEND_FROM_EMAIL=no-reply@seika.gg

# Mock payments in production is refused.
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Your real origins. Boot fails if localhost is left here.
CORS_ORIGINS=

# Optional but strongly recommended: without it, a production failure is
# discovered by a customer.
SENTRY_DSN=
ENV
  chmod 600 "$ENV_FILE"
  ok "written — secrets generated, the rest is yours to fill in"
else
  ok "$ENV_FILE already exists, left alone"
fi

chown -R seika:seika "$APP_DIR"

# ─── 6. systemd ──────────────────────────────────────────────────────────────

log "Installing the systemd service"
cat > /etc/systemd/system/seika-api.service <<UNIT
[Unit]
Description=SEIKA API
After=network-online.target mongod.service redis-server.service
Wants=network-online.target
Requires=mongod.service

[Service]
Type=simple
User=seika
WorkingDirectory=${APP_DIR}/apps/api
EnvironmentFile=${APP_DIR}/apps/api/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
# The API refuses to start on an unsafe config. Without this, systemd would
# restart it forever and the real reason would scroll past in the journal.
StartLimitBurst=5
StartLimitIntervalSec=120

# It serves HTTP and talks to localhost. It has no business doing anything else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/apps/api

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable seika-api >/dev/null
ok "seika-api.service installed"

# ─── 7. nginx ────────────────────────────────────────────────────────────────

log "Installing the nginx site"
mkdir -p /etc/nginx/snippets
cp "$APP_DIR/infra/nginx/snippets/seika-proxy.conf" /etc/nginx/snippets/ 2>/dev/null || true

# Plain HTTP until certbot runs. Serving the API before TLS exists beats
# having no way to check the thing works.
cat > /etc/nginx/sites-available/seika <<'SITE'
upstream seika_api {
    server 127.0.0.1:4000;
    keepalive 32;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 8m;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location /socket.io/ {
        proxy_pass http://seika_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Long, so kiosks do not reconnect every minute.
        proxy_read_timeout 7d;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://seika_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    location = /health/ready { access_log off; proxy_pass http://seika_api; }
}
SITE

mkdir -p /var/www/certbot
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/seika /etc/nginx/sites-enabled/seika
nginx -t >/dev/null && systemctl reload nginx
ok "nginx proxying :80 → :4000"

# ─── 8. Backups ──────────────────────────────────────────────────────────────
#
# The wallet ledger IS the money: balances are derived from it and nothing
# else, so losing it loses every customer's balance with no way to rebuild it.

log "Installing backups"
apt-get install -y -qq mongodb-database-tools >/dev/null 2>&1 || true
install -m 755 "$APP_DIR/infra/scripts/backup.sh" /usr/local/bin/seika-backup
install -m 755 "$APP_DIR/infra/scripts/restore-drill.sh" /usr/local/bin/seika-restore-drill
mkdir -p /var/backups/seika /etc/seika

[[ -f /etc/seika/backup.env ]] || cat > /etc/seika/backup.env <<'BENV'
MONGO_URI=mongodb://127.0.0.1:27017/seika?replicaSet=rs0&directConnection=true
BACKUP_DIR=/var/backups/seika
BACKUP_KEEP_DAYS=14
# Strongly recommended — a backup on this machine does not survive this
# machine. Oracle Object Storage works with the S3-compatible CLI.
S3_BUCKET=
# Pinged on success, so a cron job that stops running is what raises the alarm.
HEALTHCHECK_URL=
BENV
chmod 600 /etc/seika/backup.env

cat > /etc/cron.d/seika-backup <<'CRON'
0 */4 * * * root set -a; . /etc/seika/backup.env; set +a; /usr/local/bin/seika-backup >> /var/log/seika-backup.log 2>&1
0 3 1 * * root set -a; . /etc/seika/backup.env; set +a; /usr/local/bin/seika-restore-drill >> /var/log/seika-drill.log 2>&1
CRON
ok "backups every 4h, restore drill monthly"

# ─── Done ────────────────────────────────────────────────────────────────────

PUBLIC_IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || echo '<this server>')"

cat <<DONE

$(printf '\033[32m━━━ Provisioned ━━━\033[0m')

  MongoDB   replica set rs0, loopback only
  Redis     loopback only
  API       systemd unit seika-api (not started yet)
  nginx     :80 → :4000
  Backups   every 4h to /var/backups/seika

$(printf '\033[33mBefore it will start:\033[0m')

  1. Fill in ${ENV_FILE}
       OTP_PROVIDER + its keys   — without this nobody can log in
       RAZORPAY_KEY_ID/SECRET    — mock payments are refused in production
       CORS_ORIGINS              — your real origins, not localhost

     The API refuses to boot until these are right, and names the one that is
     wrong. That is deliberate: each fails silently and expensively otherwise.

  2. Start it:
       systemctl start seika-api
       journalctl -u seika-api -f

  3. Check it:
       curl -s http://127.0.0.1:4000/health/ready | python3 -m json.tool

  4. Point a domain at ${PUBLIC_IP}, then:
       certbot --nginx -d api.yourdomain.com

  5. Set S3_BUCKET in /etc/seika/backup.env. A backup that only exists on
     this machine does not survive this machine.

DONE
