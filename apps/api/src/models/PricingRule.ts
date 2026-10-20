import { Schema, model, Types } from "mongoose";

/**
 * Time-of-day pricing for a zone.
 *
 * A gaming zone does not charge one price all day. Weekday afternoons are
 * dead and weekend nights are full, and the rate is how an owner moves
 * players into the quiet hours. Until now a PC had a single hourlyRate, so
 * "happy hour" meant editing every PC twice a day and remembering to put it
 * back.
 *
 * A rule narrows by any combination of branch, category and weekday, and
 * covers a window of the day. The most specific match wins; nothing matching
 * leaves the PC's own rate, which is what every existing zone already has.
 */
const pricingRuleSchema = new Schema(
  {
    zoneId: { type: Types.ObjectId, ref: "Zone", required: true, index: true },
    /** Unset means every branch in the zone. */
    branchId: { type: Types.ObjectId, ref: "Branch", default: null },
    /** Unset means every category: standard, premium, vip. */
    category: { type: String, default: null },

    /** Shown to staff and on the player's receipt: "Happy hour", "Weekend". */
    label: { type: String, required: true },

    /**
     * Days this applies to, 0 = Sunday. Empty means every day.
     *
     * A weekday/weekend split is the most common rule a zone writes, and it
     * is the reason this is a list rather than a single flag.
     */
    days: { type: [Number], default: [] },

    /**
     * Minutes from midnight, local to the zone.
     *
     * Stored as minutes rather than a time string so comparison is arithmetic
     * — no parsing on a path that runs on every session authorisation.
     */
    startMinute: { type: Number, required: true, min: 0, max: 1439 },
    /**
     * Exclusive. May be LESS than startMinute, which means the window crosses
     * midnight — 22:00 to 02:00 is a normal late-night rate and the obvious
     * way to write it.
     */
    endMinute: { type: Number, required: true, min: 0, max: 1439 },

    /** An absolute hourly rate. Takes precedence over multiplier. */
    rate: { type: Schema.Types.Decimal128, default: null },
    /** Or a factor on the PC's own rate: 0.5 for half price, 1.5 for peak. */
    multiplier: { type: Number, default: null },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/** The resolver reads every live rule for a zone on each authorisation. */
pricingRuleSchema.index({ zoneId: 1, active: 1 });

export const PricingRule = model("PricingRule", pricingRuleSchema);
