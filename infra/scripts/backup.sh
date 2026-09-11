#!/usr/bin/env bash
#
# SEIKA — MongoDB backup.
#
# The wallet ledger *is* the money: balances are derived from it and nothing
# else, so losing it is not "losing some analytics", it is losing every
# customer's balance with no way to reconstruct it. This runs from cron.
#
#   0 */4 * * *  /opt/seika/infra/scripts/backup.sh >> /var/log/seika-backup.log 2>&1
#
# Required env (put them in /etc/seika/backup.env and `set -a; . that; set +a`):
#   MONGO_URI          replica-set URI to dump from
#   BACKUP_DIR         local directory for dumps      (default /var/backups/seika)
#   BACKUP_KEEP_DAYS   local retention                (default 14)
# Optional off-box copy — strongly recommended, a backup on the same droplet
# does not survive the droplet:
#   S3_BUCKET          e.g. s3://seika-backups/prod
#   AWS_* / S3 creds as your CLI expects
#   BACKUP_GPG_RECIPIENT  encrypt before upload
#   HEALTHCHECK_URL    pinged on success, so a *missing* backup alerts too

set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/seika}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/seika-${STAMP}.archive.gz"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
trap 'fail "line $LINENO"' ERR

[[ -n "${MONGO_URI:-}" ]] || fail "MONGO_URI is not set"
command -v mongodump >/dev/null || fail "mongodump not found (install mongodb-database-tools)"

mkdir -p "$BACKUP_DIR"

log "dumping to ${ARCHIVE}"
# --oplog makes the dump point-in-time consistent across collections, which is
# what makes a restored ledger trustworthy rather than approximately right.
mongodump --uri="$MONGO_URI" --archive="$ARCHIVE" --gzip --oplog --quiet

SIZE=$(stat -c%s "$ARCHIVE" 2>/dev/null || stat -f%z "$ARCHIVE")
[[ "$SIZE" -gt 1024 ]] || fail "dump is only ${SIZE} bytes — refusing to treat that as a backup"
log "dump ok (${SIZE} bytes)"

# Verify the archive is readable before anything relies on it. A backup nobody
# has opened is a hope, not a backup.
log "verifying archive"
mongorestore --archive="$ARCHIVE" --gzip --dryRun --quiet \
  || fail "archive failed verification — the dump is not restorable"
log "archive verified"

UPLOAD="$ARCHIVE"
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  log "encrypting for ${BACKUP_GPG_RECIPIENT}"
  gpg --batch --yes --trust-model always \
      --recipient "$BACKUP_GPG_RECIPIENT" --encrypt --output "${ARCHIVE}.gpg" "$ARCHIVE"
  UPLOAD="${ARCHIVE}.gpg"
fi

if [[ -n "${S3_BUCKET:-}" ]]; then
  log "uploading to ${S3_BUCKET}"
  aws s3 cp "$UPLOAD" "${S3_BUCKET}/$(basename "$UPLOAD")" --only-show-errors
  log "upload ok"
else
  log "WARNING: S3_BUCKET not set — this backup only exists on this machine"
fi

log "pruning local dumps older than ${BACKUP_KEEP_DAYS} days"
find "$BACKUP_DIR" -name 'seika-*.archive.gz*' -mtime "+${BACKUP_KEEP_DAYS}" -delete

# A cron job that stops running is silent. Pinging a dead-man's-switch on
# success means the *absence* of a backup is what raises the alarm.
if [[ -n "${HEALTHCHECK_URL:-}" ]]; then
  curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null && log "healthcheck pinged"
fi

log "done: $(basename "$UPLOAD")"
