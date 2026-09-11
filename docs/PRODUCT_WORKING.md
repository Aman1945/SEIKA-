# SEIKA Gaming Zone OS — How the Product Works

A complete, plain-language walkthrough of what SEIKA does and how each piece fits.

---

## 1. What it is
SEIKA is an operating system for gaming zones / esports cafés. It combines:
- **Zone operations** — PCs, sessions, billing, bookings, POS/shop, staff, analytics.
- **Player engagement** — XP, levels, ranks, SEIKA Coins, leaderboards, tournaments, rewards.

One backend (Node + MongoDB) holds **all logic**. Three thin clients talk to it:
- **Owner/Staff web dashboard** (operations)
- **Player web app / PWA** (identity, wallet, play)
- **PC kiosk** (Electron) that locks each gaming PC until a session is authorized.

---

## 2. The golden rules (design principles)
1. **QR login ≠ PC unlock.** Scanning a QR only *identifies* the player (0 XP). The PC unlocks **only** after a valid payment source authorizes the session.
2. **Wallet is real money; Coins are loyalty points.** Separate ledgers, never mixed. Coins can't be withdrawn as cash.
3. **Balance is never edited.** Wallet balance = SUM of ledger transactions (append-only). Every money move is a ledger row.
4. **Money operations are atomic.** Wallet deduction + session/booking/order commit together in a MongoDB transaction, or roll back together.
5. **XP only from real gameplay.** Valid authorized session minutes earn XP — never login/idle.
6. **Every sensitive action is audit-logged** (who, what, old→new, when).
7. **Multi-tenant isolation.** Each zone only sees its own data.

---

## 3. The core live loop (most important flow)
```
Player arrives → PC kiosk shows a QR (locked)
  → player scans QR in the app         → session created, PENDING_AUTH, PC LOCKED, 0 XP
  → Session Authorization Engine checks a payment source:
       wallet balance? paid booking? cashier cash? package? voucher? postpaid?
     • valid   → AUTHORIZED → PC UNLOCKS → timer + heartbeat start
     • none    → stays LOCKED, shows payment options
  → player plays … session ends (player/staff/time)
  → backend computes valid minutes → deducts cost (money-safe txn)
  → awards XP → maybe level-up → coins + badges + notification
  → PC returns to AVAILABLE; dashboard + leaderboard update live
```

## 4. Payment / authorization sources (6)
| Source | How it authorizes |
|---|---|
| **WALLET** | balance ≥ minimum start amount; cost deducted at end |
| **CASH** | cashier approves at counter |
| **BOOKING** | player has a paid booking for this PC/slot |
| **PACKAGE** | player has prepaid playtime minutes (deducted at end) |
| **VOUCHER** | valid free-play voucher code (single/limited use) |
| **POSTPAID** | owner-enabled trusted play; balance becomes a due |

## 5. Money & wallet
- **Top-up:** cash (cashier) or online (**Razorpay** — order + verified webhook, idempotent credit).
- **Spend:** session cost, bookings, shop orders, tournament entry.
- **Refund:** reverses the wallet ledger + any XP/coins earned (e.g., refunded session).
- Balance always computed from the ledger; staff can never edit it directly.

## 6. Progression (retention engine)
- **XP:** ~50 XP per valid gameplay hour (configurable).
- **Levels:** 1–100, scaling thresholds.
- **Ranks:** Rookie → Bronze → Silver → Gold → Platinum → Diamond → Elite → SEIKA Legend.
- **Coins:** granted on level-up + rank unlock (per blueprint table) + tournament wins; spent in reward shop.
- **Leaderboards:** global / zone × weekly / monthly / all-time.

## 7. Operations (owner/staff side)
- **PC map:** live status (available/occupied/offline/maintenance…).
- **Bookings:** reserve seats, conflict-checked, QR check-in, no-show/cancel-refund.
- **POS/Shop:** products, stock, low-stock alerts, seat orders → live order queue → status flow.
- **Staff:** owner creates staff with roles; fine-grained permissions; no self-elevation.
- **Announcements:** publish zone updates (broadcast live).
- **Analytics:** today revenue, occupancy, top-ups, bookings, pending orders; **CSV export** (audit-logged).
- **AI insights:** occupancy/peak-hours signals → recommendations, **revenue forecast**, **churn detection**, dynamic-pricing hint.
- **Audit log:** full trail of sensitive actions, owner-viewable.

## 8. Tournaments
Create → players register (entry fee from wallet) → check-in → organizer submits placements → XP (participation + podium bonus) + winner coins + notifications.

## 9. Real-time (Socket.IO)
Live events pushed to dashboards/kiosks: `pc:status`, `session:update`, `qr:scanned`, `order:new`, `order:status`, `player:levelup`, `notification`, `announcement`, `tournament:results`, plus trusted `command` (lock/unlock) to kiosks.

## 10. PC Kiosk (Windows lock)
Electron app on each gaming PC: fullscreen kiosk lock + QR; listens for `command:unlock` (after authorization) and `command:lock` (session end). Unlock decision is 100% server-side. Hard-lock via Windows Assigned Access / shell replacement (see `apps/kiosk/README.md`).

## 11. Tech & deployment
- **Backend:** Node + Express + TypeScript (monolith), MongoDB + Mongoose (replica set for transactions), Socket.IO.
- **Auth:** OTP (phone/email) + JWT access + rotating refresh (+ Google-ready). No passwords.
- **Runs on ~80–110 MB RAM** → fits a 2 GB server. Production: `node dist/server.js` (plain JS; TypeScript is dev-only). Dockerfile included; MongoDB Atlas recommended.

---

## 11b. Gap-Review updates (from Developer Gap Review Response)

Status legend: **✅ built** · **🟡 partial** · **📋 planned** (documented, affects schema/API — build next).

### Session-hour selection — ✅ built (P0)
At authorization the player picks a **play mode**:
- **FIXED_DURATION** — `1h / 2h / 3h` (`selectedMinutes` 60/120/180). Charged for the block; auto-ends at duration; `endReason=time_completed`.
- **OPEN_HOUR** — metered per minute; requires a **minimum start balance/deposit**; warns/locks when balance runs low.
`Session` now stores `sessionMode`, `selectedMinutes`, `pricingSnapshot` (rate frozen at start), `endReason`. Works before arrival (pre-pay) or after QR login (seated). Wallet check: FIXED needs full block cost; OPEN needs the deposit.

### Owner/Admin mobile mode — 🟡 partial
The web dashboard is responsive and served over HTTP, so **owners/staff already log in from a phone** (same RBAC, no weaker mobile layer). Dedicated mobile app modes (Player / Owner-Admin / Staff) are 📋 planned as PWA polish. Every admin action is already audit-logged (user, role, zone, action).

### Seated-zone shop — 🟡 partial
Shop is already scoped by `zoneId` and shown to logged-in players; orders flow to the live queue. 📋 planned: bind each order tightly to `activeSessionId` + `seat/pcId` and enforce "order only from the zone you're seated in."

### Leaderboard hierarchy — ✅ built (P1)
Scopes: **Global · Region · Country · City · Zone · Game**. Geography scopes rank by lifetime XP snapshot; zone scope aggregates session XP with weekly/monthly/all-time. (Period-bounded geo boards + game scope wiring = 🟡 next.)

### Payment-provider abstraction — 📋 planned
Today: Razorpay (order + idempotent verified webhook) + cash + wallet. Planned: a `PaymentProvider` interface (`createOrder / verifyWebhook / refund / paymentStatus`) so Stripe, Easypaisa/JazzCash, bank transfer, etc. all produce the same wallet ledger entries by region.

### Cross-zone events — 📋 planned
Today: single-zone tournaments (register → results → XP/coins). Planned: owner-to-owner connection, collaboration requests, shared events/brackets, per-zone check-in, result verification/dispute, prize/revenue split.

### Smart Sync — 📋 planned (kiosk)
Whitelisted game config/save sync (download after auth, upload after session), conflict handling, anti-cheat-safe folders, per-player encrypted storage. Belongs in the PC kiosk.

### Data migration wizard — 📋 planned
CSV/Excel import of players, wallet opening balances, memberships, played hours, sessions from Senet/other tools (map → validate → import → OTP-activate).

## 12. Try it (no install)
```bash
cd ~/Desktop/SEIKA && pnpm dev:api:mem   # → http://localhost:4000
```
- Owner: click **Seed demo zone** (also auto-creates 4 staff).
- Player: phone `9876543210` → OTP auto-fills → Login.
- Staff: **Login as staff** with `9700000001`–`04`; **Back to Owner** to switch.
