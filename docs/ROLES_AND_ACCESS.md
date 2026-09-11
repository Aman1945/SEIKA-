# SEIKA — Roles & Access (Detailed)

SEIKA uses **role-based access control (RBAC)**. Every sensitive endpoint checks the caller's role. `SUPER_ADMIN` bypasses all role checks; everyone else is limited to what's granted. Staff can create custom role names + extra granular permissions on top of these base roles, and **staff can never elevate their own role**.

Two account types:
- **Staff accounts** (operator side): SUPER_ADMIN, ZONE_OWNER, BRANCH_MANAGER, CASHIER, TECHNICIAN, EVENT_MANAGER. Log in with OTP `audience=staff`.
- **Player accounts** (customer side): the "Player/User" role. Log in with OTP `audience=player`.

---

## 1. Roles at a glance

| Role | Scope | In one line |
|---|---|---|
| **SUPER_ADMIN** | Platform (all zones) | Approves zones, platform settings; bypasses role checks |
| **ZONE_OWNER** | Their zone(s) | Full control of their zone — the "admin" |
| **BRANCH_MANAGER** | Their branch | Daily operations + analytics, not owner-level settings |
| **CASHIER** | Counter | Sessions, cash, top-ups, shop orders, basic refunds |
| **TECHNICIAN** | Hardware | PC status, maintenance, commands — no money/customer data |
| **EVENT_MANAGER** | Events | Create/manage tournaments & results |
| **Player / User** | Own account | Play, wallet, bookings, XP, leaderboard, rewards |
| **Guest** | Temporary | Limited session, no persistent wallet (future) |

---

## 2. Full permission matrix

✅ allowed · ❌ denied (403) · 👤 own data only · — n/a

| Capability | SUPER_ADMIN | ZONE_OWNER | BRANCH_MANAGER | CASHIER | TECHNICIAN | EVENT_MANAGER | Player |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| View PC map | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Create/edit PC | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| PC command (lock/unlock/restart/maintenance) | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | — |
| Create branch | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| Zone settings (postpaid toggle) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | — |
| Wallet top-up (for a player) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Authorize session — CASH | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Refund a session | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Products: create/edit, stock | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| View low-stock | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Order queue + advance status | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Create voucher | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| Grant package | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Create/manage staff | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | — |
| List staff | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| Analytics overview | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| CSV export | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| AI insights | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| Audit log viewer | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| Publish/archive announcement | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | — |
| Create tournament / submit results | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | — |
| — Player-side — | | | | | | | |
| Sign up / log in (OTP) | — | — | — | — | — | — | ✅ |
| View own passport / wallet / coins | — | — | — | — | — | — | 👤 |
| Attach via QR + authorize (wallet/booking/package/voucher) | — | — | — | — | — | — | ✅ |
| Create booking / pay / cancel | — | — | — | — | — | — | 👤 |
| Place shop order | — | — | — | — | — | — | ✅ |
| Register for tournament / check-in | — | — | — | — | — | — | ✅ |
| View leaderboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (public) |
| Own notifications | — | — | — | — | — | — | 👤 |

> Notes: A player can only ever see **their own** wallet, sessions, bookings, notifications. Leaderboards and announcements are public. Owner A can never see Owner B's data (tenant isolation).

---

## 3. Per-role detail

### SUPER_ADMIN (platform)
Approve/manage zones, global config, cross-zone. Bypasses zone role checks. Should not edit an owner's revenue records without an audit reason. *(Platform panel is future; base guard implemented.)*

### ZONE_OWNER — the admin
Full control of their zone: PCs, pricing, staff (create/roles), wallet reports, analytics, AI, shop, vouchers, packages, tournaments, announcements, audit, zone settings (e.g. enable postpaid), CSV export. This is who you log in as via **Seed** in the demo.

### BRANCH_MANAGER
Daily operations: PC map + commands, sessions, bookings, products/stock, order queue, wallet top-ups, analytics, AI, audit, announcements, tournaments. **Cannot** create staff or change zone-level settings.

### CASHIER
Counter work: start CASH sessions, wallet top-ups, sell/serve shop orders (queue + status), grant packages, basic refunds, view low-stock. **Cannot** see analytics/AI, edit products, manage staff, or export data.

### TECHNICIAN
Hardware only: PC status, maintenance mode, PC commands (lock/restart), client health. **No** wallet, revenue, customer, or analytics access.

### EVENT_MANAGER
Tournaments/events: create, manage registrations & check-in, submit results/rewards. Prize payouts/wallet changes need owner permission.

### Player / User
Own identity only: profile/passport, wallet top-up + spend, QR attach + session, bookings, shop orders, tournament registration, XP/coins/rank, notifications, public leaderboards. Cannot touch any operator function.

---

## 3b. Mobile & cross-zone permissions (Gap-Review)

- **Mobile = same RBAC.** The dashboard is responsive, so owner/manager/cashier/technician log in from a phone with the **exact same permissions** as desktop — never a weaker mobile security layer. Player mobile mode = the player web app/PWA.
- **Mobile admin actions are audit-logged** with user, role, zone, device, timestamp, payload.
- **Cross-zone events (📋 planned):** a new permission set — `EVENT_MANAGER`/`ZONE_OWNER` can send/accept collaboration requests, co-host shared events, and verify/dispute results. Owners only ever see **shared event data + their own financials** — never another zone's private customer/wallet data (tenant isolation still absolute).

## 4. How to test each role (demo)
1. **Seed demo zone** → you are **ZONE_OWNER**; 4 staff auto-created (phones `9700000001`–`04`).
2. **Login as staff** with a phone → dashboard runs with that role → restricted actions return **403** (visible in the activity log). **Back to Owner** to switch.
3. **Player App** tab → phone `9876543210` → OTP → player role.

| Role | Login |
|---|---|
| Owner | Seed button |
| Cashier | `9700000001` → Login as staff |
| Manager | `9700000002` → Login as staff |
| Technician | `9700000003` → Login as staff |
| Event Manager | `9700000004` → Login as staff |
| Player | `9876543210` → Player App + OTP |
