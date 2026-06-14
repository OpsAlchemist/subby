/**
 * Renewal calculation (Req 5.3, 5.4).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * Date math is performed in UTC to avoid timezone drift. Dates are handled as
 * ISO date strings (`YYYY-MM-DD`); since this format is lexicographically
 * ordered, plain string comparison is sufficient for chronological ordering.
 */

import type { BillingCycle, CustomInterval, Subscription } from "./models/subscription";

/** ISO date string in the form `YYYY-MM-DD`. */
export type ISODate = string;

/** Parses an `YYYY-MM-DD` string into its numeric year/month/day parts. */
function parseISODate(date: ISODate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return { year, month, day };
}

/** Formats numeric year/month/day parts back into an `YYYY-MM-DD` string. */
function formatISODate(year: number, month: number, day: number): ISODate {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Number of days in the given (1-based) month of the given year, in UTC. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of `month` (UTC).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds a whole number of days to an ISO date using UTC arithmetic. */
function addDays(date: ISODate, days: number): ISODate {
  const { year, month, day } = parseISODate(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return formatISODate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

/**
 * Adds a whole number of months to an ISO date using UTC arithmetic.
 * Month-end days are clamped to the last valid day of the target month
 * (e.g., Jan 31 + 1 month → Feb 28, or Feb 29 in a leap year).
 */
function addMonths(date: ISODate, months: number): ISODate {
  const { year, month, day } = parseISODate(date);
  // Convert to a zero-based absolute month index, shift, then split back out.
  const zeroBasedMonth = month - 1 + months;
  const targetYear = year + Math.floor(zeroBasedMonth / 12);
  const targetMonth = ((zeroBasedMonth % 12) + 12) % 12 + 1; // 1-based, normalized
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return formatISODate(targetYear, targetMonth, clampedDay);
}

/** Advances an ISO date by exactly one configured custom interval. */
function advanceCustom(date: ISODate, custom: CustomInterval): ISODate {
  switch (custom.unit) {
    case "day":
      return addDays(date, custom.count);
    case "week":
      return addDays(date, custom.count * 7);
    case "month":
      return addMonths(date, custom.count);
    case "year":
      return addMonths(date, custom.count * 12);
  }
}

/**
 * Advances an ISO date by exactly one billing interval (Req 5.3, 5.4).
 *
 * - Weekly      → +7 days
 * - Monthly     → +1 month
 * - Quarterly   → +3 months
 * - Half-Yearly → +6 months
 * - Yearly      → +1 year
 * - Custom      → +1 configured custom interval (unit × count)
 *
 * @throws if `cycle` is "Custom" but no `custom` interval is supplied.
 */
export function advanceRenewal(date: ISODate, cycle: BillingCycle, custom?: CustomInterval): ISODate {
  switch (cycle) {
    case "Weekly":
      return addDays(date, 7);
    case "Monthly":
      return addMonths(date, 1);
    case "Quarterly":
      return addMonths(date, 3);
    case "Half-Yearly":
      return addMonths(date, 6);
    case "Yearly":
      return addMonths(date, 12);
    case "Custom":
      if (!custom) {
        throw new Error("advanceRenewal: Custom billing cycle requires a custom interval");
      }
      return advanceCustom(date, custom);
  }
}

/**
 * Rolls a past `nextRenewal` forward when `autoRenew` is true, advancing by
 * whole billing intervals until it is on or after `today` (Req 5.3, 5.4).
 *
 * Returns the same object reference when nothing changes (autoRenew is false,
 * or `nextRenewal` is already on/after `today`); otherwise returns a new object
 * with the updated `nextRenewal`.
 */
export function rollForward(s: Subscription, today: ISODate): Subscription {
  if (!s.autoRenew) return s;
  let next = s.nextRenewal;
  // Lexicographic comparison is valid for `YYYY-MM-DD` strings.
  while (next < today) {
    next = advanceRenewal(next, s.billingCycle, s.customInterval);
  }
  return next === s.nextRenewal ? s : { ...s, nextRenewal: next };
}
