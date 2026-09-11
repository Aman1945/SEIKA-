# SEIKA — infrastructure

What runs a zone in production, and the two jobs that decide whether a bad day
is recoverable.

## Layout

```
infra/
├── docker-compose.yml     Mongo (replica set) + Redis, and the API under --profile app
├── nginx/
│   ├── seika.conf         TLS termination, Socket.IO upgrade, coarse rate limits
│   └── snippets/          shared proxy headers
└── scripts/
    ├── backup.sh          mongodump → verify → encrypt → off-box (cron)
    ├── restore-drill.sh   restore into a scratch DB and check the money adds up
    └── deploy.sh          build, health-check, swap, with a one-command rollback
```

## Bring up the data stores

```bash
docker compose -f infra/docker-compose.yml up -d
```

Mongo runs as a **single-node replica set** because every money path in SEIKA
commits inside a multi-document transaction, and transactions need one. A plain
standalone mongod will start and then fail every wallet operation.

## Run the API in production

```bash
cp apps/api/.env.example apps/api/.env   # then fill it in
docker compose -f infra/docker-compose.yml --profile app up -d
```

The API refuses to boot in production if the config is unsafe — dev JWT or
webhook secrets, no OTP provider, mock payments, a localhost Mongo URI, or
localhost left in CORS. That is deliberate: each of those fails silently and
expensively otherwise.

It warns (but starts) without `SENTRY_DSN`, `REDIS_URL` or `SEIKA_RELEASE`.

## TLS

```bash
cp infra/nginx/seika.conf /etc/nginx/sites-available/seika
cp -r infra/nginx/snippets /etc/nginx/
ln -s /etc/nginx/sites-available/seika /etc/nginx/sites-enabled/
certbot certonly --nginx -d api.seika.gg
nginx -t && systemctl reload nginx
```

Reload, never restart: a restart drops every live Socket.IO connection, so
every kiosk in every zone reconnects at once.

## Backups

The wallet ledger **is** the money — balances are derived from it and nothing
else. Losing it loses every customer's balance with no way to reconstruct it.

```bash
# /etc/seika/backup.env
MONGO_URI=mongodb://localhost:27017/seika?replicaSet=rs0
BACKUP_DIR=/var/backups/seika
S3_BUCKET=s3://seika-backups/prod
BACKUP_GPG_RECIPIENT=ops@seika.gg
HEALTHCHECK_URL=https://hc-ping.com/<uuid>
```

```cron
0 */4 * * *  set -a; . /etc/seika/backup.env; set +a; /opt/seika/infra/scripts/backup.sh >> /var/log/seika-backup.log 2>&1
0 3 1 * *    set -a; . /etc/seika/backup.env; set +a; /opt/seika/infra/scripts/restore-drill.sh >> /var/log/seika-drill.log 2>&1
```

Three things make this a backup rather than a hope:

- `--oplog` makes the dump point-in-time consistent across collections, so a
  restored ledger is trustworthy rather than approximately right.
- Every dump is verified with `mongorestore --dryRun` before it is trusted, and
  a suspiciously small dump fails the job instead of overwriting a good one.
- `HEALTHCHECK_URL` is pinged on success, so a cron job that silently stops
  running is what raises the alarm. Without it, "no alert" and "no backups for
  three weeks" look identical.

**Run the drill monthly.** It restores the newest dump into a throwaway
database and asserts the collections are present, the ledger has rows, every
balance is computable and non-negative, no ledger row is orphaned, and the
session-guard index came back — that last one is a correctness check, not a
performance one: without the index two players can be billed on one PC.

## Deploy

```bash
./infra/scripts/deploy.sh            # HEAD
./infra/scripts/deploy.sh v1.2.0     # a tag
ROLLBACK=1 ./infra/scripts/deploy.sh # previous image, no rebuild
```

It takes a backup first, keeps the outgoing image tagged `seika-api:previous`,
waits for `/health/ready`, and rolls back on its own if the new release never
becomes ready.

## Monitoring

- `GET /health` — liveness. Is the process up.
- `GET /health/ready` — readiness. Can this instance actually serve: pings Mongo
  for real, and reports Redis when configured. **503** when not ready, which is
  what a load balancer and a rolling deploy both read.

They are separate on purpose. A process that is up but cannot reach Mongo should
leave the load balancer, not be restarted; a process that has stopped responding
should be restarted, not just drained.

Point an uptime monitor at `/health/ready` and the backup dead-man's-switch at
the cron job. Those two cover the failures that otherwise get reported by a
customer.

## Still missing

- Multi-node Mongo. The single node gives transactions, not high availability.
- Metrics/dashboards (PostHog, Grafana). Sentry covers errors, not trends.
