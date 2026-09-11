# SEIKA — Gap Review Completion Report

Response to **SEIKA Developer Gap Review Response**. Each requested item below is mapped to its status and where it was addressed.

Status: **✅ built + tested** · **🟡 partial (base built, refinement pending)** · **📋 planned (documented; affects schema/API — build next)**

---

## Critical gaps

| Pri | Gap | Status | Where |
|---|---|---|---|
| P0 | Player top-up + **session-hour selection** (1h/2h/3h/Open Hour) | ✅ | `session.engine.ts`, `Session` model (`sessionMode`, `selectedMinutes`, `pricingSnapshot`, `endReason`); tests L1–L4 |
| P0 | **Owner/admin mobile login** | 🟡 | Responsive dashboard + same RBAC works on phone today; dedicated app modes planned |
| P0 | **Seated-zone shop** on mobile + PC | 🟡 | Shop zone-scoped + live order queue built; seat/session binding refinement planned |
| P1 | **Cross-zone events** | 📋 | Single-zone tournaments built; owner-to-owner network planned |
| P1 | **Leaderboard hierarchy** (Global/Region/Country/City/Zone/Game) | ✅ | `leaderboard.service.ts`; tests L6–L7 |
| P1 | **Smart Sync** | 📋 | Belongs in kiosk; documented |
| P1 | **Payment gateway abstraction** | 📋 | Razorpay + idempotent webhook built; `PaymentProvider` interface planned |
| P2 | **Data migration wizard** | 📋 | Documented (CSV → map → validate → import → OTP-activate) |

## Approved directions — all kept
QR ≠ unlock ✅ · XP only from valid minutes ✅ · wallet ≠ coins, append-only ledger ✅ · full RBAC ✅ · POS base ✅ · testing mindset ✅ (53 cases now).

## Session-hour module — required fields (all added)
| Requested field | Added as |
|---|---|
| `sessionMode` FIXED_DURATION/OPEN_HOUR | ✅ `Session.sessionMode` |
| `selectedMinutes` 60/120/180/null | ✅ `Session.selectedMinutes` |
| `pricingSnapshot` (rate frozen at start) | ✅ `Session.pricingSnapshot` |
| `minimumStartBalance` (Open Hour) | ✅ in `pricingSnapshot.minimumStartBalance` |
| `sessionEndReason` | ✅ `Session.endReason` |
| WalletLedger types (TOPUP/HOLD/DEBIT/REFUND…) | 🟡 have TOPUP/DEDUCT/REFUND/BOOKING/SHOP/PACKAGE; HOLD + split TOPUP_ONLINE/CASH planned |

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
