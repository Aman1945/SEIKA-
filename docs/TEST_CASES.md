# SEIKA — Test Cases

Coverage against **SEIKA Gaming Zone OS — Complete Software Testing Plan**
(26 August 2026), modules A–N.

## How to run

```bash
pnpm --filter @seika/api test
```

The suite spins up its own in-memory MongoDB **replica set**, so every money
path runs inside a real multi-document transaction. No Docker, no seeding, no
manual steps. CI runs it on every push.

```bash
pnpm --filter @seika/api test:watch          # while developing
pnpm --filter @seika/api test b-session      # one module
```

Test files map one-to-one onto the plan's modules: `test/a-auth.test.ts`,
`test/b-session-authorization.test.ts`, and so on.

---

## Automated coverage: 136 cases

| Plan module | File | Cases | Notes |
|---|---|:--:|---|
| **A** Auth & accounts | `a-auth.test.ts` | 7 | OTP signup/login, staff audience separation, wrong OTP, refresh-token rotation and reuse, profile customization |
| **B** PC kiosk & session authorization | `b-session-authorization.test.ts` | 10 | QR ≠ unlock, wallet/cash/package/voucher/postpaid authorization, session end locks the PC, one live session per PC, tampered QR |
| **C** Top-up + hour selection | `c-hour-selection.test.ts` | 8 | cash top-up, 1h/2h/3h blocks, frozen `pricingSnapshot`, Open Hour deposit and metering, early end |
| **D** Wallet, payments, refunds, ledger | `d-wallet-payments.test.ts` | 12 | balance == SUM(ledger), no direct balance write, webhook idempotency and signature, session and shop refunds, mid-transaction rollback, wallet/coins separation |
| **E** Bookings & reservations | `e-bookings.test.ts` | 11 | pricing, wallet payment, QR check-in, exact and partial overlap conflicts, cancel/refund, check-in window, cross-player and cross-tenant authorization |
| **H** Shop/POS & seated-zone shop | `h-shop-seated-zone.test.ts` | 10 | catalogue scoping, seat binding to session+PC+zone, oversell, queue flow, wrong-zone ordering, ordering with no session |
| **I** XP, rank, coins, leaderboards | `i-xp-leaderboard.test.ts` | 13 | XP per valid minute, 0 XP from login, level-up coins, rank granted once, global/region/country/city/zone/game boards, period windows, refund reverses XP |
| **J** Events & cross-zone | `j-crosszone.test.ts` | 14 | owner-to-owner connections, co-host invites, per-zone registration and check-in, shared bracket isolation, result consensus, disputes, prize/revenue split — **including the §8 two-zone end-to-end flow** |
| **K** Smart Sync | `k-smartsync.test.ts` | 14 | game whitelist, download/upload, version conflicts, forbidden folders, anti-cheat exclusions with audit logging, pre-flight screening, size limits |
| **L** Analytics, reports, export | `l-analytics-export.test.ts` | 12 | revenue overview, occupancy, player retention, shop and event analytics, six datasets × CSV/xlsx/PDF, date ranges, tenant scoping, CSV-injection neutralisation |
| **M** RBAC, security, tenant isolation | `m-rbac-security.test.ts` | 12 | per-role 403s, self-elevation, owner A vs owner B across sessions/orders/products/analytics/audit, OTP rate limiting, sensitive-action audit |
| **N** Data migration | `n-migration.test.ts` | 13 | CSV parsing, column mapping, row validation, duplicates, opening balance as a ledger entry, OTP activation, rollback, short-import refusal |

### Not automated

| Plan module | Status | Why |
|---|---|---|
| **B8** heartbeat loss | Manual | Needs a real kiosk process to stop heartbeating. Covered in the pilot checklist. |
| **F** Player mobile app | Not built | The player PWA does not exist yet; the single-file demo console is not what the plan's F cases describe. API-level equivalents are covered under A/C/D/I. |
| **G** Owner/admin mobile app | Not built | Same: needs the owner dashboard app. API-level RBAC is covered under M. |
| **K** kiosk-side execution | Partial | The sync *policy* is tested server-side. The kiosk actually reading and writing those folders needs a Windows box (plan §11). |

---

## Release gates

The plan's §10 sign-off checklist, against what is verified today:

| Gate | Status |
|---|---|
| QR ≠ unlock, XP from valid minutes only, wallet/coins separated, append-only ledger | ✅ automated |
| Top-up + 1h/2h/3h/Open Hour selection | ✅ automated |
| Insufficient balance never unlocks a PC | ✅ automated |
| Lock/unlock is server-side only | ✅ automated (API); kiosk side manual |
| Player app shows sessions, hours, XP, wallet, coins, bookings, shop, leaderboard | 🟡 API verified; the app itself is not built |
| Owner/admin monitoring from mobile with RBAC + audit | 🟡 API verified; the app itself is not built |
| Seated-zone shop tied to `activeSessionId` + `pcId` + `zoneId` | ✅ automated |
| Bookings with payment, QR check-in, conflicts, cancellation/refund | ✅ automated |
| Wallet payments, refunds, webhook idempotency | ✅ automated |
| Leaderboards: global, region, country, city, zone, game | ✅ automated |
| Cross-zone built and one two-zone flow tested | ✅ automated (`J-full`) |
| Smart Sync blocks private/unsafe folders | ✅ automated (policy); kiosk execution manual |
| Analytics and exports accurate and audit-logged | ✅ automated |
| Tenant isolation for owners, staff, players, cross-zone participants | ✅ automated |
| All S0/S1 bugs closed | 🟡 see `docs/STATUS.md` |

---

## Bugs these tests found

Writing the suite surfaced seven real defects in code that had been recorded as
verified. Each is fixed, with the test that catches it:

1. **Two players could be billed on one PC.** The "one live session per PC"
   index was keyed `{pcId, status}`, making the *pair* unique — so a PC could
   hold a `PENDING_AUTH` and an `ACTIVE` session at once. (`b-session`)
2. **Any player could cancel a stranger's paid booking** by id. No ownership or
   zone check. (`e-bookings`)
3. **Any player could trigger a wallet debit against another player** by paying
   their pending booking. (`e-bookings`)
4. **Orders trusted a client-supplied `zoneId`**, so a player seated in zone A
   could order from zone B's catalogue. (`h-shop`)
5. **The game leaderboard was the global board renamed.** `scope=game` was
   accepted and ignored because sessions carried no game. The old test only
   asserted HTTP 200, so it could not tell. (`i-xp`)
6. **Migration uploads could never have worked**: `express.json` ran at its
   100kb default while the endpoint documented 5MB, and an oversized body
   returned 500 instead of 413. (`k-smartsync`)
7. **Player profile customization (A6) did not exist.** (`a-auth`)
