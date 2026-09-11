# SEIKA Gaming Zone OS

Enterprise-grade Gaming Zone Operating System — owner dashboard, player PWA, PC kiosk, wallet, XP/rewards, real-time operations.

See [`TECHNICAL_BUILD_PLAN.md`](./TECHNICAL_BUILD_PLAN.md) for the full architecture and phase plan.

## Documentation
- [`docs/STATUS.md`](docs/STATUS.md) — **current status, weighted honestly; start here**
- [`docs/PRODUCT_WORKING.md`](docs/PRODUCT_WORKING.md) — how the whole product works, flows, rules
- [`docs/ROLES_AND_ACCESS.md`](docs/ROLES_AND_ACCESS.md) — every role + full permission matrix
- [`docs/TEST_CASES.md`](docs/TEST_CASES.md) — automated coverage against the testing plan (136 cases)
- [`TECHNICAL_BUILD_PLAN.md`](TECHNICAL_BUILD_PLAN.md) — architecture + phase plan
- [`BUILD_REPORT.md`](BUILD_REPORT.md) — the original July build report (headline figures revised)

## Tests

```bash
pnpm --filter @seika/api test
```

Spins up its own in-memory MongoDB replica set, so the money paths run inside
real transactions. Runs in CI on every push.

## Monorepo layout
```
apps/api/        Node + Express + TypeScript backend monolith (MongoDB) — built
apps/kiosk/      Electron PC client — scaffolded, not yet run on Windows
apps/dashboard/  Next.js owner dashboard — NOT BUILT
apps/player/     Next.js player PWA — NOT BUILT
infra/           Docker Compose (Mongo + Redis). Nginx and deploy pipeline NOT BUILT
.github/         CI: typecheck, test, build, image build
```

## Backend — run it (P1)

The API needs MongoDB as a **replica set** (for transactions). Two ways:

### Option A — no Docker (fastest, in-memory)
```bash
pnpm install
pnpm dev:api:mem      # spins up an in-memory Mongo replica set
```

### Option B — Docker (persistent)
```bash
docker compose -f infra/docker-compose.yml up -d
cd apps/api && cp .env.example .env
cd ../.. && pnpm dev:api
```

Then:
- Health: http://localhost:4000/health
- API docs (Swagger): http://localhost:4000/docs

### Quick auth smoke test
```bash
# 1) request OTP (dev returns devCode in the response + logs it)
curl -s localhost:4000/api/auth/otp/request -H 'content-type: application/json' \
  -d '{"identifier":"9876543210"}'

# 2) verify (use the devCode from step 1) → get tokens
curl -s localhost:4000/api/auth/otp/verify -H 'content-type: application/json' \
  -d '{"identifier":"9876543210","code":"<devCode>"}'

# 3) call /me with the accessToken
curl -s localhost:4000/api/auth/me -H 'authorization: Bearer <accessToken>'
```

## Deployment (production = plain Node, not TypeScript)

TypeScript is a **dev-time** tool. Production runs compiled JavaScript:

```bash
pnpm --filter @seika/api build      # tsc → apps/api/dist/*.js  (plain JS)
NODE_ENV=production MONGO_URI=... node apps/api/dist/server.js
# or: docker build -f apps/api/Dockerfile -t seika-api .
```

- **No TypeScript / tsx at runtime.** The server is `node dist/server.js`.
- **`mongodb-memory-server` is a devDependency** — never runs in prod. Set `MONGO_URI` to a real MongoDB (self-hosted replica set or MongoDB Atlas).
- **Memory footprint:** the Node app measures ~80–110 MB RSS. Fits a **2 GB droplet** alongside Redis + Nginx. For tightest memory, use managed MongoDB (Atlas) so the box only runs app + redis + nginx.
- MongoDB must be a **replica set** (transactions). Atlas is one by default; self-hosted uses `--replSet`.

## Status
- **P1 (Foundation):** ✅ monolith scaffold, MongoDB models, OTP+JWT+refresh auth, RBAC, tenant context, audit log, Swagger, health.
- **P2 (Core live loop):** ✅ Zone/Branch/PC CRUD, PC map, QR login, **Session Authorization Engine** (QR ≠ unlock), start/end session, wallet balance + cash top-up, XP award on end, Socket.IO realtime (`pc:status`, `session:update`, `qr:scanned`, `command`), dev seed. Verified end-to-end.
- **P3 (Money):** ✅ **Razorpay** wallet top-up (order + HMAC-verified webhook, mock mode without keys, idempotent credit), **bookings** with race-safe overlap conflict detection, pay-from-wallet, QR check-in, cancel-with-refund, **session refund** reversing wallet + XP + coins. Verified end-to-end.
- **P4 (Retention):** ✅ **coins on level-up** (per-level + rank-unlock rewards per blueprint table), `player:levelup` realtime event, **leaderboards** (global/zone × weekly/monthly/all-time, MongoDB aggregation), **Player Passport** endpoint (level, rank, XP progress, wallet, coins, recent sessions — one call for the thin frontend). Verified end-to-end.
- **P5 (Ops):** ✅ **POS/shop** (products, stock, low-stock), **seat ordering** (server-priced, stock-decrement + wallet-deduct in one txn, oversell guard), staff **order queue** + status flow (`order:new`/`order:status` realtime), cancel→restock+refund, **analytics overview** (revenue/occupancy/topups/bookings/pending), **CSV export** (audit-logged). Verified end-to-end.
- **✅ CORE BACKEND MVP COMPLETE (P1–P5).**
- **✅ Web Console (demo UI):** single-file thin client at `apps/api/public/index.html`, served at `/`. Owner dashboard (live PC map, today overview, add product) + Player app (OTP login, passport, wallet top-up, full session flow QR→authorize→start→end, leaderboard, shop). Pure `fetch` — zero business logic in the client. Open **http://localhost:4000** (or your PORT) after `pnpm dev:api:mem`.
- **P6 (partial):** ✅ rate limiting (OTP brute-force guard, 429), `trust proxy` for real client IP behind Nginx. (Sentry/PostHog/2FA/Redis/CI still future.)
- **P7 (started):** ✅ **AI Business Insights** (`GET /api/ai/insights`) — occupancy/peak-hours/low-stock/queue signals → insights + `dynamicPricingHint`, **7-day revenue forecast**, **player churn detection** (14-day inactivity). Rule-based now, LLM-ready hook, works with zero keys. Shown on the owner dashboard.
- **PC Kiosk (Windows lock):** ✅ Electron app scaffolded at `apps/kiosk` — fullscreen kiosk lock screen with QR, Socket.IO listener for `command:unlock`/`lock`, escape-key blocking, heartbeat. Unlock decision is 100% server-side. Run on a Windows PC: `cd apps/kiosk && cp config.example.js config.js && npm install && npm start`. See `apps/kiosk/README.md` for Assigned-Access / shell-replacement hard-lock.
- Remaining (future): full P6 (Sentry/PostHog/2FA/Redis/CI/backups), richer P7 AI (LLM prose, AI assistant), proper Next.js dashboard + player PWA (replacing the single-file demo console).

### Verified acceptance (P6/P7)
- OTP request >5/min → 429 (brute-force blocked). ✅
- AI insights: low occupancy → "offer discount" hint + low-stock warning surfaced. ✅

### Verified acceptance (P5)
- Order (2×₹40 + 1×₹30) → wallet 300→190, stock decremented. ✅
- Order queue + preparing→ready→delivered flow. ✅
- Low-stock detection (Chips 1 ≤ threshold 3). ✅
- Analytics overview: revenue ₹110 (shop), topups ₹300, PC occupancy. ✅
- CSV export with correct header, access audit-logged. ✅

### Verified acceptance (P3–P4)
- Razorpay mock order → webhook → wallet credited; replay idempotent (no double credit). ✅
- Overlapping booking on same PC → 409 CONFLICT (inside a transaction). ✅
- Booking pay from wallet, cancel → wallet refunded. ✅
- Session refund: wallet 40→100, XP 50→0, coins 10→0, status REFUNDED. ✅
- Level-up coins: L1→11 unlocks Bronze → 450 coins (20×10 + 250). ✅
- Leaderboard ordering (global all-time + zone weekly) correct. ✅
- Passport returns level/rank/XP/wallet/coins/history in one call. ✅

### Verified acceptance (P2)
- QR scan + ₹0 wallet → PC stays LOCKED (402 INSUFFICIENT_BALANCE). ✅
- QR login = 0 XP; XP only from valid session minutes (60 min → 50 XP). ✅
- Funded loop: topup → attach → authorize → start (unlock) → end → cost deducted, XP awarded, PC freed. ✅
- Second attach on busy PC → 409 CONFLICT (partial unique index). ✅
