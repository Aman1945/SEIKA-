#!/usr/bin/env bash
#
# SEIKA — deploy the API on a single box.
#
#   ./infra/scripts/deploy.sh            # deploy HEAD
#   ./infra/scripts/deploy.sh v1.2.0     # deploy a tag
#   ROLLBACK=1 ./infra/scripts/deploy.sh # go back to the previous release
#
# Deliberately boring: build, health-check the new container, then swap. The
# old image is kept tagged so a rollback is one command and not a rebuild.

set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/opt/seika}"
COMPOSE="docker compose -f ${REPO_DIR}/infra/docker-compose.yml --profile app"
REF="${1:-HEAD}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "DEPLOY FAILED: $*"; exit 1; }
trap 'fail "line $LINENO"' ERR

cd "$REPO_DIR"

if [[ "${ROLLBACK:-0}" == "1" ]]; then
  log "rolling back to seika-api:previous"
  docker image inspect seika-api:previous >/dev/null 2>&1 \
    || fail "no previous image to roll back to"
  docker tag seika-api:previous seika-api:latest
  $COMPOSE up -d --no-build api
  log "rolled back"
  exit 0
fi

# Take a backup before changing anything. A migration or a bad release is
# exactly when the previous night's dump turns out to matter.
if [[ -x "${REPO_DIR}/infra/scripts/backup.sh" ]]; then
  log "pre-deploy backup"
  "${REPO_DIR}/infra/scripts/backup.sh" || log "WARNING: pre-deploy backup failed"
fi

log "fetching ${REF}"
git fetch --all --tags --quiet
git checkout --quiet "$REF"
SHA="$(git rev-parse --short HEAD)"
log "deploying ${SHA}"

# Keep the currently-running image as the rollback target.
if docker image inspect seika-api:latest >/dev/null 2>&1; then
  docker tag seika-api:latest seika-api:previous
fi

log "building"
SEIKA_RELEASE="$SHA" $COMPOSE build api

log "starting"
SEIKA_RELEASE="$SHA" $COMPOSE up -d api

log "waiting for readiness"
for i in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:4000/health/ready >/dev/null 2>&1; then
    log "ready after ${i}s"
    READY=1
    break
  fi
  sleep 1
done

if [[ "${READY:-0}" != "1" ]]; then
  log "new release never became ready — rolling back"
  docker tag seika-api:previous seika-api:latest 2>/dev/null || true
  $COMPOSE up -d --no-build api
  fail "readiness check timed out; rolled back"
fi

# Reload nginx rather than restart: a restart drops every live Socket.IO
# connection, which means every kiosk in every zone reconnects at once.
if command -v nginx >/dev/null; then
  nginx -t && systemctl reload nginx && log "nginx reloaded"
fi

RELEASE=$(curl -fsS http://127.0.0.1:4000/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["release"])')
log "deployed ${SHA} (serving release=${RELEASE})"
