# SEIKA Gaming Zone OS — Master Technical Build Plan

> **Vision:** Enterprise-grade Gaming Zone Operating System — AI, cloud-native, real-time, multi-tenant-ready.
> **Stack:** MongoDB · Node/Express · **Next.js/React** · Socket.IO · Redis/BullMQ · Razorpay · full observability.
> **Dual purpose:** (1) real single-zone product, (2) **portfolio showcase** of enterprise architecture, cloud infra, system design, AI, real-time.
> **Status:** Planning · v3 (cloud-native / Next.js / AI) · 07 July 2026
> **Golden rule:** Core loop pehle solid banao; enterprise layers (AI, payments, observability, CI/CD) phase-wise chadhao.

---

## 0 · Modules (from Master Roadmap)

**Core:** Auth (OTP, JWT, Google, RBAC, refresh tokens) · Owner Dashboard (revenue, analytics, occupancy, reports) · Player PWA · Electron PC Kiosk · Wallet Ledger · Booking & Session Engine · POS & Inventory · Leaderboard/XP/Rewards · Audit Logs.

**AI:** Business insights · Revenue forecasting · Dynamic pricing · Churn detection · Inventory suggestions · AI reports · AI support assistant.

**Security:** JWT · RBAC · MongoDB transactions · Rate limiting · 2FA · Device fingerprinting · Audit logs.

**Future:** Multi-tenant SaaS · Steam · Discord · Tournament platform · Plugin marketplace · White-label · Public APIs.

---

## 1 · Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| **Frontend** (dashboard + player PWA) | **Next.js 14 + React + TypeScript + Tailwind** | One React codebase; player app = installable PWA. Owner dashboard + player share `packages/ui`. |
| **PC Kiosk** | **Electron** (React inside) | Windows kiosk lock, heartbeat, auto-update. |
| **Backend** | **Node.js + Express + TypeScript** (monolith) | One deployable; modular internally. |
| **Database** | **MongoDB 7 + Mongoose** | Decimal128 for money; multi-doc ACID transactions (replica set). |
| **Realtime** | **Socket.IO** | Live PC map, sessions, QR login, order queue. |
| **Cache / rate-limit** | **Redis** | OTP store, rate limiting, leaderboard sorted-sets. |
| **Job queue** | **BullMQ** (on Redis) | Async jobs: reports, notifications, XP recalc, AI batch. |
| **Payments** | **Razorpay** | Wallet top-up, booking, event entry (India-first). |
| **Object storage** | **DigitalOcean Spaces** (S3-compatible) | Avatars, generated reports, exports. |
| **Push notifications** | **Firebase FCM** | Booking reminders, reward unlocks, order status. |
| **Email** | **Resend** | Receipts, OTP-email, scheduled reports. |
| **API docs** | **Swagger / OpenAPI** | Auto-generated from routes. |
| **Observability** | **Sentry** (errors) · **PostHog** (product analytics) · **Uptime Kuma** (uptime) | Portfolio-grade monitoring. |

---

## 2 · Infrastructure & DevOps

| Piece | Choice |
|---|---|
| **Frontend hosting** | **Vercel** (Next.js dashboard + player PWA) |
| **Backend hosting** | **DigitalOcean Droplet** (~$25) — Node monolith + Socket.IO |
| **Reverse proxy** | **Nginx** (TLS, WSS upgrade, routing) |
| **Containers** | **Docker + Docker Compose** (mongo replica-set, redis, api, nginx) |
| **CI/CD** | **GitHub Actions** — lint, test, build, deploy on push |
| **Storage** | DigitalOcean Spaces (250GB) |
| **Backups** | Automated MongoDB + Spaces backups |

> **Cloud-native note:** Blueprint originally wanted "local-first per zone" for LAN reliability if internet drops. This roadmap is cloud-first. Trade-off: simpler ops + better portfolio story, but a zone needs stable internet. **Local-fallback mode** (sessions continue on LAN, sync later) is kept as a **future** item, not MVP.

---

## 3 · System Architecture

```
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Owner Dash    │   │ Player PWA    │   │  PC Kiosk     │
   │ (Next.js)     │   │ (Next.js PWA) │   │ (Electron)    │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │  Vercel           │  Vercel           │
          └─────────┬─────────┴─────────┬─────────┘
                    │ HTTPS/WSS via Nginx│
                    ▼                    ▼
        ┌────────────────────────────────────────┐
        │   SEIKA Backend MONOLITH (DO Droplet)    │
        │   Node + Express + Socket.IO             │
        │   auth·rbac·zone·session·wallet·booking  │
        │   ·xp·leaderboard·shop·analytics·ai·audit│
        └───┬───────────────┬───────────────┬─────┘
            │ Mongoose       │ BullMQ         │ SDKs
            ▼                ▼                ▼
      ┌──────────┐    ┌──────────┐   ┌─────────────────────┐
      │ MongoDB 7 │    │  Redis    │   │ Razorpay·FCM·Resend │
      │(replica)  │    │(cache/q)  │   │ ·Spaces·OpenAI      │
      └──────────┘    └──────────┘   └─────────────────────┘

Observability: Sentry (errors) · PostHog (analytics) · Uptime Kuma (uptime)
```

**Golden rules baked in:** (1) every player doc has `playerId`+`zoneId`; (2) wallet balance = SUM(ledger), never stored; (3) QR login ≠ unlock (Session Auth Engine); (4) XP only from valid session minutes; (5) money ops inside MongoDB transactions; (6) sensitive actions → audit log.

---

## 4 · Monorepo Structure

```
seika/
├── apps/
│   ├── api/                 # Node + Express monolith
│   │   ├── src/modules/     # auth rbac zone session wallet booking
│   │   │                    # xp leaderboard shop analytics ai audit realtime
│   │   ├── src/models/      # Mongoose schemas
│   │   ├── src/jobs/        # BullMQ processors
│   │   ├── src/integrations/# razorpay fcm resend spaces openai
│   │   └── src/middleware/  # auth guard, tenant ctx, rate-limit, error
│   ├── dashboard/           # Next.js owner dashboard
│   ├── player/             # Next.js player PWA
│   └── kiosk/              # Electron PC client (React)
├── packages/
│   ├── types/              # shared TS types / DTOs
│   ├── sdk/                # API client
│   └── ui/                 # shared React components
├── infra/
│   ├── docker-compose.yml  # mongo(replica) + redis + api + nginx
│   ├── nginx/
│   └── github-actions/     # CI/CD workflows
└── turbo.json
```

---

## 5 · Data Model (MongoDB — MVP core)

Collections: **Zone, Branch, PC, Player, Session, WalletLedger, CoinLedger, Booking, StaffUser, StaffActionLog** (fields per blueprint §13).

Key MongoDB rules:
- **Decimal128** for all money.
- **Balance = aggregation SUM(WalletLedger.amount)** — never stored/edited.
- **Booking conflict** checked inside transaction; overlap → reject/waitlist.
- **Wallet-deduct + session-start** = one `withTransaction()` block.
- Indexes: `Player.username/phone/email` unique-sparse; `Booking {pcId,slotStart,slotEnd}`; `WalletLedger {playerId,createdAt}`.

Auth additions this version: **Google OAuth login** + **refresh tokens** (short-lived access JWT + rotating refresh token in httpOnly cookie / secure store).

> Post-MVP collections: PlayerProfile, RankHistory, LeaderboardScore, Game, Product, Order, Event, EventParticipant, TournamentMatch, PricingRule, MigrationImport, Notification, AiInsight.

---

## 6 · Session Authorization Engine (critical core)

```
QR scan → attach playerId → PENDING_AUTH (0 XP, LOCKED)
  → check (wallet ≥ min | paid booking | cash approve | package | voucher | postpaid)
  → AUTHORIZED (reserve funds in txn) → unlock → ACTIVE (timer+heartbeat+XP)
  → none → STAY LOCKED, show payment options
```
**Acceptance:** ₹0 wallet + no booking → PC stays locked. QR login = 0 XP.

---

## 7 · Build Phases

| Phase | Deliverable | Est. |
|---|---|---|
| **P1 · Foundation** | Monorepo, Docker (mongo replica+redis), Express scaffold, Mongoose models, auth (OTP+JWT+Google+refresh), RBAC, tenant ctx, audit, Swagger | ~1.5 wk |
| **P2 · Core live loop** | PC map, QR login, Session Auth Engine, timer, heartbeat, Electron kiosk lock, Socket.IO | ~2 wk |
| **P3 · Money** | Wallet ledger (txn-safe), **Razorpay** top-up, deduction, bookings + conflict, cash/counter | ~2 wk |
| **P4 · Retention** | XP, levels, ranks, coins, level-up, zone leaderboard (Redis sorted-sets) | ~1.5 wk |
| **P5 · Ops** | POS + inventory, seat orders, analytics dashboard, CSV export, player PWA polish, FCM + Resend | ~2.5 wk |
| **P6 · Production hardening** | Nginx, GitHub Actions CI/CD, Sentry + PostHog + Uptime Kuma, rate limiting, 2FA, device fingerprinting, backups | ~1.5 wk |
| **P7 · AI layer** | Business insights, revenue forecasting, dynamic pricing, churn detection, inventory suggestions, AI reports, AI support assistant (LLM + BullMQ batch) | ~2–3 wk |

**Total (MVP → production + AI): ~12–15 weeks active.** (Core-only MVP through P5 ≈ 8–9 wk.)

---

## 8 · Critical Acceptance Tests

- [ ] QR login ₹0 + no booking → PC locked, payment options shown. QR = 0 XP.
- [ ] Valid 60-min session → configured XP. Login-only → no XP.
- [ ] Wallet balance == SUM(ledger); no direct edit.
- [ ] Razorpay top-up webhook verified → ledger entry created.
- [ ] Two players same PC/time → second blocked/waitlisted.
- [ ] Wallet-deduct + session-start commit/rollback together (transaction).
- [ ] Refunded session reverses XP + coins.
- [ ] Sensitive actions logged (actor, time, reason, old/new).
- [ ] Rate limiting blocks OTP brute-force.
- [ ] Tenant isolation: Owner A ≠ Owner B data (multi-zone stage).

---

## 9 · Security & Financial Integrity

Money = Decimal128 · ledgers append-only, balance computed · wallet ≠ coins · money ops in MongoDB transactions · JWT access + rotating refresh · Google OAuth · RBAC fine-grained · rate limiting (Redis) · 2FA (owners/admin) · device fingerprinting · per-`zoneId` tenant isolation · Razorpay webhook signature verification · no secrets in logs · automated backups.

---

## 10 · Estimate

| Track | Time | Tokens |
|---|---|---|
| Core MVP (P1–P5) | ~8–9 weeks | ~14–22M |
| + Production hardening + AI (P6–P7) | +4–6 weeks | +8–14M |
| **Full roadmap (P1–P7)** | **~12–15 weeks** | **~22–36M** |
| Future (SaaS, Steam, Discord, tournaments, marketplace, white-label) | months more | — |

---

## 11 · Immediate Next Step (P1)

1. **Scaffold monorepo** (turbo) + `infra/docker-compose.yml` — MongoDB **1-node replica set** (for transactions) + Redis.
2. **Express monolith scaffold** + Mongoose models (§5) + Swagger.
3. **Auth module** — OTP + JWT + **Google OAuth** + **refresh tokens** + RBAC middleware + tenant context + audit log.

Ye P1. Bolo to yahin se code shuru.
