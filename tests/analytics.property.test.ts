import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  totalMonthly,
  totalYearly,
  activeCount,
  recentlyChanged,
  categoryDistribution,
  topByMonthly,
  renewalTimeline,
} from "core/analytics";
import { monthlyAmount } from "core/billing";
import { activeSpendSubscriptionsV2 } from "core/subscriptionsV2";
import type { SubscriptionV2 } from "core/models/subscription";

/**
 * Property-based tests for analytics aggregations (task 3.4).
 *
 * Property 4:  Active totals and active count use only active subscriptions
 *              — Validates: Requirements 8.1, 8.2, 8.3
 * Property 12: Derived orderings are sorted permutations
 *              — Validates: Requirements 8.5, 9.3, 11.4, 11.5
 * Property 14: Partitions conserve and correctly key all subscriptions
 *              — Validates: Requirements 9.5, 11.2, 10.1, 10.2
 *
 * Each `fc.assert` runs at least 100 iterations.
 *
 * Floating-point note: monthly normalization (Weekly = amount*52/12, etc.)
 * produces non-terminating decimals, and grouping/summing reassociates the
 * additions. Conservation checks therefore use `toBeCloseTo`.
 */

const NUM_RUNS = 200;

// --- Generators --------------------------------------------------------------

/** A YYYY-MM-DD date in a narrow window so renewals collide on dates. */
const isoDateArb = fc
  .record({
    year: fc.constantFrom(2024, 2025),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
        day,
      ).padStart(2, "0")}`,
  );

/** An ISO datetime string with limited granularity so ties on updatedAt occur. */
const isoDateTimeArb = fc
  .record({
    year: fc.constantFrom(2024, 2025),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
        day,
      ).padStart(2, "0")}T00:00:00.000Z`,
  );

/** A small category alphabet so grouping has frequent collisions. */
const categoryArb = fc.constantFrom(
  "AI",
  "Music",
  "Gaming",
  "Streaming",
  "Utilities",
);

/** Non-negative, finite amount kept modest to bound floating-point error. */
const amountArb = fc.double({
  min: 0,
  max: 100_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A billing cycle, including Custom with a valid positive interval. */
const billingArb: fc.Arbitrary<
  Pick<SubscriptionV2, "billingCycle" | "customInterval">
> = fc.oneof(
  fc
    .constantFrom("Weekly", "Monthly", "Quarterly", "Half-Yearly", "Yearly")
    .map((billingCycle) => ({
      billingCycle: billingCycle as SubscriptionV2["billingCycle"],
      customInterval: undefined,
    })),
  fc
    .record({
      unit: fc.constantFrom("day", "week", "month", "year"),
      count: fc.integer({ min: 1, max: 36 }),
    })
    .map((customInterval) => ({
      billingCycle: "Custom" as const,
      customInterval: customInterval as SubscriptionV2["customInterval"],
    })),
);

/** A subscription without an id (id is assigned by `withIds` for uniqueness). */
const subFieldsArb = fc
  .record({
    name: fc.string(),
    provider: fc.string(),
    category: categoryArb,
    amountMinor: amountArb,
    billing: billingArb,
    nextRenewal: isoDateArb,
    startDate: isoDateArb,
    active: fc.boolean(),
    autoRenew: fc.boolean(),
    updatedAt: isoDateTimeArb,
  })
  .map((r) => ({
    name: r.name,
    provider: r.provider,
    category: r.category,
    amountMinor: r.amountMinor,
    currency: "INR",
    billingCycle: r.billing.billingCycle,
    customInterval: r.billing.customInterval,
    nextRenewal: r.nextRenewal,
    startDate: r.startDate,
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "box",
    state: (r.active ? "Active" : "Paused") as SubscriptionV2["state"],
    priceHistory: [],
    tags: [],
    autoRenew: r.autoRenew,
    createdAt: r.updatedAt,
    updatedAt: r.updatedAt,
  }));

/** Assign unique ids by index so multiset/permutation checks are exact. */
function withIds(fields: Omit<SubscriptionV2, "id">[], prefix = "s"): SubscriptionV2[] {
  return fields.map((f, i) => ({ ...f, id: `${prefix}-${i}` }));
}

const subsArb = fc
  .array(subFieldsArb, { maxLength: 12 })
  .map((fields) => withIds(fields));

/** Tolerance-aware closeness used for spend conservation checks. */
function expectClose(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 6);
}

// =============================================================================
// Property 4: Active totals and active count use only active subscriptions
// Validates: Requirements 8.1, 8.2, 8.3
// =============================================================================

describe("Feature: subby, Property 4: Active totals and active count use only active subscriptions", () => {
  it("Feature: subby, Property 4: adding inactive subscriptions does not change the active totals, and activeCount equals the number of active subs (Req 8.1, 8.2, 8.3)", () => {
    // Generate a base list plus a list forced inactive; appending the latter
    // must not move totalMonthly/totalYearly computed over active subs.
    const extraInactiveArb = fc
      .array(subFieldsArb, { maxLength: 8 })
      .map((fields) =>
        withIds(
          fields.map((f) => ({ ...f, state: "Paused" as const })),
          "x",
        ),
      );

    fc.assert(
      fc.property(subsArb, extraInactiveArb, (base, extraInactive) => {
        const baseActive = activeSpendSubscriptionsV2(base);

        // Totals over the active subset (the form the dashboard consumes).
        const baseMonthly = totalMonthly(baseActive);
        const baseYearly = totalYearly(baseActive);

        // Appending inactive subscriptions leaves the active set unchanged.
        const withInactive = [...base, ...extraInactive];
        const withInactiveActive = activeSpendSubscriptionsV2(withInactive);

        expectClose(totalMonthly(withInactiveActive), baseMonthly);
        expectClose(totalYearly(withInactiveActive), baseYearly);

        // activeCount over the FULL set counts exactly the live subs (Req 8.3).
        // The generator produces only Active/Paused (no Trial), so the live
        // count equals the number of Active subs.
        const manualCount = base.filter((s) => s.state === "Active").length;
        expect(activeCount(base)).toBe(manualCount);
        // The appended inactive subs never inflate the count.
        expect(activeCount(withInactive)).toBe(manualCount);

        // Active totals ignore inactive members: totalMonthly over the active
        // subset equals totalMonthly over the full set's active members, and is
        // independent of any inactive subscription's amount.
        expectClose(baseYearly, baseMonthly * 12);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Property 12: Derived orderings are sorted permutations
// Validates: Requirements 8.5, 9.3, 11.4, 11.5
// =============================================================================

/**
 * Assert that `result` is a sorted (non-increasing by `key`) prefix-permutation
 * of `input`: it has the clamped length, is a sub-multiset of the input with no
 * added/duplicated elements, is sorted by the key descending, and is a genuine
 * top-n (no excluded element outranks an included one).
 */
function assertTopNDescending(
  input: SubscriptionV2[],
  result: SubscriptionV2[],
  n: number,
  key: (s: SubscriptionV2) => number | string,
): void {
  const expectedLength = Math.min(Math.max(0, n), input.length);
  expect(result).toHaveLength(expectedLength);

  // Sub-multiset: every result id is a distinct id drawn from the input.
  const inputIds = new Set(input.map((s) => s.id));
  const resultIds = result.map((s) => s.id);
  expect(new Set(resultIds).size).toBe(resultIds.length); // no duplicates
  for (const id of resultIds) expect(inputIds.has(id)).toBe(true); // no extras

  // Sorted non-increasing by key.
  for (let i = 1; i < result.length; i++) {
    expect(key(result[i - 1]) >= key(result[i])).toBe(true);
  }

  // Genuine top-n: no excluded element has a key strictly greater than the
  // smallest included key (otherwise the result would not be a sorted prefix).
  if (result.length > 0 && result.length < input.length) {
    const minIncluded = key(result[result.length - 1]);
    const includedIds = new Set(resultIds);
    for (const s of input) {
      if (!includedIds.has(s.id)) {
        expect(key(s) <= minIncluded).toBe(true);
      }
    }
  }
}

describe("Feature: subby, Property 12: Derived orderings are sorted permutations", () => {
  it("Feature: subby, Property 12: recentlyChanged is a top-n prefix sorted by updatedAt descending (Req 8.5, 9.3)", () => {
    fc.assert(
      fc.property(subsArb, fc.integer({ min: -2, max: 15 }), (subs, n) => {
        const result = recentlyChanged(subs, n);
        assertTopNDescending(subs, result, n, (s) => s.updatedAt);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 12: topByMonthly is a top-n prefix sorted by monthly amount descending (Req 11.4)", () => {
    fc.assert(
      fc.property(subsArb, fc.integer({ min: -2, max: 15 }), (subs, n) => {
        const result = topByMonthly(subs, n);
        assertTopNDescending(subs, result, n, (s) => monthlyAmount(s));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 12: renewalTimeline groups are ordered by date ascending (Req 11.5)", () => {
    fc.assert(
      fc.property(subsArb, isoDateArb, (subs, today) => {
        const timeline = renewalTimeline(subs, today);
        const dates = timeline.map((g) => g.date);
        // Dates strictly increasing (distinct group keys, chronological order).
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i - 1] < dates[i]).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Property 14: Partitions conserve and correctly key all subscriptions
// Validates: Requirements 9.5, 11.2, 10.1, 10.2
// =============================================================================

describe("Feature: subby, Property 14: Partitions conserve and correctly key all subscriptions", () => {
  it("Feature: subby, Property 14: categoryDistribution conserves total monthly spend and keys each subscription under its own category (Req 11.2, 9.5)", () => {
    fc.assert(
      fc.property(subsArb, (subs) => {
        const active = activeSpendSubscriptionsV2(subs);
        const dist = categoryDistribution(active);

        // Conservation: the sum of group spend equals the active total.
        const grouped = dist.reduce((acc, e) => acc + e.monthly, 0);
        expectClose(grouped, totalMonthly(active));

        // Keys are exactly the distinct categories of the active subs.
        const distCategories = dist.map((e) => e.category);
        expect(new Set(distCategories).size).toBe(distCategories.length); // no dup keys
        const expectedCategories = new Set(active.map((s) => s.category));
        expect(new Set(distCategories)).toEqual(expectedCategories);

        // Each group's monthly equals the sum over active subs in that category:
        // every subscription is keyed under its own category, none elsewhere.
        for (const entry of dist) {
          const expected = active
            .filter((s) => s.category === entry.category)
            .reduce((acc, s) => acc + monthlyAmount(s), 0);
          expectClose(entry.monthly, expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 14: renewalTimeline partitions upcoming subscriptions, each appearing once keyed under its own nextRenewal (Req 11.5, 10.1, 10.2)", () => {
    fc.assert(
      fc.property(subsArb, isoDateArb, (subs, today) => {
        const timeline = renewalTimeline(subs, today);

        // The upcoming subset: nextRenewal on or after today.
        const upcoming = subs.filter((s) => s.nextRenewal >= today);
        const upcomingIds = upcoming.map((s) => s.id).sort();

        // Every grouped subscription is keyed under its own nextRenewal.
        for (const group of timeline) {
          for (const s of group.subs) {
            expect(s.nextRenewal).toBe(group.date);
          }
        }

        // Partition: each upcoming sub appears exactly once across all groups,
        // and nothing else (past renewals excluded) is present.
        const flatIds = timeline.flatMap((g) => g.subs.map((s) => s.id));
        expect(new Set(flatIds).size).toBe(flatIds.length); // no duplicates
        expect([...flatIds].sort()).toEqual(upcomingIds); // exactly the upcoming set
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
