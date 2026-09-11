# SEIKA — Gap Review Completion Report

Response to **SEIKA Developer Gap Review Response**. Each requested item below is mapped to its status and where it was addressed.

Status: **✅ built + tested** · **🟡 partial (base built, refinement pending)** · **📋 planned (documented; affects schema/API — build next)**

> **Superseded, 11 September 2026.** Every 📋 item in this report except the
> payment-provider abstraction has since been built and tested, and the two 🟡
> items were closed. The leaderboard row below was also overstated: the `game`
> scope accepted the parameter and ignored it, because sessions carried no game.
> Current status: [`docs/STATUS.md`](STATUS.md). Coverage:
> [`docs/TEST_CASES.md`](TEST_CASES.md).

---

## Critical gaps

| Pri | Gap | Status | Where |
|---|---|---|---|
| P0 | Player top-up + **session-hour selection** (1h/2h/3h/Open Hour) | ✅ | `session.engine.ts`, `Session` model (`sessionMode`, `selectedMinutes`, `pricingSnapshot`, `endReason`); tests L1–L4 |
| P0 | **Owner/admin mobile login** | 🟡 | API + RBAC done and tested; the dashboard app itself is still unbuilt |
| P0 | **Seated-zone shop** on mobile + PC | ✅ | Orders now bind to the live session's zone + PC, derived server-side; `h-shop-seated-zone.test.ts` |
| P1 | **Cross-zone events** | ✅ | Connections, co-hosting, per-zone registration/check-in, shared bracket, verification, disputes, split; `j-crosszone.test.ts` incl. the §8 two-zone flow |
| P1 | **Leaderboard hierarchy** (Global/Region/Country/City/Zone/Game) | ✅ | Game scope is real now — `Session.game` added; period-bounded geo boards too; `i-xp-leaderboard.test.ts` |
| P1 | **Smart Sync** | ✅ | Policy, whitelist, anti-cheat exclusions and versioned storage server-side; `k-smartsync.test.ts`. Kiosk client pending |
| P1 | **Payment gateway abstraction** | 📋 | Still the one open item: Razorpay only |
| P2 | **Data migration wizard** | ✅ | CSV → map → validate → commit, opening balance as a ledger entry, transactional rollback; `n-migration.test.ts` |

## Approved directions — all kept
QR ≠ unlock ✅ · XP only from valid minutes ✅ · wallet ≠ coins, append-only ledger ✅ · full RBAC ✅ · POS base ✅ · testing ✅ — **136 automated cases** now run in CI, replacing the 53 manual ones this report counted.

## Session-hour module — required fields (all added)
| Requested field | Added as |
|---|---|
| `sessionMode` FIXED_DURATION/OPEN_HOUR | ✅ `Session.sessionMode` |
| `selectedMinutes` 60/120/180/null | ✅ `Session.selectedMinutes` |
| `pricingSnapshot` (rate frozen at start) | ✅ `Session.pricingSnapshot` |
| `minimumStartBalance` (Open Hour) | ✅ in `pricingSnapshot.minimumStartBalance` |
| `sessionEndReason` | ✅ `Session.endReason` |
| WalletLedger types (TOPUP/HOLD/DEBIT/REFUND…) | 🟡 TOPUP/DEDUCT/REFUND/ADJUST/BOOKING/SHOP/PACKAGE + OPENING_BALANCE (migration); HOLD and split TOPUP_ONLINE/CASH still planned |

## Docs updated (reviewer checklist)
- ✅ `PRODUCT_WORKING.md` — new §11b covers all 7 gap modules with status.
- ✅ `ROLES_AND_ACCESS.md` — new §3b: mobile permissions + cross-zone permissions.
- ✅ `TEST_CASES.md` — new section L (13 gap-review tests); total 53.
- ✅ This report.

## Recommended build order for the 📋 items
1. Payment-provider abstraction (unblocks global gateways; low risk).
2. Seated-shop seat/session binding (revenue; small).
3. Cross-zone events (network differentiator; medium).
4. Data migration wizard (onboarding; medium).
5. Smart Sync in kiosk (differentiator; larger, Windows-tested).
6. Dedicated mobile app modes / PWA polish.

## Verified this round
- FIXED 2h → billed ₹120 block, wallet 300→180, `endReason` set.
- FIXED missing minutes → 400.
- OPEN_HOUR → min deposit enforced.
- Leaderboard global/region/country/city/zone/game → all 200.
