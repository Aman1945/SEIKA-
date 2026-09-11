# SEIKA — Test Cases (40)

How to use: run the API (`pnpm dev:api:mem` → http://localhost:4000, or the live `:4010`). Most tests are doable in the **web console**; a few are API-level (use `/docs` or curl). Tick the box when it passes. ✅ = already verified during the build.

Legend: **Console** = do it in the web UI · **API** = call the endpoint directly.

---

## A. Auth & accounts
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| A1 | Console | Player tab → phone `9876543210` → Get OTP → Login | Logs in, passport shows Lv1 Rookie | ✅ |
| A2 | API | `POST /auth/otp/verify` with wrong code | 401 Invalid code | ✅ |
| A3 | Console | Seed → "Login as staff" `9700000001` | "Acting as: CASHIER" | ✅ |
| A4 | API | `POST /auth/refresh` with a valid refresh token | New access+refresh pair | ✅ |
| A5 | API | Reuse an old (rotated) refresh token | 401 revoked | ☐ |
| A6 | API | `GET /auth/me` without token | 401 Unauthorized | ✅ |

## B. Session Authorization Engine (core)
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| B1 | Console | Player with ₹0 → Start session | Stays LOCKED / 402 INSUFFICIENT_BALANCE | ✅ |
| B2 | Console | Top-up ₹200 → Start session | Authorized, PC UNLOCKS, status ACTIVE | ✅ |
| B3 | Console | While one session active, seed PC busy → attach again | 409 PC already has active session | ✅ |
| B4 | Console | End session after playing | validMinutes computed, cost deducted, XP awarded | ✅ |
| B5 | API | Authorize source=CASH as a player (no staff) | 403 cash requires cashier | ✅ |
| B6 | API | Authorize source=CASH as cashier | Authorized | ✅ |
| B7 | API | Authorize source=POSTPAID when zone disabled | 402 POSTPAID_DISABLED | ✅ |
| B8 | API | Enable postpaid (owner) then authorize POSTPAID as staff | Authorized | ✅ |
| B9 | API | QR login only, never authorize | Player XP stays 0 | ✅ |

## C. Wallet & payments
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| C1 | Console | Cashier top-up ₹100 | Balance +100, ledger entry | ✅ |
| C2 | API | Compare balance vs SUM(ledger) | Exactly equal | ✅ |
| C3 | API | Razorpay: create order → simulate webhook | Wallet credited once | ✅ |
| C4 | API | Replay the same webhook | alreadyPaid, no double credit | ✅ |
| C5 | API | Webhook with bad signature | 401 invalid signature | ☐ |
| C6 | Console | End a WALLET session | Cost debited (one txn) | ✅ |

## D. Bookings
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| D1 | Console | Book +1hr slot | Booking created, amount shown, unpaid | ✅ |
| D2 | Console | Pay booking from wallet | paid, balance drops | ✅ |
| D3 | API | Book overlapping slot on same PC | 409 conflict | ✅ |
| D4 | Console | Cancel a paid booking | Cancelled, wallet refunded | ✅ |
| D5 | API | Check-in outside window | 400 outside check-in window | ☐ |

## E. XP, coins, ranks, leaderboard
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| E1 | API | Award 60 valid minutes | +50 XP | ✅ |
| E2 | API | Level up across a rank (→ Bronze) | Coins granted (per-level + rank) | ✅ |
| E3 | Console | Leaderboard after sessions | Ordered by XP, your name appears | ✅ |
| E4 | API | Zone weekly leaderboard | Aggregates this-week session XP | ✅ |

## F. Shop / POS
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| F1 | Console | Owner adds product | Appears in catalog | ✅ |
| F2 | Console | Player buys item (wallet) | Wallet debited, stock −1 | ✅ |
| F3 | API | Order more than stock | 409 out of stock | ☐ |
| F4 | Console | Owner order queue → advance to delivered | Status flows received→…→delivered | ✅ |
| F5 | API | Cancel a paid order | Restocked + wallet refunded | ☐ |
| F6 | Console | Stock ≤ threshold | Shows in low-stock | ✅ |

## G. Vouchers & packages
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| G1 | Console | Owner creates voucher | Created (code uppercased) | ✅ |
| G2 | API | Authorize VOUCHER without code | VOUCHER_CODE_REQUIRED | ✅ |
| G3 | API | Authorize with valid code (maxRedemptions 1) | Authorized (free play) | ✅ |
| G4 | API | Second player uses same 1-use voucher | VOUCHER_EXHAUSTED | ✅ |
| G5 | API | Authorize PACKAGE with no package | NO_ACTIVE_PACKAGE | ✅ |
| G6 | API | Grant 120-min package → authorize + play + end | Package minutes deducted, wallet untouched | ✅ |

## H. Staff & RBAC
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| H1 | Console | Owner creates cashier | Created, appears in list | ✅ |
| H2 | Console | Login as cashier → view order queue | Allowed | ✅ |
| H3 | Console | As cashier → open Analytics/AI | Empty / 403 | ✅ |
| H4 | API | As cashier → create staff | 403 owner only | ✅ |
| H5 | Console | As technician → wallet top-up | 403 | ☐ |
| H6 | Console | As event manager → create tournament | Allowed | ☐ |

## I. Tournaments
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| I1 | API | Owner creates tournament (entry ₹100) | Created | ✅ |
| I2 | API | Two funded players register | Both paid, wallet −100 each | ✅ |
| I3 | API | Register when full (maxPlayers reached) | 409 full | ☐ |
| I4 | API | Register twice (same player) | 409 already registered | ☐ |
| I5 | API | Submit results (1st/2nd) | Winner gets bonus XP + coins; all get participation XP | ✅ |

## J. Notifications, audit, announcements, analytics
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| J1 | Console | Advance an order's status | Player gets ORDER notifications | ✅ |
| J2 | Console | Player → mark all read | Unread count → 0 | ✅ |
| J3 | Console | Owner → do top-up + export | Audit log shows WALLET_TOPUP + DATA_EXPORT | ✅ |
| J4 | Console | Owner publishes announcement | Players see it (pinned first) | ✅ |
| J5 | Console | Analytics overview | Revenue/occupancy/top-ups correct | ✅ |
| J6 | API | CSV export | Header + rows; access audit-logged | ✅ |

## K. Security & integrity
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| K1 | API (prod) | >5 OTP requests/min from one IP | 429 rate-limited (dev: disabled) | ✅ |
| K2 | API | Refund a completed session | Wallet + XP + coins reversed, status REFUNDED | ✅ |
| K3 | API | Money op forced to fail mid-transaction | No partial write (rolls back) | ☐ |
| K4 | API | Owner A requests Owner B's data | Denied (tenant isolation) | ☐ |

## L. Gap-Review additions
| # | Where | Steps | Expected | ✓ |
|---|---|---|---|---|
| L1 | API | Authorize FIXED_DURATION without selectedMinutes | 400 (needs 60/120/180) | ✅ |
| L2 | API | FIXED 2h (rate ₹60) → need ₹120; authorize with balance ≥120 | Authorized, minStartAmount 120 | ✅ |
| L3 | API | End FIXED 2h session | Billed the 2h block (₹120), endReason set | ✅ |
| L4 | API | OPEN_HOUR authorize | Needs min deposit, then authorized | ✅ |
| L5 | API | OPEN_HOUR with balance below deposit | INSUFFICIENT_BALANCE, PC locked | ☐ |
| L6 | API | Leaderboard scope=global/region/country/city/zone/game | All return 200 | ✅ |
| L7 | API | Region leaderboard `region=South Asia` | Ranks players in region countries | ✅ |
| L8 | Console | Owner logs in from a phone browser | Same dashboard, same RBAC | ☐ |
| L9 | API | Seated player in Zone A requests Zone B shop | Only Zone A catalog (📋 enforce seat binding) | 🟡 |
| L10 | API | Payment provider abstraction: Stripe/Easypaisa create same ledger | 📋 planned | 📋 |
| L11 | API | Cross-zone event: Owner A invites B, players register both zones | 📋 planned | 📋 |
| L12 | Kiosk | Smart Sync: whitelisted config downloads pre-session, uploads post | 📋 planned | 📋 |
| L13 | API | Migration wizard: CSV import creates players + opening balances | 📋 planned | 📋 |

---

### Summary
- **✅ verified during build:** ~34
- **☐ ready to run (edge cases):** ~11
- **📋 planned (module not built yet):** ~4
- Total: **53 cases** across 12 areas.

Re-run the automated smokes anytime with the Python scripts pattern used during the build (seed → act → assert), or click through the web console following the steps above.
