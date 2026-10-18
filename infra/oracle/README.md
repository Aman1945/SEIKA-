# Taking the SEIKA backend and database live on Oracle Cloud

This is the runbook for the server half of SEIKA: the API, the database, and
everything that keeps them alive. The dashboard and player apps are deliberately
out of scope here — they are static Next.js builds and can go anywhere later.

Read the first section before you touch anything. It explains the one decision
that is expensive to reverse.

---

## 1. The database decision

SEIKA commits every money path inside a multi-document transaction:

```
$ grep -rn "withTransaction" apps/api/src --include=*.ts | wc -l
      21
```

Twenty-one call sites across seven modules — sessions, bookings, shop orders,
payments, tournaments, cross-zone settlement, migration imports. A wallet debit
and the ledger row that justifies it are written together or not at all.

**MongoDB transactions require a replica set.** A standalone `mongod` starts
perfectly, serves reads and writes, passes a health check — and then fails every
single transaction with `Transaction numbers are only allowed on a replica set
member or mongos`. You will discover this the first time a customer tries to
pay.

So the database must be a replica set. On a single VM, that means a **single-node
replica set**: one `mongod`, `replSetName: rs0`, initiated once. It gives you
transactions. It does not give you failover, which is a trade you are making
knowingly, and which the backups below are the answer to.

### What about Oracle Autonomous JSON Database?

It is on the Always Free tier and it speaks a MongoDB-compatible API, so it
looks like the obvious choice on an Oracle account. Do not use it for this.

The compatibility layer does not cover everything the driver asks for, and the
gaps sit exactly where SEIKA lives: multi-document transactions, change streams,
some aggregation stages, `Decimal128` round-tripping. You would not find out at
deploy time; you would find out one failing endpoint at a time, in production,
with no way to fix it other than migrating the database you had just committed
to.

**Run MongoDB yourself on the VM.** It is free, it is the real thing, and the
backup and restore-drill scripts in `infra/scripts/` already exist.

### The honest alternative

| | Self-hosted on the Oracle VM | MongoDB Atlas M10 |
|---|---|---|
| Cost | ₹0 (Always Free tier) | ~$57/mo (~₹4,800) |
| Transactions | Yes, single-node RS | Yes, 3-node RS |
| Failover | **None.** VM dies, zone stops. | Automatic |
| Backups | Yours. Script + cron below. | Managed, point-in-time |
| Recovery | **You, at 2am** | Restore from a console |

For one pilot zone, self-hosted is the right call — the money saved is real and
the downside is an hour of downtime you can absorb. The moment you are running
several zones and a wallet balance is someone's actual money, the ₹4,800 buys
you a recovery story you do not have to execute yourself. Move then, not now.

---

## 2. Provisioning the instance

In the Oracle Cloud console: **Compute → Instances → Create instance**.

| Setting | Value | Why |
|---|---|---|
| Shape | **VM.Standard.A1.Flex**, 4 OCPU / 24 GB | Always Free, and ARM is plenty |
| Image | **Canonical Ubuntu 22.04** | The script targets this |
| Boot volume | 100 GB | Free tier allows 200 GB total |
| SSH key | Paste `~/.ssh/oracle_key.pub` | The key you already have on this Mac |

Note the **public IP** when it finishes. If "Out of capacity" appears — common
for free A1 in busy regions — retry in a different availability domain, or at a
quieter hour. It does eventually come through.

---

## 3. The two Oracle traps

Both of these will present as "the port is open and it still times out," and
neither produces an error message that points at the cause. Together they are
most of the time people lose on their first OCI deployment.

### Trap 1 — the VCN security list

A new VCN permits SSH on 22 and nothing else. You must add the rules yourself:

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default →
Add Ingress Rules**

| Source CIDR | Protocol | Port | Purpose |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 80 | HTTP, and Let's Encrypt's challenge |
| `0.0.0.0/0` | TCP | 443 | HTTPS |

Do **not** add 27017 or 6379. MongoDB and Redis bind to loopback and are reached
over localhost by the API. A MongoDB exposed to the internet is found by
automated scanners within hours, and the internet is full of zones that learned
this the hard way.

### Trap 2 — the instance's own firewall

This is the one that is genuinely surprising. **Oracle's Ubuntu and Oracle Linux
images ship with their own iptables rules baked into the image**, independent of
the VCN. There is a catch-all REJECT near the end of the `INPUT` chain. Opening
the security list in the console does nothing about it: the packet now reaches
the instance and the instance drops it.

`provision.sh` handles this, and it matters *how*:

```bash
iptables -I INPUT 1 -p tcp --dport 80 -m state --state NEW -j ACCEPT
```

`-I INPUT 1` inserts at the top of the chain. `-A` would append — after the
REJECT rule, where it never matches, and you would have a rule that reads
correctly in `iptables -L` and does nothing at all.

The rule is then persisted with `netfilter-persistent save`, because an
un-persisted iptables rule disappears at the next reboot and takes your zone
with it.

---

## 3b. This must be its own VM

`provision.sh` assumes the machine is empty, and three of its steps are
destructive on one that is not:

- the nginx site claims `default_server`, which catches every hostname no
  other site matches — including requests meant for whatever already runs
  there
- `/etc/nginx/sites-enabled/default` is removed
- `/etc/mongod.conf` is replaced wholesale and mongod becomes a replica set

The script now refuses to run when it finds another nginx site, another
mongo database, or a running app server, and names what it found. Overriding
that is deliberate and narrow:

```bash
sudo bash provision.sh --repo <url> --shared-host --server-name seika.example.com
```

With `--shared-host` it does not claim `default_server`, keeps the existing
default site, and refuses outright to touch a mongod whose `dbPath` is not
the distribution default.

Even so: give SEIKA its own VM. The Always Free tier allows several, and a
gaming zone's wallet ledger sharing a database server with another product
is a bad trade even on the days it works.

## 4. Running the provision

From this Mac:

```bash
scp -i ~/.ssh/oracle_key -r infra/oracle ubuntu@<PUBLIC_IP>:/tmp/
ssh -i ~/.ssh/oracle_key ubuntu@<PUBLIC_IP>
```

Then on the server:

```bash
sudo bash /tmp/oracle/provision.sh --repo https://github.com/Aman1945/SEIKA-.git
```

It takes roughly six minutes and is idempotent — safe to re-run after a failure,
and it will not overwrite an `.env` that already exists, so a re-run cannot
silently rotate your JWT secrets and sign out every player mid-session.

When it finishes you have: MongoDB as `rs0` on loopback, Redis on loopback, the
API installed as a systemd unit **but not started**, nginx proxying `:80 → :4000`,
and backups on a cron.

---

## 5. Configuration

The API will refuse to start until `/opt/seika/apps/api/.env` is filled in.
That refusal is deliberate — `assertProductionConfig()` in
`apps/api/src/config/env.ts` checks these at boot and names the one that is
wrong, because each of them fails silently and expensively if left at a default:

```bash
sudo -u seika nano /opt/seika/apps/api/.env
```

| Setting | Without it |
|---|---|
| `OTP_PROVIDER` + its keys | **Nobody can log in.** Codes go to a log file. |
| `RAZORPAY_KEY_ID` / `_SECRET` | Mock payments. Wallets top up for free. |
| `RAZORPAY_WEBHOOK_SECRET` | Forged webhooks credit any wallet. Generated for you. |
| `CORS_ORIGINS` | Your clients get blocked, or anyone's page can call your API. |
| `SENTRY_DSN` | A production failure is discovered by a customer. |

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` were generated during provisioning
and need no attention.

Then:

```bash
sudo systemctl start seika-api
sudo journalctl -u seika-api -f
```

If it exits immediately, the journal states which setting is wrong. The unit has
`StartLimitBurst=5` so systemd gives up rather than restart-looping and burying
the real reason in a wall of identical tracebacks.

---

## 6. Verifying it is actually up

Work outwards. Each step eliminates a layer, so the first one that fails tells
you where the problem is.

```bash
# 1. Is the replica set real? Anything other than 1 means no transactions.
mongosh --quiet --eval 'rs.status().myState'

# 2. Can the database actually commit one? This is the test that matters —
#    it is what every wallet debit does.
mongosh --quiet seika --eval '
  const s = db.getMongo().startSession();
  s.startTransaction();
  s.getDatabase("seika").__probe.insertOne({ok:1});
  s.commitTransaction();
  db.__probe.drop();
  print("transactions: OK");
'

# 3. Does the API answer, and does it see its dependencies?
curl -s http://127.0.0.1:4000/health/ready | python3 -m json.tool

# 4. Does nginx reach it?
curl -s http://127.0.0.1/health/ready

# 5. Does the internet reach it? Run this from the Mac, not the server —
#    this is the step that catches both Oracle traps.
curl -s http://<PUBLIC_IP>/health/ready
```

If 4 works and 5 times out, it is the firewall, every time. Check the VCN
security list first, then:

```bash
sudo iptables -L INPUT -n --line-numbers | head
```

Your ACCEPT rules for 80 and 443 must appear **above** the REJECT line.

---

## 7. TLS

Point a domain's A record at the public IP, wait for it to resolve, then:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com --redirect
```

Certbot edits the nginx site in place and installs a renewal timer. Verify the
renewal works now rather than finding out in 90 days:

```bash
sudo certbot renew --dry-run
```

TLS is not optional here. Without it, JWTs and OTP codes cross the network in
plain text, and the kiosk's socket connection — the thing that unlocks a PC —
is open to anyone on the same café wifi.

---

## 7b. TLS without owning a domain

Let's Encrypt will not issue for a bare IP, and some things genuinely need a
secure origin rather than merely preferring one — the player app's camera
scanner is simply absent over plain http, because `getUserMedia` does not
exist outside a secure context.

`sslip.io` resolves any `a-b-c-d.sslip.io` to that IP, with no account and no
DNS of your own, and Let's Encrypt will issue for it:

```bash
# 1. The seika site must answer for that hostname, or the ACME challenge
#    lands on whichever server block nginx picks as the default.
#    server_name 203.0.113.10 203-0-113-10.sslip.io;
#
# 2. The challenge must not be proxied to the API, which would 404 it.
#    location /.well-known/acme-challenge/ { root /var/www/certbot; }
#
# 3. Then, without --nginx, so nothing else on the box is rewritten:
sudo certbot certonly --webroot -w /var/www/certbot \
  -d 203-0-113-10.sslip.io --agree-tos --register-unsafely-without-email
```

Add a `listen 443 ssl` block pointing at the issued certificate. Renewal is
scheduled by certbot itself; `certbot renew --dry-run` proves it.

This is a demo-grade answer. The hostname is ugly and it ties the certificate
to an IP you may not keep. Use a real subdomain for anything a customer sees.

## 8. Backups

The wallet ledger **is** the money. Balances are derived from it by summation and
from nothing else, so a lost ledger is every customer's balance lost with no way
to reconstruct it. This section is not optional either.

Provisioning installed a backup every 4 hours and a restore drill monthly. One
thing is left to you:

```bash
sudo nano /etc/seika/backup.env   # set S3_BUCKET
```

A backup that only exists on the machine it is backing up is not a backup. Any
S3-compatible target works, including Oracle Object Storage, which has 20 GB on
the free tier. Set `HEALTHCHECK_URL` too — a cron job that quietly stops running
looks exactly like a cron job that is working, and the ping is what tells you
otherwise.

Prove a restore actually works, today, while nothing is wrong:

```bash
sudo -E /usr/local/bin/seika-restore-drill
```

It restores the newest archive into a scratch database, counts the documents,
checks the ledger sums, and drops it. An untested backup is a guess.

---

## 9. Updating

```bash
cd /opt/seika && sudo -u seika git pull
sudo -u seika pnpm install --frozen-lockfile
sudo -u seika pnpm --filter @seika/api build
sudo systemctl restart seika-api
```

Or use `infra/scripts/deploy.sh`, which does the same, health-checks the result,
and rolls back to the previous commit if the check fails.

Take a backup before any deploy that includes a migration. `seika-backup` is
idempotent and takes seconds.

---

## 10. What is still unproven

Stated plainly, because a runbook that implies more confidence than exists is
worse than no runbook:

- **The first real run went onto a machine that was already serving another
  application**, before the guard in §3b existed. The original script would
  have claimed `default_server`, deleted the default site and rewritten
  `/etc/mongod.conf` on that host. If that is your deployment, check the
  other application before trusting this one — §11.
- **The Windows kiosk lockdown has never run on real Windows hardware.** It is
  verified at the socket level (`apps/api/test/q-kiosk-lock.test.ts`, 9 cases)
  and by driving the shipped Electron app over CDP, but policy enforcement on an
  actual Windows PC is untested. Plan §11.
- **Single point of failure.** One VM. If it dies, the zone stops until you
  restore. That is the trade made in §1 and it is survivable at one zone.
- **No staging environment.** You are deploying to production from `main`.
  Fine for a pilot; not fine for two.

---

## 11. If it was installed on a machine that was already in use

Read-only. None of this changes anything.

```bash
# What nginx actually serves now, and which site claims the default.
ls -l /etc/nginx/sites-enabled/
sudo nginx -T 2>/dev/null | grep -nE "server_name|default_server|listen "

# Is the other application still answering on its own hostname?
curl -sI -H "Host: the-other-app.example.com" http://127.0.0.1/ | head -3

# Was its mongod config replaced? The original is kept beside it.
ls -l /etc/mongod.conf*
sudo grep -E "dbPath|bindIp|replSetName|authorization" /etc/mongod.conf

# Which databases exist, and did the other app's survive?
mongosh --quiet --eval 'db.adminCommand({listDatabases:1}).databases'

# What SEIKA added.
systemctl status seika-api --no-pager
ls -l /etc/cron.d/seika-backup /etc/seika/ /opt/seika
sudo iptables -L INPUT -n --line-numbers | head
```

To remove SEIKA from a shared machine without disturbing the rest:

```bash
sudo systemctl disable --now seika-api
sudo rm -f /etc/systemd/system/seika-api.service /etc/nginx/sites-enabled/seika
sudo systemctl daemon-reload
# Restore the default site if it was removed, then:
sudo nginx -t && sudo systemctl reload nginx
# The database and /opt/seika are left in place on purpose — delete them
# only once you are sure nothing there is wanted.
```

## Quick reference

```bash
sudo systemctl status seika-api            # is it running
sudo journalctl -u seika-api -f            # what is it saying
sudo journalctl -u seika-api -p err -n 50  # what went wrong
mongosh --quiet --eval 'rs.status().myState'   # 1 = replica set healthy
sudo -E /usr/local/bin/seika-backup        # back up now
sudo iptables -L INPUT -n --line-numbers   # the firewall, when nothing responds
```
