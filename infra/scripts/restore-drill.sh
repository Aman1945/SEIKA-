#!/usr/bin/env bash
#
# SEIKA — restore drill.
#
# Restores the newest backup into a THROWAWAY database and checks that the
# money still adds up. An untested backup is a guess; this is what turns it
# into a fact. Run it monthly, and after any change to the backup job.
#
#   ./infra/scripts/restore-drill.sh [path/to/dump.archive.gz]
#
# Env:
#   MONGO_URI     where to restore INTO (a scratch server, or the same server —
#                 the drill always restores into its own database name)
#   BACKUP_DIR    where to look for the newest dump (default /var/backups/seika)
#   KEEP_DRILL_DB set to 1 to leave the restored database behind for inspection

set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/seika}"
DRILL_DB="seika_restore_drill_$(date -u +%Y%m%d%H%M%S)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "DRILL FAILED: $*"; exit 1; }
trap 'fail "line $LINENO"' ERR

[[ -n "${MONGO_URI:-}" ]] || fail "MONGO_URI is not set"
command -v mongorestore >/dev/null || fail "mongorestore not found"
command -v mongosh >/dev/null || fail "mongosh not found"

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE=$(find "$BACKUP_DIR" -name 'seika-*.archive.gz' -type f | sort | tail -1)
  [[ -n "$ARCHIVE" ]] || fail "no dump found in ${BACKUP_DIR}"
fi
log "drilling ${ARCHIVE} into ${DRILL_DB}"

AGE_HOURS=$(( ( $(date +%s) - $(stat -c%Y "$ARCHIVE" 2>/dev/null || stat -f%m "$ARCHIVE") ) / 3600 ))
log "backup age: ${AGE_HOURS}h"
[[ "$AGE_HOURS" -lt 24 ]] || log "WARNING: newest backup is over a day old"

# --nsFrom/--nsTo redirects every collection into the scratch database, so a
# drill can never touch production data even by accident.
log "restoring"
mongorestore --uri="$MONGO_URI" --archive="$ARCHIVE" --gzip --quiet \
  --nsFrom='seika.*' --nsTo="${DRILL_DB}.*"

cleanup() {
  if [[ "${KEEP_DRILL_DB:-0}" != "1" ]]; then
    log "dropping ${DRILL_DB}"
    mongosh "$MONGO_URI" --quiet --eval "db.getSiblingDB('${DRILL_DB}').dropDatabase()" >/dev/null || true
  else
    log "leaving ${DRILL_DB} in place (KEEP_DRILL_DB=1)"
  fi
}
trap cleanup EXIT

log "checking the restored data"
RESULT=$(mongosh "$MONGO_URI" --quiet --eval "
const db = db.getSiblingDB('${DRILL_DB}');
const out = { checks: [], failures: [] };

function check(name, ok, detail) {
  out.checks.push({ name, ok, detail });
  if (!ok) out.failures.push(name + ': ' + detail);
}

// 1. The collections that matter are present.
const names = db.getCollectionNames();
for (const c of ['walletledgers', 'players', 'sessions', 'zones']) {
  check('collection:' + c, names.includes(c), names.includes(c) ? '' : 'missing');
}

// 2. There is actually data (an empty restore 'succeeds' silently).
const ledgerCount = db.walletledgers.countDocuments();
check('ledger rows', ledgerCount > 0, 'count=' + ledgerCount);

// 3. Every balance is reconstructible: the ledger sums per player, and no
//    player ends up negative through a rounding or truncation bug in transit.
const balances = db.walletledgers.aggregate([
  { \\\$group: { _id: '\\\$playerId', balance: { \\\$sum: { \\\$toDecimal: '\\\$amount' } } } }
]).toArray();
check('balances computable', balances.length > 0 || ledgerCount === 0, 'players=' + balances.length);

const negative = balances.filter(b => parseFloat(b.balance.toString()) < -0.005);
check('no impossible balances', negative.length === 0, 'negative=' + negative.length);

// 4. Every ledger row still points at a player that exists — a restore that
//    loses the players collection would otherwise look fine.
const orphans = db.walletledgers.aggregate([
  { \\\$lookup: { from: 'players', localField: 'playerId', foreignField: '_id', as: 'p' } },
  { \\\$match: { p: { \\\$size: 0 } } },
  { \\\$count: 'n' }
]).toArray();
const orphanCount = orphans.length ? orphans[0].n : 0;
check('no orphaned ledger rows', orphanCount === 0, 'orphans=' + orphanCount);

// 5. Indexes came back. Without them the booking-overlap and
//    one-live-session-per-PC guards are gone, which is a correctness problem,
//    not a performance one.
const sessionIdx = db.sessions.getIndexes().map(i => i.name);
check(
  'session guard index',
  sessionIdx.includes('one_live_session_per_pc'),
  'indexes=' + sessionIdx.join(',')
);

const total = balances.reduce((s, b) => s + parseFloat(b.balance.toString()), 0);
out.summary = {
  ledgerRows: ledgerCount,
  players: db.players.countDocuments(),
  sessions: db.sessions.countDocuments(),
  walletTotal: Math.round(total * 100) / 100
};
print(JSON.stringify(out));
")

echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"

if echo "$RESULT" | grep -q '"failures": \[\]' || echo "$RESULT" | grep -q '"failures":\[\]'; then
  log "DRILL PASSED — the backup restores and the money adds up"
else
  fail "restored data did not pass its checks (see above)"
fi
