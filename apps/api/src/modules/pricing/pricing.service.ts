import { PricingRule } from "../../models/PricingRule.js";

/**
 * What a PC costs right now.
 *
 * Every price in SEIKA comes through here: the session engine when it
 * authorises, and bookings when they quote. One path, so a zone cannot find
 * that happy hour applied to walk-ins but not to reservations.
 */

export interface RatedPc {
  zoneId: unknown;
  branchId?: unknown;
  category?: string | null;
  hourlyRate: unknown;
}

export interface ResolvedRate {
  rate: number;
  /** The rule that set it, for the receipt and the dashboard. */
  label: string | null;
  baseRate: number;
}

/** Minutes from midnight, in the zone's own day. */
function minutesOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * Does a window contain this moment?
 *
 * A window whose end is before its start crosses midnight — 22:00 to 02:00 —
 * and a zone writes late-night rates that way because that is how people say
 * it. Handling it here means a rule never has to be split in two.
 */
function windowContains(startMinute: number, endMinute: number, minute: number): boolean {
  if (startMinute === endMinute) return true; // all day
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/**
 * How specific a rule is.
 *
 * "VIP on Saturday night" should beat "everything at night", or a zone cannot
 * express both. Branch and category are worth more than the day because they
 * describe which machines, not just when.
 */
function specificity(rule: {
  branchId?: unknown;
  category?: string | null;
  days?: number[];
}): number {
  return (rule.branchId ? 4 : 0) + (rule.category ? 2 : 0) + (rule.days?.length ? 1 : 0);
}

const num = (v: unknown): number => (v == null ? 0 : parseFloat(String(v)));

/**
 * The rate for a PC at a moment, and why.
 *
 * Falls back to the PC's own hourlyRate when nothing matches, which is what
 * every zone has today and what a zone that never writes a rule keeps.
 */
export async function resolveRate(pc: RatedPc, at: Date = new Date()): Promise<ResolvedRate> {
  const baseRate = num(pc.hourlyRate);

  const rules = await PricingRule.find({ zoneId: pc.zoneId, active: true }).lean();
  if (!rules.length) return { rate: baseRate, label: null, baseRate };

  const day = at.getDay();
  const minute = minutesOfDay(at);

  const matching = rules.filter((r) => {
    if (r.branchId && String(r.branchId) !== String(pc.branchId ?? "")) return false;
    if (r.category && r.category !== (pc.category ?? null)) return false;
    if (r.days?.length && !r.days.includes(day)) return false;
    return windowContains(r.startMinute, r.endMinute, minute);
  });

  if (!matching.length) return { rate: baseRate, label: null, baseRate };

  // Most specific wins; a tie goes to the cheaper rate, because a zone that
  // has written two overlapping offers meant to give the player the better
  // one, and the alternative is charging more than the sign on the wall.
  const best = matching
    .map((r) => ({
      rule: r,
      rate: r.rate != null ? num(r.rate) : baseRate * (r.multiplier ?? 1),
    }))
    .sort((a, b) => specificity(b.rule) - specificity(a.rule) || a.rate - b.rate)[0];

  // Never negative, and rounded to paise — this figure becomes money.
  const rate = Math.max(0, Math.round(best.rate * 100) / 100);
  return { rate, label: best.rule.label ?? null, baseRate };
}
