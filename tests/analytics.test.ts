import { describe, it, expect } from "vitest";

import {
  totalMonthly,
  totalYearly,
  activeCount,
  renewingWithin,
  recentlyChanged,
  categoryDistribution,
  topByMonthly,
  renewalTimeline,
} from "core/analytics";
import { activeSpendSubscriptionsV2 } from "core/subscriptionsV2";
import type { SubscriptionV2 } from "core/models/subscription";

/**
 * Unit tests for analytics aggregations and orderings
 * (Req 8.1–8.5, 11.1–11.5). These are example/edge-case tests; the universal
 * properties are covered by the property tests in task 3.4.
 */

// --- Fixtures ----------------------------------------------------------------

function sub(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: overrides.id ?? `sub-${Math.random()}`,
    name: "Service",
    provider: "Provider",
    category: "Entertainment",
    amountMinor: 100,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-01-01",
    startDate: "2024-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "box",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// --- Totals and counts (Req 8.1, 8.2, 8.3, 11.1, 11.3) -----------------------

describe("totalMonthly (Req 8.1, 11.1)", () => {
  it("sums normalized monthly amounts directly", () => {
    const active = [
      sub({ amountMinor: 100, billingCycle: "Monthly" }), // 100
      sub({ amountMinor: 1200, billingCycle: "Yearly" }), // 100
      sub({ amountMinor: 300, billingCycle: "Quarterly" }), // 100
    ];
    expect(totalMonthly(active)).toBeCloseTo(300);
  });

  it("is zero for an empty list", () => {
    expect(totalMonthly([])).toBe(0);
  });
});

describe("totalYearly (Req 8.2, 11.3)", () => {
  it("sums yearly amounts (monthly * 12)", () => {
    const active = [
      sub({ amountMinor: 100, billingCycle: "Monthly" }), // 1200/yr
      sub({ amountMinor: 1200, billingCycle: "Yearly" }), // 1200/yr
    ];
    expect(totalYearly(active)).toBeCloseTo(2400);
  });

  it("equals totalMonthly * 12", () => {
    const active = [
      sub({ amountMinor: 50, billingCycle: "Monthly" }),
      sub({ amountMinor: 130, billingCycle: "Weekly" }),
    ];
    expect(totalYearly(active)).toBeCloseTo(totalMonthly(active) * 12);
  });
});

describe("activeCount (Req 8.3)", () => {
  it("counts only active subscriptions within the full set", () => {
    const subs = [
      sub({ state: "Active" }),
      sub({ state: "Paused" }),
      sub({ state: "Active" }),
    ];
    expect(activeCount(subs)).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(activeCount([])).toBe(0);
  });

  it("counts Active + Trial while spend sums Active-only; Paused excluded from both (AD-17)", () => {
    // The I/O-matrix row: 2 Active + 1 Trial + 1 Paused.
    const subs = [
      sub({ id: "a1", state: "Active", amountMinor: 100, billingCycle: "Monthly" }),
      sub({ id: "a2", state: "Active", amountMinor: 300, billingCycle: "Monthly" }),
      sub({ id: "t", state: "Trial", amountMinor: 500, billingCycle: "Monthly" }),
      sub({ id: "p", state: "Paused", amountMinor: 900, billingCycle: "Monthly" }),
    ];

    // Active count = Active + Trial (= 3); Paused excluded.
    expect(activeCount(subs)).toBe(3);

    // Current monthly spend sums the Active-only subset (Trial surfaced
    // separately = $0 current spend; Paused excluded from both).
    const spend = activeSpendSubscriptionsV2(subs);
    expect(spend.map((s) => s.id)).toEqual(["a1", "a2"]);
    expect(totalMonthly(spend)).toBeCloseTo(400); // 100 + 300, Trial/Paused excluded
  });
});

// --- renewingWithin (Req 8.4) ------------------------------------------------

describe("renewingWithin (Req 8.4)", () => {
  const today = "2025-01-10";
  const subs = [
    sub({ id: "today", nextRenewal: "2025-01-10" }),
    sub({ id: "in7", nextRenewal: "2025-01-17" }),
    sub({ id: "in8", nextRenewal: "2025-01-18" }),
    sub({ id: "past", nextRenewal: "2025-01-09" }),
  ];

  it("includes subscriptions within the inclusive [today, today+days] window", () => {
    const result = renewingWithin(subs, 7, today).map((s) => s.id);
    expect(result).toEqual(["today", "in7"]);
  });

  it("excludes renewals before today and after the window", () => {
    const result = renewingWithin(subs, 7, today).map((s) => s.id);
    expect(result).not.toContain("past");
    expect(result).not.toContain("in8");
  });

  it("preserves input order and does not mutate the input", () => {
    const input = [...subs];
    renewingWithin(input, 7, today);
    expect(input).toEqual(subs);
  });

  it("handles month boundaries via UTC date math", () => {
    const result = renewingWithin(
      [sub({ id: "feb", nextRenewal: "2025-02-02" })],
      5,
      "2025-01-29",
    ).map((s) => s.id);
    expect(result).toEqual(["feb"]); // 2025-01-29 + 5 days = 2025-02-03
  });
});

// --- recentlyChanged (Req 8.5) -----------------------------------------------

describe("recentlyChanged (Req 8.5)", () => {
  it("returns the top n ordered by updatedAt descending", () => {
    const subs = [
      sub({ id: "a", updatedAt: "2024-01-01T00:00:00.000Z" }),
      sub({ id: "b", updatedAt: "2024-03-01T00:00:00.000Z" }),
      sub({ id: "c", updatedAt: "2024-02-01T00:00:00.000Z" }),
    ];
    expect(recentlyChanged(subs, 2).map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("is a sorted permutation when n covers the whole list", () => {
    const subs = [
      sub({ id: "a", updatedAt: "2024-01-01T00:00:00.000Z" }),
      sub({ id: "b", updatedAt: "2024-03-01T00:00:00.000Z" }),
    ];
    expect(recentlyChanged(subs, 10).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("clamps a non-positive n to an empty result and does not mutate input", () => {
    const subs = [sub({ id: "a" }), sub({ id: "b" })];
    const snapshot = [...subs];
    expect(recentlyChanged(subs, 0)).toEqual([]);
    expect(subs).toEqual(snapshot);
  });
});

// --- categoryDistribution (Req 11.2) -----------------------------------------

describe("categoryDistribution (Req 11.2)", () => {
  it("groups monthly spend by category in first-appearance order", () => {
    const active = [
      sub({ category: "AI", amountMinor: 100, billingCycle: "Monthly" }),
      sub({ category: "Music", amountMinor: 1200, billingCycle: "Yearly" }), // 100
      sub({ category: "AI", amountMinor: 300, billingCycle: "Quarterly" }), // 100
    ];
    expect(categoryDistribution(active)).toEqual([
      { category: "AI", monthly: 200 },
      { category: "Music", monthly: 100 },
    ]);
  });

  it("conserves total spend across all groups", () => {
    const active = [
      sub({ category: "AI", amountMinor: 100, billingCycle: "Monthly" }),
      sub({ category: "Music", amountMinor: 50, billingCycle: "Monthly" }),
      sub({ category: "Gaming", amountMinor: 130, billingCycle: "Weekly" }),
    ];
    const sum = categoryDistribution(active).reduce((acc, e) => acc + e.monthly, 0);
    expect(sum).toBeCloseTo(totalMonthly(active));
  });

  it("returns an empty array for no subscriptions", () => {
    expect(categoryDistribution([])).toEqual([]);
  });
});

// --- topByMonthly (Req 11.4) -------------------------------------------------

describe("topByMonthly (Req 11.4)", () => {
  it("orders by normalized monthly amount descending", () => {
    const active = [
      sub({ id: "cheap", amountMinor: 1200, billingCycle: "Yearly" }), // 100
      sub({ id: "mid", amountMinor: 200, billingCycle: "Monthly" }), // 200
      sub({ id: "dear", amountMinor: 900, billingCycle: "Quarterly" }), // 300
    ];
    expect(topByMonthly(active, 2).map((s) => s.id)).toEqual(["dear", "mid"]);
  });

  it("preserves input order for ties (stable) and does not mutate input", () => {
    const active = [
      sub({ id: "x", amountMinor: 100, billingCycle: "Monthly" }),
      sub({ id: "y", amountMinor: 100, billingCycle: "Monthly" }),
    ];
    const snapshot = [...active];
    expect(topByMonthly(active, 5).map((s) => s.id)).toEqual(["x", "y"]);
    expect(active).toEqual(snapshot);
  });
});

// --- renewalTimeline (Req 11.5) ----------------------------------------------

describe("renewalTimeline (Req 11.5)", () => {
  const today = "2025-01-10";

  it("groups upcoming renewals by date ordered ascending", () => {
    const subs = [
      sub({ id: "b", nextRenewal: "2025-01-20" }),
      sub({ id: "a1", nextRenewal: "2025-01-15" }),
      sub({ id: "a2", nextRenewal: "2025-01-15" }),
    ];
    const timeline = renewalTimeline(subs, today);
    expect(timeline.map((g) => g.date)).toEqual(["2025-01-15", "2025-01-20"]);
    expect(timeline[0].subs.map((s) => s.id)).toEqual(["a1", "a2"]); // preserves input order
    expect(timeline[1].subs.map((s) => s.id)).toEqual(["b"]);
  });

  it("excludes renewals before today", () => {
    const subs = [
      sub({ id: "past", nextRenewal: "2025-01-09" }),
      sub({ id: "today", nextRenewal: "2025-01-10" }),
    ];
    const timeline = renewalTimeline(subs, today);
    expect(timeline.map((g) => g.date)).toEqual(["2025-01-10"]);
  });

  it("partitions conserve all upcoming subscriptions exactly once", () => {
    const subs = [
      sub({ id: "a", nextRenewal: "2025-01-15" }),
      sub({ id: "b", nextRenewal: "2025-01-20" }),
      sub({ id: "c", nextRenewal: "2025-01-15" }),
      sub({ id: "past", nextRenewal: "2025-01-01" }),
    ];
    const ids = renewalTimeline(subs, today).flatMap((g) => g.subs.map((s) => s.id));
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const subs = [sub({ id: "a", nextRenewal: "2025-01-15" })];
    const snapshot = [...subs];
    renewalTimeline(subs, today);
    expect(subs).toEqual(snapshot);
  });
});
