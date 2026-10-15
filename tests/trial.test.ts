import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { conversionDate, convertTrial, trialsConvertFigure } from "core/trial";
import { addDays } from "core/renewal";
import { monthlyAmount } from "core/billing";
import { trialSchema, subscriptionV2Schema } from "core/models/schema";
import type {
  BillingCycle,
  SubscriptionV2,
  TrialV2,
} from "core/models/subscription";

/**
 * Trial tracking and conversion (Story 5.1).
 *
 * Property + example tests for the three pure helpers in `core/trial.ts`:
 *   - `conversionDate` is total over the valid {@link TrialV2} union and agrees
 *     with the explicit end date / start + N days (via the shared `addDays`).
 *   - `trialsConvertFigure` sums ONLY the Trial subset's normalized post-trial
 *     monthly amounts (native-minor, no FX) and counts the trials.
 *   - `convertTrial` flips Trial→Active, applies `postAmountMinor`, drops the
 *     embedded `trial`, preserves every other field, never mutates the input,
 *     and is a no-op for a non-Trial subscription.
 *
 * Each `fc.assert` runs at least 100 iterations.
 */

const NUM_RUNS = 200;

// --- Fixture builders --------------------------------------------------------

/** A canonical valid v2 subscription; overrides tailor state/cycle/trial. */
function makeSub(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMinor: 49900,
    currency: "USD",
    billingCycle: "Monthly",
    nextRenewal: "2026-02-01",
    startDate: "2026-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#e50914",
    icon: "netflix",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A Trial subscription carrying the given embedded trial. */
function makeTrialSub(
  trial: TrialV2,
  overrides: Partial<SubscriptionV2> = {},
): SubscriptionV2 {
  return makeSub({ state: "Trial", trial, ...overrides });
}

// --- Arbitraries -------------------------------------------------------------

/** ISO `YYYY-MM-DD` dates in a stable range (avoids pre-epoch / far-future edges). */
const isoDateArb = fc
  .date({ min: new Date("2000-01-01"), max: new Date("2100-12-31") })
  .map((d) => d.toISOString().slice(0, 10));

/** Non-negative integer minor units. */
const minorArb = fc.integer({ min: 0, max: 10_000_000 });

/** A positive whole number of trial days. */
const lengthDaysArb = fc.integer({ min: 1, max: 3650 });

const BILLING_CYCLES: readonly BillingCycle[] = [
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
];

/** An endDate-variant TrialV2 (optional startDate on/before endDate). */
const endDateTrialArb: fc.Arbitrary<TrialV2> = fc.record({
  endDate: isoDateArb,
  postAmountMinor: minorArb,
});

/** A startDate+lengthDays-variant TrialV2. */
const startDaysTrialArb: fc.Arbitrary<TrialV2> = fc.record({
  startDate: isoDateArb,
  lengthDays: lengthDaysArb,
  postAmountMinor: minorArb,
});

/** Either trial variant. */
const anyTrialArb: fc.Arbitrary<TrialV2> = fc.oneof(
  endDateTrialArb,
  startDaysTrialArb,
);

// =============================================================================
// conversionDate
// =============================================================================

describe("conversionDate (Story 5.1)", () => {
  it("returns the explicit endDate for the end-date variant (example)", () => {
    expect(
      conversionDate({ endDate: "2026-12-31", postAmountMinor: 1000 }),
    ).toBe("2026-12-31");
  });

  it("returns addDays(startDate, lengthDays) for the start+days variant (example)", () => {
    expect(
      conversionDate({
        startDate: "2026-12-01",
        lengthDays: 14,
        postAmountMinor: 1000,
      }),
    ).toBe(addDays("2026-12-01", 14)); // "2026-12-15"
    expect(
      conversionDate({
        startDate: "2026-12-01",
        lengthDays: 14,
        postAmountMinor: 1000,
      }),
    ).toBe("2026-12-15");
  });

  it("is total over the valid TrialV2 union and agrees with the variant (property)", () => {
    fc.assert(
      fc.property(anyTrialArb, (trial) => {
        const result = conversionDate(trial);
        // Always a well-formed ISO date.
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (trial.endDate !== undefined) {
          expect(result).toBe(trial.endDate);
        } else {
          expect(result).toBe(addDays(trial.startDate, trial.lengthDays));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// trialsConvertFigure
// =============================================================================

describe("trialsConvertFigure (Story 5.1)", () => {
  it("sums only Trials' post-amount monthly, ignoring Active/Paused (mixed example)", () => {
    // Monthly post $10 (1000 minor) + Yearly post $120 (12000 minor) → 1000 +
    // 12000/12 = 2000 minor worth of monthly ($20). One Active + one Paused
    // (ignored) sit alongside.
    const subs: SubscriptionV2[] = [
      makeTrialSub(
        { endDate: "2026-12-31", postAmountMinor: 1000 },
        { id: "t1", billingCycle: "Monthly" },
      ),
      makeTrialSub(
        { endDate: "2026-12-31", postAmountMinor: 12000 },
        { id: "t2", billingCycle: "Yearly" },
      ),
      makeSub({ id: "a1", state: "Active", amountMinor: 99999 }),
      makeSub({ id: "p1", state: "Paused", amountMinor: 88888 }),
    ];
    expect(trialsConvertFigure(subs)).toEqual({ monthlyMinor: 2000, count: 2 });
  });

  it("returns {monthlyMinor:0, count:0} when there are no trials", () => {
    const subs = [
      makeSub({ id: "a1", state: "Active" }),
      makeSub({ id: "p1", state: "Paused" }),
    ];
    expect(trialsConvertFigure(subs)).toEqual({ monthlyMinor: 0, count: 0 });
    expect(trialsConvertFigure([])).toEqual({ monthlyMinor: 0, count: 0 });
  });

  it("count equals the number of Trials and the sum matches monthlyAmount over post amounts (property)", () => {
    const subArb = fc.record({
      state: fc.constantFrom("Active", "Paused", "Trial"),
      billingCycle: fc.constantFrom(...BILLING_CYCLES),
      postAmountMinor: minorArb,
      amountMinor: minorArb,
    });
    fc.assert(
      fc.property(fc.array(subArb, { maxLength: 20 }), (specs) => {
        const subs: SubscriptionV2[] = specs.map((s, i) =>
          s.state === "Trial"
            ? makeTrialSub(
                { endDate: "2026-12-31", postAmountMinor: s.postAmountMinor },
                {
                  id: `s-${i}`,
                  billingCycle: s.billingCycle as BillingCycle,
                },
              )
            : makeSub({
                id: `s-${i}`,
                state: s.state as SubscriptionV2["state"],
                billingCycle: s.billingCycle as BillingCycle,
                amountMinor: s.amountMinor,
              }),
        );

        const figure = trialsConvertFigure(subs);
        const trials = specs.filter((s) => s.state === "Trial");

        // Count is exactly the number of Trials.
        expect(figure.count).toBe(trials.length);

        // The sum equals monthlyAmount over each trial's POST amount + cycle.
        const expected = subs
          .filter((s) => s.state === "Trial")
          .reduce(
            (acc, s) =>
              acc +
              monthlyAmount({
                amountMinor: s.trial!.postAmountMinor,
                billingCycle: s.billingCycle,
                customInterval: s.customInterval,
              }),
            0,
          );
        expect(figure.monthlyMinor).toBeCloseTo(expected, 9);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// convertTrial
// =============================================================================

describe("convertTrial (Story 5.1)", () => {
  it("Trial→Active applies the post amount, drops the trial, preserves other fields (example)", () => {
    const original = makeTrialSub(
      { endDate: "2026-12-31", postAmountMinor: 2000 },
      { id: "t1", amountMinor: 0, name: "Notion", category: "Productivity" },
    );
    const converted = convertTrial(original);

    expect(converted.state).toBe("Active");
    expect(converted.amountMinor).toBe(2000);
    expect(converted).not.toHaveProperty("trial");
    // Every other field is intact.
    expect(converted.id).toBe("t1");
    expect(converted.name).toBe("Notion");
    expect(converted.category).toBe("Productivity");
    expect(converted.currency).toBe(original.currency);
    expect(converted.billingCycle).toBe(original.billingCycle);
  });

  it("returns a non-Trial subscription UNCHANGED (same reference, no throw)", () => {
    const active = makeSub({ state: "Active" });
    expect(convertTrial(active)).toBe(active);
    const paused = makeSub({ state: "Paused" });
    expect(convertTrial(paused)).toBe(paused);
  });

  it("never mutates its input and yields a schema-valid Active sub (property)", () => {
    fc.assert(
      fc.property(anyTrialArb, (trial) => {
        const original = makeTrialSub(trial, { id: "t", amountMinor: 123 });
        const snapshot = structuredClone(original);

        const converted = convertTrial(original);

        // Input untouched.
        expect(original).toEqual(snapshot);
        expect(original.state).toBe("Trial");
        expect(original.trial).toEqual(snapshot.trial);

        // Output is a converted Active sub with no trial.
        expect(converted).not.toBe(original);
        expect(converted.state).toBe("Active");
        expect(converted.amountMinor).toBe(trial.postAmountMinor);
        expect("trial" in converted).toBe(false);

        // The converted sub validates against the v2 schema (trial-iff-Trial
        // invariant holds — no trial on an Active sub).
        const parsed = subscriptionV2Schema.safeParse(converted);
        expect(parsed.success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Variant arbitraries produce schema-valid trials (guards the test fixtures)
// =============================================================================

describe("trial fixture validity", () => {
  it("both trial-variant arbitraries satisfy trialSchema (property)", () => {
    fc.assert(
      fc.property(anyTrialArb, (trial) => {
        expect(trialSchema.safeParse(trial).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
