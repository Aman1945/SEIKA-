/**
 * Navigation icons.
 *
 * These were Unicode glyphs — ☕ for orders, ⏱ for sessions. Some of those are
 * emoji on most systems, so they rendered in colour on one machine and as a
 * hollow outline on the next, at whatever size and baseline that font chose.
 * An icon that changes shape between two PCs in the same zone is not an icon.
 *
 * Drawn here instead: one family, 16px box, 1.5 stroke, round caps, currentColor.
 * They inherit the colour of the nav item, so active and hover states need no
 * second set.
 */

type Props = { className?: string };

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Live — the PC grid. */
export const IconGrid = (p: Props) => (
  <svg {...base} {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </svg>
);

/** Orders — a cup, since most of what a zone sells is drinks and snacks. */
export const IconCup = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M3 5h8v5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V5Z" />
    <path d="M11 6h1.5a1.5 1.5 0 0 1 0 3H11" />
  </svg>
);

/** Sessions — a clock, because a session is time. */
export const IconClock = (p: Props) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </svg>
);

/** Revenue — a trend line, not a currency sign; the page is about movement. */
export const IconTrend = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M2 11.5 6 7l3 3 5-5.5" />
    <path d="M14 8V4.5H10.5" />
  </svg>
);

/** Shop — a box of stock. */
export const IconBox = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M2 5.5 8 2.5l6 3v5l-6 3-6-3v-5Z" />
    <path d="M2 5.5 8 8.5l6-3M8 8.5v5" />
  </svg>
);

/** Events — a flag. */
export const IconFlag = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M3.5 14V2.5" />
    <path d="M3.5 3h8l-1.5 2.5L11.5 8h-8" />
  </svg>
);

/** Staff — people. */
export const IconUsers = (p: Props) => (
  <svg {...base} {...p}>
    <circle cx="6" cy="5.5" r="2.5" />
    <path d="M2 13.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" />
    <path d="M11 3.3a2.5 2.5 0 0 1 0 4.4M12 10.2c1.3.4 2 1.6 2 3.3" />
  </svg>
);

/** Audit — a list of what happened. */
export const IconList = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M6 4h8M6 8h8M6 12h8" />
    <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </svg>
);

/** Import — bringing data in. */
export const IconImport = (p: Props) => (
  <svg {...base} {...p}>
    <path d="M8 2v7" />
    <path d="M5 6.5 8 9.5l3-3" />
    <path d="M2.5 11v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />
  </svg>
);
