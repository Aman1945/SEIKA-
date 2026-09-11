# SEIKA — Honest Status

Measured against **SEIKA Gaming Zone OS — Complete Software Testing Plan**
(26 August 2026). Written 11 September 2026.

This file exists because the earlier reports counted only backend logic and
treated documentation as a deliverable, which put "overall product" at 86% while
two whole client apps, all of QA automation and most of production infra had not
started. The numbers below weight what shipping actually needs.

---

## Where the product stands

| Layer | Done | What is missing |
|---|:--:|---|
| Backend API | **~95%** | Payment-provider abstraction; a few L2 refinements (zone opening hours drive the capacity figure, currently a fixed 12h/day) |
| Automated tests | **~80%** | Kiosk-side and app-side cases; load/soak testing |
| Production infra | **~35%** | Nginx + TLS, Sentry, PostHog, Redis-backed rate limiting, automated backups, deploy pipeline |
| Owner dashboard app | **~10%** | The Next.js app in the build plan; today there is one 341-line demo console |
| Player PWA | **~10%** | Same |
| PC kiosk | **~20%** | Real Windows lock, heartbeat loop, Smart Sync client, signed installer |
| **Overall shippable product** | **~60%** | — |

The backend is the strong part and it is now genuinely verified rather than
asserted. The gap is clients, the kiosk, and production operations.

---

## Plan module coverage

| Module | Built | Tested | Notes |
|---|:--:|:--:|---|
| A Auth & accounts | ✅ | ✅ 7 | Profile customization added; Google OAuth still only a `googleId` field |
| B PC kiosk & session authorization | ✅ | ✅ 10 | Server side complete; kiosk process is the gap |
| C Top-up + hour selection | ✅ | ✅ 8 | |
| D Wallet, payments, refunds, ledger | ✅ | ✅ 12 | Razorpay only; provider abstraction pending |
| E Bookings & reservations | ✅ | ✅ 11 | No-show automation (E7) still manual |
| F Player mobile app | ❌ | — | API ready; the app is not built |
| G Owner/admin mobile app | ❌ | — | API + RBAC ready; the app is not built |
| H Shop/POS & seated-zone | ✅ | ✅ 10 | Seat binding now enforced server-side |
| I XP, rank, coins, leaderboards | ✅ | ✅ 13 | Game tracking added, so the game board is real |
| J Events & cross-zone | ✅ | ✅ 14 | §8 two-zone end-to-end flow passes |
| K Smart Sync | 🟡 | ✅ 14 | Policy and storage done and tested; kiosk client pending |
| L Analytics, reports, export | ✅ | ✅ 12 | CSV, xlsx and PDF across six datasets |
| M RBAC, security, isolation | ✅ | ✅ 12 | |
| N Data migration | ✅ | ✅ 13 | |

---

## Blockers before a pilot

Fixed:

- JWT and webhook secrets no longer fall back to dev defaults; the server
  refuses to boot in production on an unsafe config.
- OTP delivery exists (MSG91 / Twilio / Resend). Before this, nobody could have
  logged in to production.
- Rate limiting is gated on its own flag, so staging exercises the same path
  production does.
- Version control and CI exist.

Still open:

1. **Nginx + TLS + a deploy pipeline.** `infra/` has Docker Compose for Mongo
   and Redis only.
2. **Backups for the wallet ledger.** No automated dump, no restore drill. This
   is the highest-consequence gap: the ledger *is* the money.
3. **Monitoring.** No Sentry, no uptime checks, no alerting. Today a production
   failure is discovered by a customer.
4. **Redis is running but unused.** Rate limiting is an in-memory map, so it
   breaks with more than one API instance.
5. **Mongo is a single-node replica set.** Transactions work; high availability
   does not.
6. **The kiosk has never run on Windows.** Plan §11 requires real Windows
   behaviour, not API simulation.

---

## What to build next, in order

1. **Owner dashboard (Next.js).** Unblocks plan module G, which is P0, and is
   what an owner actually buys. 3–4 weeks.
2. **Player PWA.** Module F. 3–4 weeks.
3. **Kiosk on real Windows** — lock, heartbeat, Smart Sync client against the
   policy endpoints that now exist. 2 weeks.
4. **P6 infra**: Nginx/TLS, deploy pipeline, Sentry, uptime monitoring,
   automated ledger backups with a tested restore. 2–3 weeks.
5. **Payment-provider abstraction** so a second gateway does not mean a second
   integration. 1 week.
6. **Pilot zone**, two weeks minimum with real PCs, cash counter and real
   network drops, gated on zero open S0/S1.

Roughly 12–16 weeks with work running in parallel; about 5 months serially.

---

## Ground rules worth keeping

- The test suite is the release gate. A plan case without an automated test is
  not "verified", it is "someone once saw it work".
- A test that only asserts HTTP 200 can pass while the feature is absent — the
  `scope=game` leaderboard did exactly that for two months.
- Money paths are asserted against the ledger, never through a response body
  alone.
- Tenant isolation gets a test per feature, not one test in total.
