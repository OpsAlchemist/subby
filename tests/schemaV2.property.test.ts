import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  subscriptionV2Schema,
  subscriptionsFileV2Schema,
  settingsV2Schema,
  settingsFileV2Schema,
  trialSchema,
} from "core/models/schema";

/**
 * Property 26: a malformed v2 record is rejected with a field-named issue.
 * Validates: AD-10, AD-17, AD-21, AD-22 (v2 shapes); zod is the single
 * runtime-validation source.
 *
 * The TS interface ↔ zod lockstep is enforced at compile time by
 * `_assertSchemaAlignment` in `core/models/schema.ts` (a divergence is a type
 * error, verified by `npm run typecheck`). This suite covers the runtime half:
 * a well-formed v2 record parses, and a malformed one is rejected with an issue
 * naming the offending field.
 */

const NUM_RUNS = 200;

// --- Generators --------------------------------------------------------------

const isoDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );

const isoDateTimeArb = fc
  .date({ min: new Date("2000-01-01T00:00:00.000Z"), max: new Date("2099-12-31T23:59:59.999Z") })
  .map((d) => d.toISOString());

const nonCustomCycleArb = fc.constantFrom("Weekly", "Monthly", "Quarterly", "Half-Yearly", "Yearly");

/** Integer minor units (non-negative). */
const minorUnitsArb = fc.integer({ min: 0, max: 1_000_000_000 });

const priceEntryArb = fc.record({
  amountMinor: minorUnitsArb,
  currency: fc.string({ minLength: 1 }),
  date: isoDateArb,
});

/** A valid Active/Paused v2 subscription (no trial). */
const nonTrialSubV2Arb = fc.record({
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  provider: fc.string(),
  category: fc.string(),
  amountMinor: minorUnitsArb,
  currency: fc.string({ minLength: 1 }),
  billingCycle: nonCustomCycleArb,
  nextRenewal: isoDateArb,
  startDate: isoDateArb,
  paymentMethod: fc.string(),
  website: fc.string(),
  notes: fc.string(),
  color: fc.string(),
  icon: fc.string(),
  state: fc.constantFrom("Active", "Paused"),
  priceHistory: fc.array(priceEntryArb, { maxLength: 5 }),
  tags: fc.array(fc.string(), { maxLength: 5 }),
  autoRenew: fc.boolean(),
  createdAt: isoDateTimeArb,
  updatedAt: isoDateTimeArb,
});

/** A valid trial (end-date form OR start+days form). */
const trialArb = fc.oneof(
  fc.record({ endDate: isoDateArb, postAmountMinor: minorUnitsArb }),
  // Both dates present: order them so startDate <= endDate (a valid trial).
  fc
    .record({ a: isoDateArb, b: isoDateArb, postAmountMinor: minorUnitsArb })
    .map(({ a, b, postAmountMinor }) => {
      const [startDate, endDate] = a <= b ? [a, b] : [b, a];
      return { startDate, endDate, postAmountMinor };
    }),
  fc.record({ startDate: isoDateArb, lengthDays: fc.integer({ min: 1, max: 365 }), postAmountMinor: minorUnitsArb }),
);

/** A valid Trial-state v2 subscription (embedded trial required). */
const trialSubV2Arb = fc
  .tuple(nonTrialSubV2Arb, trialArb)
  .map(([sub, trial]) => ({ ...sub, state: "Trial" as const, trial }));

const validSubV2Arb = fc.oneof(nonTrialSubV2Arb, trialSubV2Arb);

function hasIssueForField(issues: { path: (string | number)[] }[], field: string): boolean {
  return issues.some((issue) => issue.path[0] === field);
}

// --- Property 26 -------------------------------------------------------------

describe("Feature: subby, Property 26: a malformed v2 record is rejected with a field-named issue", () => {
  it("Feature: subby, Property 26: accepts well-formed v2 subscriptions (dual)", () => {
    fc.assert(
      fc.property(validSubV2Arb, (sub) => {
        expect(subscriptionV2Schema.safeParse(sub).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 26: rejects a non-integer amountMinor with an amountMinor issue (AD-10)", () => {
    const badArb = fc
      .tuple(nonTrialSubV2Arb, fc.oneof(fc.double({ min: 0.01, max: 100, noInteger: true }), fc.constant(-1), fc.constant(Number.NaN)))
      .map(([sub, bad]) => ({ ...sub, amountMinor: bad as unknown as number }));

    fc.assert(
      fc.property(badArb, (sub) => {
        const result = subscriptionV2Schema.safeParse(sub);
        expect(result.success).toBe(false);
        if (!result.success) expect(hasIssueForField(result.error.issues, "amountMinor")).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 26: rejects an invalid state with a state issue (AD-17)", () => {
    const badArb = fc
      .tuple(nonTrialSubV2Arb, fc.oneof(fc.constant("active"), fc.constant("Enabled"), fc.string()))
      .map(([sub, bad]) => ({ ...sub, state: bad as unknown as "Active" }));

    fc.assert(
      fc.property(badArb, (sub) => {
        const result = subscriptionV2Schema.safeParse(sub);
        // A valid state value can occasionally be generated; only assert when it is actually invalid.
        if (sub.state === "Active" || sub.state === "Paused" || sub.state === "Trial") return;
        expect(result.success).toBe(false);
        if (!result.success) expect(hasIssueForField(result.error.issues, "state")).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Example tests -----------------------------------------------------------

describe("v2 schema (example tests)", () => {
  const baseSub = {
    id: "s1",
    name: "Netflix",
    provider: "Netflix",
    category: "Streaming",
    amountMinor: 1599,
    currency: "USD",
    billingCycle: "Monthly" as const,
    nextRenewal: "2026-11-01",
    startDate: "2026-01-01",
    paymentMethod: "Visa",
    website: "netflix.com",
    notes: "",
    color: "#000000",
    icon: "netflix",
    state: "Active" as const,
    priceHistory: [],
    tags: ["video"],
    autoRenew: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("parses a well-formed Active subscription", () => {
    expect(subscriptionV2Schema.safeParse(baseSub).success).toBe(true);
  });

  it("requires a trial when state is Trial and forbids it otherwise", () => {
    const trialNoTrial = { ...baseSub, state: "Trial" as const };
    const r1 = subscriptionV2Schema.safeParse(trialNoTrial);
    expect(r1.success).toBe(false);
    if (!r1.success) expect(r1.error.issues.some((i) => i.path[0] === "trial")).toBe(true);

    const activeWithTrial = { ...baseSub, trial: { endDate: "2026-02-01", postAmountMinor: 1599 } };
    const r2 = subscriptionV2Schema.safeParse(activeWithTrial);
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.error.issues.some((i) => i.path[0] === "trial")).toBe(true);
  });

  it("accepts both trial forms: explicit end date and start + N days", () => {
    expect(trialSchema.safeParse({ endDate: "2026-02-01", postAmountMinor: 1599 }).success).toBe(true);
    expect(trialSchema.safeParse({ startDate: "2026-01-01", lengthDays: 30, postAmountMinor: 1599 }).success).toBe(true);
  });

  it("rejects an end-date trial whose startDate is after endDate, with a startDate issue", () => {
    const r = trialSchema.safeParse({ startDate: "2026-02-01", endDate: "2026-01-01", postAmountMinor: 1599 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "startDate")).toBe(true);
    // startDate === endDate (zero-length but ordered) is allowed.
    expect(trialSchema.safeParse({ startDate: "2026-01-01", endDate: "2026-01-01", postAmountMinor: 1599 }).success).toBe(true);
  });

  it("makes trial 'months' unrepresentable (AD-18)", () => {
    // A months-based trial has no valid shape: a bare months field is extra
    // (strict) and neither union branch is satisfied without endDate or lengthDays.
    expect(trialSchema.safeParse({ startDate: "2026-01-01", lengthMonths: 1, postAmountMinor: 1599 }).success).toBe(false);
    expect(trialSchema.safeParse({ startDate: "2026-01-01", postAmountMinor: 1599 }).success).toBe(false);
  });

  it("rejects a non-positive trial lengthDays", () => {
    expect(trialSchema.safeParse({ startDate: "2026-01-01", lengthDays: 0, postAmountMinor: 1599 }).success).toBe(false);
    expect(trialSchema.safeParse({ startDate: "2026-01-01", lengthDays: 1.5, postAmountMinor: 1599 }).success).toBe(false);
  });

  it("stamps the v2 subscriptions file with version literal 2", () => {
    expect(subscriptionsFileV2Schema.safeParse({ version: 2, subscriptions: [baseSub] }).success).toBe(true);
    expect(subscriptionsFileV2Schema.safeParse({ version: 1, subscriptions: [baseSub] }).success).toBe(false);
  });

  it("parses a well-formed v2 settings object with homeCurrency and online block", () => {
    const settings = {
      homeCurrency: "USD",
      notification: { enabled: true, leadTimes: ["same-day"] },
      backupFrequency: "weekly" as const,
      theme: "dark" as const,
      accentColor: "#92400e",
      trayMode: false,
      dataFolder: null,
      online: { liveLogoFetch: false, fxRefresh: false },
    };
    expect(settingsV2Schema.safeParse(settings).success).toBe(true);
    expect(settingsFileV2Schema.safeParse({ ...settings, version: 2 }).success).toBe(true);

    // Missing the online block is rejected with an `online` issue.
    const { online: _omit, ...noOnline } = settings;
    const r = settingsV2Schema.safeParse(noOnline);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "online")).toBe(true);
  });

  it("rejects a v2 settings object missing homeCurrency with a homeCurrency issue (AD-22)", () => {
    const settings = {
      notification: { enabled: true, leadTimes: [] },
      backupFrequency: "off" as const,
      theme: "system" as const,
      accentColor: "#92400e",
      trayMode: false,
      dataFolder: null,
      online: { liveLogoFetch: false, fxRefresh: false },
    };
    const r = settingsV2Schema.safeParse(settings);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === "homeCurrency")).toBe(true);
  });
});
