import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { dueLeadTimes } from "core/notify";
import type { ISODate } from "core/renewal";
import type { Subscription } from "core/models/subscription";
import type { ReminderLeadTime } from "core/models/settings";

/**
 * Property 17: Due lead times are exactly the enabled ones whose target date is today.
 * Validates: Requirements 13.1, 13.5
 *
 * Req 13.1 — for each enabled reminder lead time (same-day / one-day / three-days),
 *            a notification is due when the configured lead time targets today
 *            relative to `nextRenewal`.
 * Req 13.5 — only the currently-enabled lead times are considered, so updated
 *            notification timing applies to subsequent evaluations.
 *
 * For an arbitrary subscription, an arbitrary `today`, and an arbitrary subset of
 * enabled lead times, `dueLeadTimes` returns EXACTLY the lead times that are both
 *   (a) in the enabled set, AND
 *   (b) whose target date (`today + offset(leadTime)`) equals `sub.nextRenewal`.
 *
 * The `offsetDays` generator constructs `nextRenewal = today + offsetDays`, drawing
 * `offsetDays` from {0, 1, 3} (the qualifying offsets) and other values (negative,
 * 2, 4, 5, 7, ...) so both the inclusion and the exclusion branches are exercised.
 */

const NUM_RUNS = 300;

// --- Reference date math (independent of the implementation) ----------------

/** Adds a whole number of days to an `YYYY-MM-DD` date using UTC arithmetic. */
function addDays(date: ISODate, days: number): ISODate {
  const [year, month, day] = date.split("-").map((p) => Number.parseInt(p, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  const yyyy = String(utc.getUTCFullYear()).padStart(4, "0");
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Days before `nextRenewal` that each lead time targets (per the spec). */
const OFFSET_BY_LEAD_TIME: Record<ReminderLeadTime, number> = {
  "same-day": 0,
  "one-day": 1,
  "three-days": 3,
};

const ALL_LEAD_TIMES: readonly ReminderLeadTime[] = ["same-day", "one-day", "three-days"];

// --- Generators --------------------------------------------------------------

/** A valid YYYY-MM-DD calendar date (day capped at 28 to stay month-agnostic). */
const isoDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
        day,
      ).padStart(2, "0")}`,
  );

const leadTimeArb = fc.constantFrom<ReminderLeadTime>("same-day", "one-day", "three-days");

/** An arbitrary subset (possibly empty) of the three lead times. */
const enabledArb = fc.uniqueArray(leadTimeArb, { maxLength: 3 });

/**
 * Offset (in days) used to place `nextRenewal` relative to `today`. Biased toward
 * the three qualifying offsets {0, 1, 3} but also drawing nearby and far values
 * (including negatives) so exclusion is heavily exercised.
 */
const offsetDaysArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 3) },
  { weight: 2, arbitrary: fc.integer({ min: -5, max: 10 }) },
);

/**
 * A full, type-valid subscription. Only `nextRenewal` matters to `dueLeadTimes`,
 * but a complete object keeps the test honest against the real type. `nextRenewal`
 * is derived from `today + offsetDays` by the caller below.
 */
function makeSubscription(nextRenewal: ISODate): Subscription {
  return {
    id: "sub-1",
    name: "Test",
    provider: "Provider",
    category: "Streaming",
    amount: 100,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal,
    startDate: "2020-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "tv",
    isActive: true,
    autoRenew: true,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

describe("Feature: subby, Property 17: Due lead times are exactly the enabled ones whose target date is today", () => {
  it("Feature: subby, Property 17: returns exactly the enabled lead times due today, ordered and de-duplicated (Req 13.1, 13.5)", () => {
    fc.assert(
      fc.property(isoDateArb, offsetDaysArb, enabledArb, (today, offsetDays, enabled) => {
        const nextRenewal = addDays(today, offsetDays);
        const sub = makeSubscription(nextRenewal);
        const enabledSet = new Set(enabled);

        const result = dueLeadTimes(sub, today, enabled);

        // Independent reference: a lead time is due iff it is enabled AND its
        // target date (today + offset) equals nextRenewal. In canonical order.
        const expected = ALL_LEAD_TIMES.filter(
          (lt) =>
            enabledSet.has(lt) &&
            addDays(today, OFFSET_BY_LEAD_TIME[lt]) === sub.nextRenewal,
        );

        // EXACT match (set + canonical ordering).
        expect(result).toEqual(expected);

        // Only enabled lead times are ever returned (Req 13.5).
        for (const lt of result) {
          expect(enabledSet.has(lt)).toBe(true);
        }

        // A lead time is returned iff nextRenewal == today + offset(leadTime).
        for (const lt of ALL_LEAD_TIMES) {
          const due = sub.nextRenewal === addDays(today, OFFSET_BY_LEAD_TIME[lt]);
          const shouldBeReturned = enabledSet.has(lt) && due;
          expect(result.includes(lt)).toBe(shouldBeReturned);
        }

        // No duplicates in the result.
        expect(new Set(result).size).toBe(result.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 17: disabled lead times are never returned even when their date is due (Req 13.5)", () => {
    // Force nextRenewal to be exactly due for `target`, then only enable the
    // OTHER lead times: the due one must be excluded purely because it is disabled.
    fc.assert(
      fc.property(isoDateArb, leadTimeArb, (today, target) => {
        const nextRenewal = addDays(today, OFFSET_BY_LEAD_TIME[target]);
        const sub = makeSubscription(nextRenewal);
        const enabledWithoutTarget = ALL_LEAD_TIMES.filter((lt) => lt !== target);

        const result = dueLeadTimes(sub, today, enabledWithoutTarget);

        expect(result.includes(target)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
