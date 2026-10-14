/**
 * Notification due-lead-time logic (Req 13.1, 13.5).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * Date math is performed in UTC to avoid timezone drift. Dates are handled as
 * ISO date strings (`YYYY-MM-DD`). The platform Notification_Service maps the
 * output of `dueLeadTimes` to actual `new Notification(...)` calls.
 */

import type { ReminderLeadTime } from "./models/settings";
import type { ISODate } from "./renewal";

/**
 * The only subscription field {@link dueLeadTimes} reads: the renewal date.
 * Structural so it serves both v1 `Subscription` and v2 `SubscriptionV2` (the
 * field is identical across versions).
 */
interface RenewableSubscription {
  nextRenewal: string;
}

/** Days before `nextRenewal` that each lead time targets. */
const LEAD_TIME_OFFSET_DAYS: Record<ReminderLeadTime, number> = {
  "same-day": 0,
  "one-day": 1,
  "three-days": 3,
};

/**
 * Canonical, deterministic ordering for emitted lead times. Independent of the
 * order of the `enabled` argument so the result is stable for a given input set.
 */
const LEAD_TIME_ORDER: readonly ReminderLeadTime[] = ["same-day", "one-day", "three-days"];

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

/** Adds a whole number of days to an ISO date using UTC arithmetic. */
function addDays(date: ISODate, days: number): ISODate {
  const { year, month, day } = parseISODate(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  return formatISODate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

/**
 * Returns the subset of `enabled` lead times whose target date equals `today`
 * for the given subscription (Req 13.1, 13.5):
 *
 * - "same-day"   qualifies when `sub.nextRenewal === today`
 * - "one-day"    qualifies when `sub.nextRenewal === today + 1 day`
 * - "three-days" qualifies when `sub.nextRenewal === today + 3 days`
 *
 * Only lead times that are both enabled AND due today are returned. The result
 * is in a deterministic canonical order (same-day, one-day, three-days),
 * regardless of the order of the `enabled` argument, and contains no duplicates.
 *
 * The subscription's `nextRenewal` is the source of truth; callers that roll
 * past renewals forward should do so before calling this function. Reading the
 * current `enabled` lead times on each evaluation lets updated notification
 * timing apply to subsequent evaluations (Req 13.5).
 */
export function dueLeadTimes(
  sub: RenewableSubscription,
  today: ISODate,
  enabled: ReminderLeadTime[],
): ReminderLeadTime[] {
  const enabledSet = new Set(enabled);
  return LEAD_TIME_ORDER.filter((leadTime) => {
    if (!enabledSet.has(leadTime)) return false;
    const targetDate = addDays(today, LEAD_TIME_OFFSET_DAYS[leadTime]);
    return sub.nextRenewal === targetDate;
  });
}
