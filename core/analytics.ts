/**
 * Analytics aggregations and orderings consumed by the Dashboard and the
 * Analytics view (Req 8.1–8.5, 11.1–11.5).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * Every function in this module is PURE:
 *   - it never mutates its inputs in place (arrays/objects are copied before
 *     sorting or grouping), and
 *   - it never reads the wall clock; callers pass `today` for determinism.
 *
 * Date handling matches `core/renewal.ts`: dates are ISO date strings
 * (`YYYY-MM-DD`). Because that format is lexicographically ordered, plain
 * string comparison is sufficient for chronological ordering, and date
 * arithmetic is performed in UTC to avoid timezone drift.
 *
 * Sorting note: `Array.prototype.sort` is stable (ES2019+), so the descending
 * orderings below preserve the relative input order of equal-keyed elements.
 * Combined with sorting a defensive copy, each ordering is a stable permutation
 * (or a prefix thereof) of its input.
 */

import { monthlyAmount, sumMonthly, yearlyAmount } from "./billing";
import type { ISODate } from "./renewal";
import { activeSubscriptionsV2 } from "./subscriptionsV2";
import type { SubscriptionV2 } from "./models/subscription";

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

// --- Totals and counts (Req 8.1, 8.2, 8.3, 11.1, 11.3) -----------------------

/**
 * Total monthly spend: the sum of the normalized monthly amounts of the given
 * subscriptions, summed directly with no currency conversion (Req 8.1, 11.1).
 *
 * Callers pass the already-active subscriptions; this reuses
 * {@link sumMonthly} from `core/billing`.
 */
export function totalMonthly(active: SubscriptionV2[]): number {
  return sumMonthly(active);
}

/**
 * Total yearly spend: the sum of the normalized yearly amounts of the given
 * subscriptions (each subscription's monthly amount multiplied by twelve)
 * (Req 8.2, 11.3). Callers pass the already-active subscriptions.
 */
export function totalYearly(active: SubscriptionV2[]): number {
  return active.reduce((acc, s) => acc + yearlyAmount(s), 0);
}

/**
 * Count the live subscriptions within `subs` (Req 8.3, AD-17). Accepts the full
 * set and counts those whose state is Active **or** Trial — both are live, only
 * the *spend* excludes Trial — reusing the shared {@link activeSubscriptionsV2}
 * seam. Paused is excluded.
 */
export function activeCount(subs: SubscriptionV2[]): number {
  return activeSubscriptionsV2(subs).length;
}

// --- Date-window and recency selections (Req 8.4, 8.5) -----------------------

/**
 * Return the subscriptions whose `nextRenewal` falls within the inclusive
 * window `[today, today + days]` (Req 8.4) — e.g. "renewing in the next seven
 * days" on the dashboard.
 *
 * This is a faithful subset filter: the result preserves the input order and
 * contains only matching subscriptions; the input is never mutated. Date
 * comparison uses lexicographic ordering of `YYYY-MM-DD` strings (valid
 * because the upper bound is computed in UTC via {@link addDays}).
 */
export function renewingWithin(
  subs: SubscriptionV2[],
  days: number,
  today: ISODate,
): SubscriptionV2[] {
  const upper = addDays(today, days);
  return subs.filter((s) => s.nextRenewal >= today && s.nextRenewal <= upper);
}

/**
 * Return the `n` most recently changed subscriptions, ordered by `updatedAt`
 * descending (Req 8.5). `updatedAt` is an ISO datetime string, so lexicographic
 * comparison yields chronological order.
 *
 * Sorting is performed on a copy (the input is never mutated); the stable sort
 * preserves the relative order of subscriptions sharing the same `updatedAt`.
 * `n` is clamped to be non-negative; when `n` is at least the input length the
 * result is a full sorted permutation of the input.
 */
export function recentlyChanged(subs: SubscriptionV2[], n: number): SubscriptionV2[] {
  const sorted = [...subs].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  return sorted.slice(0, Math.max(0, n));
}

// --- Category distribution (Req 11.2) ----------------------------------------

/**
 * Group monthly spend by category (Req 11.2). Returns one entry per distinct
 * category present in `active`, each with the summed normalized monthly amount
 * of that category's subscriptions.
 *
 * Entries appear in first-appearance order of their category within `active`
 * (deterministic and order-faithful). The grouping conserves total spend: the
 * sum of all entries' `monthly` equals {@link totalMonthly} of `active`, and
 * every subscription is keyed under exactly its own category. Callers pass the
 * already-active subscriptions.
 */
export function categoryDistribution(
  active: SubscriptionV2[],
): { category: string; monthly: number }[] {
  const order: string[] = [];
  const totals = new Map<string, number>();

  for (const s of active) {
    const current = totals.get(s.category);
    if (current === undefined) {
      order.push(s.category);
      totals.set(s.category, monthlyAmount(s));
    } else {
      totals.set(s.category, current + monthlyAmount(s));
    }
  }

  return order.map((category) => ({ category, monthly: totals.get(category)! }));
}

// --- Most expensive (Req 11.4) -----------------------------------------------

/**
 * Return the `n` most expensive subscriptions, ordered by normalized monthly
 * amount descending (Req 11.4).
 *
 * Sorting is performed on a copy (the input is never mutated); the stable sort
 * preserves the relative order of subscriptions sharing the same monthly
 * amount. `n` is clamped to be non-negative; when `n` is at least the input
 * length the result is a full sorted permutation of the input.
 */
export function topByMonthly(active: SubscriptionV2[], n: number): SubscriptionV2[] {
  const sorted = [...active].sort((a, b) => monthlyAmount(b) - monthlyAmount(a));
  return sorted.slice(0, Math.max(0, n));
}

// --- Renewal timeline (Req 11.5) ---------------------------------------------

/**
 * Build a timeline of upcoming renewals grouped by date (Req 11.5). Only
 * subscriptions whose `nextRenewal` is on or after `today` are included.
 *
 * The result is ordered by date ascending; within each date group the
 * subscriptions preserve their relative input order. The grouping is a faithful
 * partition of the upcoming subscriptions: every upcoming subscription appears
 * in exactly one group, keyed under its own `nextRenewal`. The input is never
 * mutated.
 */
export function renewalTimeline(
  subs: SubscriptionV2[],
  today: ISODate,
): { date: ISODate; subs: SubscriptionV2[] }[] {
  const order: ISODate[] = [];
  const groups = new Map<ISODate, SubscriptionV2[]>();

  for (const s of subs) {
    if (s.nextRenewal < today) continue; // upcoming only
    const bucket = groups.get(s.nextRenewal);
    if (bucket === undefined) {
      order.push(s.nextRenewal);
      groups.set(s.nextRenewal, [s]);
    } else {
      bucket.push(s);
    }
  }

  // Order dates ascending (lexicographic === chronological for YYYY-MM-DD).
  order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return order.map((date) => ({ date, subs: groups.get(date)! }));
}
