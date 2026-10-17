#!/usr/bin/env bash
#
# SEIKA — check a live deployment, outside in.
#
#   bash infra/oracle/verify.sh api.yourdomain.com
#   bash infra/oracle/verify.sh 140.238.x.x --ssh ubuntu --key ~/.ssh/oracle_key
#
# Without --ssh it checks what the internet can see. With it, it also checks
# the things that only make sense from inside the box — the replica set, an
# actual committed transaction, the backup cron.
#
# Each check is ordered so the first failure tells you which layer is wrong,
# rather than leaving you with "it doesn't work".

set -uo pipefail

HOST="${1:-}"
SSH_USER=""
SSH_KEY=""
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh) SSH_USER="$2"; shift 2 ;;
    --key) SSH_KEY="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "Usage: verify.sh <host-or-ip> [--ssh <user>] [--key <path>]"
  exit 1
fi

# A bare host or IP. With a port attached, the per-port probes below build
# nonsense addresses and report ports as open that were never tested.
HOST="${HOST#http://}"; HOST="${HOST#https://}"; HOST="${HOST%%/*}"
if [[ "$HOST" == *:* ]]; then
  echo "Pass a host or IP without a port — nginx is expected on 80/443."
  echo "  got: ${HOST}"
  exit 1
fi

PASS=0; FAIL=0; WARN=0
ok()   { printf '\033[32m  PASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '\033[31m  FAIL\033[0m  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        \033[90m%s\033[0m\n' "$2"; FAIL=$((FAIL+1)); }
warn() { printf '\033[33m  WARN\033[0m  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        \033[90m%s\033[0m\n' "$2"; WARN=$((WARN+1)); }
section() { printf '\n\033[36m▸ %s\033[0m\n' "$1"; }

# Is a TCP port open, within a hard time limit?
#
# Done with curl rather than nc or bash's /dev/tcp. A *filtered* port — which
# is exactly what both Oracle firewalls produce — silently drops the SYN, and
# `nc -z` sits there regardless of -w/-G. macOS has no `timeout` to wrap it in.
# curl bounds itself, and its exit code distinguishes the two failures that
# mean different things here:
#
#   7  connection refused — the host answered, nothing is listening
#   28 timed out          — a firewall is dropping the packet
#   anything else         — the TCP connection was established
port_open() {
  local host="$1" port="$2" limit="${3:-5}" rc
  curl -s --connect-timeout "$limit" --max-time "$((limit + 3))" \
       -o /dev/null "http://${host}:${port}/" </dev/null
  rc=$?
  [[ $rc -eq 7 || $rc -eq 28 ]] && return 1
  return 0
}

SSH=()
if [[ -n "$SSH_USER" ]]; then
  SSH=(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
  [[ -n "$SSH_KEY" ]] && SSH+=(-i "$SSH_KEY")
  SSH+=("${SSH_USER}@${HOST}")
fi
remote() { "${SSH[@]}" "$@" 2>/dev/null; }

echo
echo "Checking ${HOST}"

# ─── From the internet ───────────────────────────────────────────────────────

section "What the internet can reach"

# Is anything listening at all? This is the check that catches both Oracle
# traps — the VCN security list and the instance's own baked-in iptables.
for port in 80 443; do
  if port_open "$HOST" "$port" 6; then
    ok "port ${port} is open"
  else
    bad "port ${port} is not reachable" \
        "VCN security list ingress, then: sudo iptables -L INPUT -n --line-numbers"
  fi
done

SCHEME="https"
if ! curl -fsS --max-time 10 "https://${HOST}/health" >/dev/null 2>&1; then
  SCHEME="http"
fi
BASE="${SCHEME}://${HOST}"

if [[ "$SCHEME" == "https" ]]; then
  ok "TLS is serving"
  EXPIRY="$(echo | openssl s_client -servername "$HOST" -connect "${HOST}:443" 2>/dev/null \
            | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [[ -n "$EXPIRY" ]] && printf '        \033[90mcertificate expires %s\033[0m\n' "$EXPIRY"
else
  warn "no TLS — running over plain HTTP" \
       "JWTs, OTP codes and the kiosk socket cross the network in clear text. certbot --nginx"
fi

# ─── The API ─────────────────────────────────────────────────────────────────

section "The API"

HEALTH="$(curl -fsS --max-time 10 "${BASE}/health" 2>/dev/null)"
IS_SEIKA=0
if echo "$HEALTH" | grep -qE '"(status|uptime|env)"'; then
  IS_SEIKA=1
  ok "/health answers, and it is the SEIKA API"
elif [[ -n "$HEALTH" ]]; then
  bad "something answers /health, but it is not the SEIKA API" \
      "nginx may be serving a default site. $(printf '%s' "$HEALTH" | cut -c1-120)"
else
  bad "/health does not answer" "On the server: systemctl status seika-api; journalctl -u seika-api -n 50"
fi

READY=""
[[ $IS_SEIKA -eq 1 ]] && READY="$(curl -sS --max-time 15 "${BASE}/health/ready" 2>/dev/null)"
if [[ -n "$READY" ]]; then
  if echo "$READY" | grep -qiE '"(status|ok)":\s*("ok"|"ready"|true)'; then
    ok "/health/ready reports healthy"
  else
    bad "/health/ready reports a problem" "$(echo "$READY" | head -c 300)"
  fi
  echo "$READY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit()
for k, v in (d.get("checks") or d.get("dependencies") or {}).items():
    state = v if isinstance(v, str) else (v.get("status") or v.get("ok"))
    print(f"        \033[90m{k}: {state}\033[0m")
' 2>/dev/null
elif [[ $IS_SEIKA -eq 1 ]]; then
  bad "/health/ready did not respond"
fi

# The API must not be announcing itself as a development build.
if echo "$HEALTH" | grep -q '"env":"production"'; then
  ok "running as NODE_ENV=production"
elif [[ -n "$HEALTH" ]]; then
  warn "not running as production" \
       "Dev mode skips the config assertions that block mock payments and default secrets."
fi

# ─── Config that fails silently ──────────────────────────────────────────────
#
# Each of these is a setting that lets the server run perfectly while doing
# something expensive. A green health check says nothing about them.

section "The settings that fail quietly"

if [[ $IS_SEIKA -eq 0 ]]; then
  warn "skipped — the SEIKA API did not answer, so these cannot be judged"
fi
if [[ $IS_SEIKA -eq 1 ]]; then

# An OTP request on a nonsense number should be accepted (the API must not
# confirm whether a number is registered) but must never return the code.
OTP="$(curl -sS --max-time 10 -X POST "${BASE}/api/auth/otp/request" \
       -H 'content-type: application/json' \
       -d '{"identifier":"9999900000"}' 2>/dev/null)"
if echo "$OTP" | grep -q 'devCode'; then
  bad "the OTP endpoint is returning the code in its response" \
      "OTP_PROVIDER is console. Anyone can log in as anyone. Set msg91/twilio/resend."
elif [[ -n "$OTP" ]]; then
  ok "OTP codes are not returned over the API"
else
  warn "could not reach the OTP endpoint"
fi

# CORS must not be echoing arbitrary origins.
ACAO="$(curl -sS --max-time 10 -o /dev/null -D - \
        -H 'Origin: https://evil.example.com' "${BASE}/health" 2>/dev/null \
        | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')"
if [[ "$ACAO" == "https://evil.example.com" || "$ACAO" == "*" ]]; then
  bad "CORS accepts any origin (${ACAO})" "Set CORS_ORIGINS to your real client origins."
else
  ok "CORS does not echo unknown origins"
fi

fi

# The database must not be exposed. If this ever succeeds, treat the data as
# compromised: open MongoDB instances are found by scanners within hours.
for port in 27017 6379; do
  if port_open "$HOST" "$port" 4; then
    bad "port ${port} is reachable from the internet" \
        "This must be loopback only. Close it in the VCN security list now."
  else
    ok "port ${port} is closed to the internet"
  fi
done

# ─── From inside ─────────────────────────────────────────────────────────────

if [[ -n "$SSH_USER" ]]; then
  section "On the server"

  if ! remote true; then
    bad "cannot SSH as ${SSH_USER}@${HOST}" "Try --ssh opc for Oracle Linux images."
  else
    ok "SSH works"

    STATE="$(remote "mongosh --quiet --eval 'rs.status().myState' 2>/dev/null")"
    if [[ "$STATE" == "1" ]]; then
      ok "MongoDB is a healthy replica set primary"
    else
      bad "MongoDB is not a replica set primary (myState=${STATE:-none})" \
          "Every wallet debit, booking and order will fail. rs.initiate() on the server."
    fi

    # The check that actually matters: can it commit one? This is what 21 call
    # sites across the money paths do on every request.
    TXN="$(remote "mongosh --quiet seika --eval '
      try {
        const s = db.getMongo().startSession();
        s.startTransaction();
        s.getDatabase(\"seika\").__verify.insertOne({t:1});
        s.commitTransaction();
        db.__verify.drop();
        print(\"OK\");
      } catch (e) { print(\"FAILED: \" + e.codeName); }
    ' 2>/dev/null")"
    if [[ "$TXN" == *OK* ]]; then
      ok "a real transaction commits"
    else
      bad "transactions do not work: ${TXN:-no response}" \
          "This is the single most important check. Nothing involving money works without it."
    fi

    SVC="$(remote "systemctl is-active seika-api")"
    [[ "$SVC" == "active" ]] && ok "seika-api is active" || bad "seika-api is ${SVC:-unknown}"

    ENABLED="$(remote "systemctl is-enabled seika-api")"
    if [[ "$ENABLED" == "enabled" ]]; then
      ok "seika-api starts on boot"
    else
      bad "seika-api will not start on boot" "systemctl enable seika-api"
    fi

    # An un-persisted iptables rule works until the first reboot, and then the
    # zone is offline for a reason nobody remembers.
    if remote "sudo -n iptables-save 2>/dev/null | grep -q 'dport 80'"; then
      ok "the firewall rule for :80 is persisted"
    else
      warn "could not confirm the firewall rule is persisted" \
           "If it is not, the next reboot closes the port: netfilter-persistent save"
    fi

    if remote "test -f /etc/cron.d/seika-backup"; then
      ok "the backup cron is installed"
      NEWEST="$(remote "ls -1t /var/backups/seika/*.gz* 2>/dev/null | head -1")"
      if [[ -n "$NEWEST" ]]; then
        AGE="$(remote "find /var/backups/seika -name '*.gz*' -mmin -300 2>/dev/null | head -1")"
        [[ -n "$AGE" ]] && ok "a backup was written in the last 5 hours" \
                        || warn "the newest backup is over 5 hours old" "Cron runs every 4h."
      else
        warn "no backup has been written yet" "Run it once now: sudo -E /usr/local/bin/seika-backup"
      fi
      if remote "grep -qE '^S3_BUCKET=.+' /etc/seika/backup.env"; then
        ok "backups are copied off the machine"
      else
        bad "S3_BUCKET is not set" \
            "Backups exist only on the machine they are backing up. The wallet ledger IS the money."
      fi
    else
      bad "no backup cron" "Re-run provision.sh."
    fi
  fi
else
  section "On the server"
  printf '        \033[90mskipped — pass --ssh <user> --key <path> to include these\033[0m\n'
fi

# ─── Verdict ─────────────────────────────────────────────────────────────────

echo
printf '\033[32m%d passed\033[0m' "$PASS"
[[ $WARN -gt 0 ]] && printf '  \033[33m%d warning(s)\033[0m' "$WARN"
[[ $FAIL -gt 0 ]] && printf '  \033[31m%d failed\033[0m' "$FAIL"
echo; echo

[[ $FAIL -gt 0 ]] && exit 1 || exit 0
