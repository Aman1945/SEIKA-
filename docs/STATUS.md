# SEIKA — Status

Measured against **SEIKA Gaming Zone OS — Complete Software Testing Plan**
(26 August 2026). Updated 11 September 2026.

## Where the product stands

| Layer | Done | What is missing |
|---|:--:|---|
| Backend API | **~98%** | Google OAuth, 2FA, no-show automation, zone opening hours (occupancy capacity is a fixed 12h/day) |
| Automated tests | **~85%** | Windows kiosk behaviour, load/soak, UI end-to-end |
| Owner dashboard | **~80%** | Booking management, announcements, cross-zone event detail screens |
| Player PWA | **~80%** | Bookings, rewards/coin spending, notifications, camera QR scanning, offline shell |
| PC kiosk | **~70%** | **Never run on Windows.** Signed installer, watchdog service |
| Production infra | **~80%** | Multi-node Mongo, metrics dashboards, a rehearsed incident runbook |
| **Overall shippable product** | **~85%** | — |

For comparison, the earlier reports claimed 86% when two client apps, all QA
automation and most of production infra had not started; the honest figure then
was around 50%.

## Plan module coverage

| Module | Built | Tested | Notes |
|---|:--:|:--:|---|
| A Auth & accounts | ✅ | ✅ 7 | Google OAuth is still only a `googleId` field |
| B PC kiosk & session authorization | ✅ | ✅ 10 | Server side complete; Windows behaviour untested |
| C Top-up + hour selection | ✅ | ✅ 8 | |
| D Wallet, payments, refunds, ledger | ✅ | ✅ 23 | Provider abstraction done; Razorpay + mock implemented |
| E Bookings & reservations | ✅ | ✅ 11 | No-show automation (E7) still manual |
| F Player mobile app | ✅ | 🟡 | Built and driven end to end by hand; no automated UI tests |
| G Owner/admin mobile app | ✅ | 🟡 | Same. RBAC behind it is covered by module M |
| H Shop/POS & seated-zone | ✅ | ✅ 11 | Seat binding enforced server-side |
| I XP, rank, coins, leaderboards | ✅ | ✅ 13 | |
| J Events & cross-zone | ✅ | ✅ 14 | §8 two-zone end-to-end flow passes |
| K Smart Sync | ✅ | ✅ 24 | Policy server-side (14), kiosk disk side (10) |
| L Analytics, reports, export | ✅ | ✅ 12 | CSV, xlsx and PDF across six datasets |
| M RBAC, security, isolation | ✅ | ✅ 12 | |
| N Data migration | ✅ | ✅ 13 | |
| — Operations | ✅ | ✅ 9 | Health, readiness, crash-report scrubbing, rate limiting |

**157 API tests + 10 kiosk tests, all green in CI.**

## Pilot blockers

Closed:

- Secrets no longer fall back to dev defaults; production refuses to boot on an
  unsafe config, a mock payment setup, or an OTP channel that cannot deliver.
- OTP delivery exists (MSG91 / Twilio / Resend). Before this, nobody could have
  logged in to production at all.
- Ledger backups every 4h: consistent with `--oplog`, verified before being
  trusted, encrypted, off-box, with a dead-man's-switch so a *missing* backup
  alerts. A monthly drill restores into a scratch database and checks the money
  adds up.
- Monitoring: `/health` and `/health/ready`, Sentry with secrets scrubbed.
- Redis-backed rate limiting, so the window is shared across instances.
- Nginx with TLS, and a deploy that health-checks and rolls itself back.
- Version control and CI across every package.

Open:

1. **The kiosk has never run on Windows.** Plan §11 is explicit that kiosk
   behaviour must be tested there, not simulated. This is the single largest
   remaining risk to a pilot.
2. **Mongo is a single node.** Transactions work; high availability does not.
3. **No rehearsed incident runbook.** The tooling exists; nobody has used it
   under pressure.
4. **No load testing.** A zone with 40 PCs all heartbeating and ordering has
   not been simulated.

## What to do next

1. **Windows pilot hardware.** Install the kiosk on two real PCs, run Assigned
   Access, verify lock/unlock/heartbeat/Smart Sync for a full day. 1 week.
2. **Restore drill for real.** Run it against a production-sized dump and time
   it, so the recovery window is a number and not a hope. 1 day.
3. **Remaining client screens**: bookings and rewards in the player app,
   announcements and booking management in the dashboard. 1–2 weeks.
4. **Load test** a 40-PC zone. 2–3 days.
5. **Pilot zone**, two weeks minimum with real PCs, a cash counter and real
   network drops, gated on zero open S0/S1.

## Ground rules worth keeping

- The test suite is the release gate. A plan case without an automated test is
  not "verified", it is "someone once saw it work".
- A test that only asserts HTTP 200 can pass while the feature is absent — the
  `scope=game` leaderboard did exactly that for two months.
- Money paths are asserted against the ledger, never through a response body.
- Tenant isolation gets a test per feature, not one test in total.
- Run the thing. Two bugs in the SDK and API surfaced only in a real browser,
  and one of them (`₹NaN` on every order line) would have shipped.
