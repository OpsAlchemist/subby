import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { subscriptionSchema } from "core/models/schema";

/**
 * Property 10: Invalid subscription input is rejected with the offending field.
 * Validates: Requirements 3.5, 3.6
 *
 * Req 3.5 — a missing or empty name is rejected with a validation issue that
 *           identifies the `name` field.
 * Req 3.6 — an amount that is not a non-negative number is rejected with a
 *           validation issue that identifies the `amount` field.
 *
 * The test also confirms the dual: well-formed input passes validation, so the
 * schema is not rejecting everything indiscriminately.
 */

const NUM_RUNS = 200;

// --- Generators --------------------------------------------------------------

/** A valid YYYY-MM-DD calendar date. */
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

/** A valid ISO datetime string (e.g. from `new Date().toISOString()`). */
const isoDateTimeArb = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2099-12-31T23:59:59.999Z"),
  })
  .map((d) => d.toISOString());

const nonCustomCycleArb = fc.constantFrom(
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
);

/** A non-negative, finite amount accepted by the schema (Req 3.6). */
const validAmountArb = fc.double({
  min: 0,
  max: 1_000_000_000,
  noNaN: true,
  noDefaultInfinity: true,
});

/**
 * A fully valid subscription object. Uses a non-Custom billing cycle so no
 * `customInterval` is required, isolating the name/amount fields under test.
 */
const validSubscriptionArb = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  provider: fc.string(),
  category: fc.string(),
  amount: validAmountArb,
  currency: fc.string(),
  billingCycle: nonCustomCycleArb,
  nextRenewal: isoDateArb,
  startDate: isoDateArb,
  paymentMethod: fc.string(),
  website: fc.string(),
  notes: fc.string(),
  color: fc.string(),
  icon: fc.string(),
  isActive: fc.boolean(),
  autoRenew: fc.boolean(),
  createdAt: isoDateTimeArb,
  updatedAt: isoDateTimeArb,
});

/** Returns true when at least one issue points at the given field. */
function hasIssueForField(
  issues: { path: (string | number)[] }[],
  field: string,
): boolean {
  return issues.some((issue) => issue.path[0] === field);
}

describe("Feature: subby, Property 10: Invalid subscription input is rejected with the offending field", () => {
  it("Feature: subby, Property 10: accepts well-formed subscription input (dual)", () => {
    fc.assert(
      fc.property(validSubscriptionArb, (sub) => {
        const result = subscriptionSchema.safeParse(sub);
        expect(result.success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 10: rejects empty or missing name with a name-field issue (Req 3.5)", () => {
    // `kind` chooses between an empty-string name and a missing name property.
    const invalidNameArb = fc
      .tuple(validSubscriptionArb, fc.constantFrom<"empty" | "missing">("empty", "missing"))
      .map(([sub, kind]) => {
        if (kind === "empty") {
          return { ...sub, name: "" };
        }
        const { name: _omitted, ...withoutName } = sub;
        return withoutName as typeof sub;
      });

    fc.assert(
      fc.property(invalidNameArb, (sub) => {
        const result = subscriptionSchema.safeParse(sub);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(hasIssueForField(result.error.issues, "name")).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 10: rejects negative or non-numeric amount with an amount-field issue (Req 3.6)", () => {
    // A negative finite number, or a value that is not a number at all.
    const badAmountArb = fc.oneof(
      fc.double({ min: -1_000_000_000, max: -Number.MIN_VALUE, noNaN: true, noDefaultInfinity: true }),
      fc.constant(Number.NaN),
      fc.string(),
      fc.constant(undefined),
      fc.constant(null),
      fc.boolean(),
    );

    const invalidAmountArb = fc
      .tuple(validSubscriptionArb, badAmountArb)
      .map(([sub, badAmount]) => ({ ...sub, amount: badAmount as unknown as number }));

    fc.assert(
      fc.property(invalidAmountArb, (sub) => {
        const result = subscriptionSchema.safeParse(sub);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(hasIssueForField(result.error.issues, "amount")).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
