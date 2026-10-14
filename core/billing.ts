/**
 * Billing normalization (Req 5.1, 5.2, 5.5, 6.1).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * Amounts are integer **minor units** in a subscription's own (Native) currency
 * (AD-10). For a single-currency portfolio these are summed directly with no
 * conversion — honest for Story 3.3, which has no FX-snapshot host in the UI
 * yet; the full convert-before-sum Home total is Epic 6 (`core/money.homeTotal`).
 * The normalized monthly/yearly figures are kept as `number` (minor units,
 * possibly fractional after a sub-monthly division) and rounded only at display.
 */

import type { CustomInterval, SubscriptionV2 } from "./models/subscription";

/**
 * Average number of days in a month used to convert sub-month and
 * super-month custom intervals into a normalized month count.
 *
 * 30 is chosen as a simple, consistent approximation so that:
 *   - a "day" interval contributes count/30 months,
 *   - a "week" interval contributes count*7/30 months,
 *   - a "month" interval contributes count months exactly,
 *   - a "year" interval contributes count*12 months exactly.
 *
 * Using a fixed constant keeps `monthlyAmount` pure and deterministic
 * (independent of any specific calendar date).
 */
const DAYS_PER_MONTH = 30;

/**
 * Convert a {@link CustomInterval} into an equivalent number of months.
 *
 * Conversion (consistent, calendar-independent):
 *   - day   -> count / 30
 *   - week  -> count * 7 / 30
 *   - month -> count
 *   - year  -> count * 12
 *
 * The result is the number of months that one custom billing period spans,
 * used as the divisor when normalizing a custom-cycle amount to monthly.
 */
export function monthsInCustomInterval(interval: CustomInterval): number {
  switch (interval.unit) {
    case "day":
      return interval.count / DAYS_PER_MONTH;
    case "week":
      return (interval.count * 7) / DAYS_PER_MONTH;
    case "month":
      return interval.count;
    case "year":
      return interval.count * 12;
  }
}

/**
 * Compute the normalized monthly amount (in minor units) of a subscription from
 * its `amountMinor` and billing cycle (Req 5.1, 5.2).
 *
 *   - Monthly     -> amountMinor
 *   - Yearly      -> amountMinor / 12
 *   - Half-Yearly -> amountMinor / 6
 *   - Quarterly   -> amountMinor / 3
 *   - Weekly      -> amountMinor * 52 / 12
 *   - Custom      -> amountMinor / monthsInCustomInterval(customInterval)
 */
export function monthlyAmount(
  s: Pick<SubscriptionV2, "amountMinor" | "billingCycle" | "customInterval">,
): number {
  switch (s.billingCycle) {
    case "Monthly":
      return s.amountMinor;
    case "Yearly":
      return s.amountMinor / 12;
    case "Half-Yearly":
      return s.amountMinor / 6;
    case "Quarterly":
      return s.amountMinor / 3;
    case "Weekly":
      return (s.amountMinor * 52) / 12;
    case "Custom":
      return s.amountMinor / monthsInCustomInterval(s.customInterval!);
  }
}

/**
 * Compute the normalized yearly amount (in minor units) of a subscription as the
 * monthly amount multiplied by twelve (Req 5.5).
 */
export function yearlyAmount(
  s: Pick<SubscriptionV2, "amountMinor" | "billingCycle" | "customInterval">,
): number {
  return monthlyAmount(s) * 12;
}

/**
 * Sum the normalized monthly amounts (minor units) of the given subscriptions
 * directly, with no currency conversion (Req 6.1).
 */
export function sumMonthly(subs: SubscriptionV2[]): number {
  return subs.reduce((acc, s) => acc + monthlyAmount(s), 0);
}
