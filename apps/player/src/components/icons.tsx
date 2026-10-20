/**
 * Tab bar icons.
 *
 * These were Unicode glyphs — ☕ for the shop, ♛ for ranks, ₹ for the wallet.
 * Several of those are emoji on most systems, so they came out in colour on
 * one phone and as a hollow outline on the next, at whatever size and
 * baseline that font picked. A tab bar that changes shape between two players'
 * phones is not a tab bar.
 *
 * One family instead: 20px box, 1.6 stroke, round caps, currentColor — so the
 * active state needs no second set of files.
 */

type Props = { className?: string };

const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Passport — an identity card. */
export const IconPassport = (p: Props) => (
  <svg {...base} {...p}>
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <circle cx="8" cy="8.5" r="2" />
    <path d="M5 15c.6-1.8 1.8-2.6 3-2.6s2.4.8 3 2.6M12.5 7.5h2.5M12.5 10.5h2.5" />
  </svg>
);

/** Play — start a session. */
export const IconPlay = (p: Props) => (
  <svg {...base} {...p}>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M8.4 7.2 13 10l-4.6 2.8V7.2Z" />
  </svg>
);

/** Wallet — money held, not a currency symbol. */
export const IconWallet = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M3 6.5A2 2 0 0 1 5 4.5h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7Z" />
    <path d="M16 9h-2.6a1.5 1.5 0 0 0 0 3H16" />
  </svg>
);

/** Shop — a cup, since most of what a zone sells is drinks and snacks. */
export const IconShop = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M4 6.5h9v6a3.5 3.5 0 0 1-3.5 3.5h-2A3.5 3.5 0 0 1 4 12.5v-6Z" />
    <path d="M13 8h1.8a1.8 1.8 0 0 1 0 3.6H13" />
  </svg>
);

/** Ranks — a podium, which is what a leaderboard actually is. */
export const IconRanks = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M8 8.5h4v8H8v-8ZM3 11.5h5v5H3v-5ZM12 6.5h5v10h-5v-10Z" />
  </svg>
);
