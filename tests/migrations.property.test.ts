import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  migrate,
  SCHEMA_VERSION,
  migrateSubscriptionV1toV2,
  migrateSettingsV1toV2,
  migrateSubscriptionsFileV1toV2,
  migrateSettingsFileV1toV2,
  migrateAmountToMinor,
  roundHalfUpToExponent,
  MigrationError,
} from "core/migrations";
import {
  subscriptionV2Schema,
  subscriptionsFileV2Schema,
  settingsV2Schema,
  settingsFileV2Schema,
} from "core/models/schema";
import { minorUnits, exponentOf, MINOR_UNIT_EXPONENT, AmountOverflowError } from "core/money";
import type { BillingCycle, Subscription, SubscriptionsFile } from "core/models/subscription";
import type { ReminderLeadTime, Settings, SettingsFile } from "core/models/settings";

/**
 * Pure v1 -> v2 migrator properties + the real-beta-file example matrix
 * (AD-15 / FR-29). This is the release-gate acceptance signal for Story 1.3.
 *
 * Property 28 — a v1 subscription migrates to a schema-valid v2 record that
 *               preserves every carried field, maps `isActive` -> `state`,
 *               rounds `amount` half-up to the exponent, inits safe empties.
 * Property 29 — the money conversion is round-half-up, exponent-correct, and
 *               value-exact for every known currency.
 * Property 30 — v1 settings migrate to valid v2 (`defaultCurrency` ->
 *               `homeCurrency`, `online` all-false).
 * Property 31 — `migrate` no-ops an already-current (v2) file (returns it
 *               unchanged) and chains v1 -> v2 whole files.
 *
 * No real beta files exist in the repo; the example matrix below constructs
 * realistic v1 beta-shaped records inline with hand-computed expected values.
 */

const NUM_RUNS = 300;

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

const ALL_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENT);
const knownCurrencyArb = fc.constantFrom(...ALL_CURRENCIES);

const nonCustomCycleArb = fc.constantFrom<BillingCycle>("Weekly", "Monthly", "Quarterly", "Half-Yearly", "Yearly");

/**
 * A v1 float major `amount` whose fractional part has at most `exponent`
 * digits, i.e. an amount already exactly representable in the currency's minor
 * units (so the round-trip equals `minorUnits` with no rounding ambiguity).
 */
function exactMajorArb(exponent: number) {
  return fc
    .record({
      whole: fc.integer({ min: 0, max: 1_000_000 }),
      frac: fc.string({ unit: fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"), maxLength: exponent }),
    })
    .map(({ whole, frac }) => {
      const text = exponent === 0 || frac === "" ? whole.toString() : `${whole}.${frac}`;
      return { text, value: Number(text) };
    });
}

/**
 * A realistic v1 Subscription over a known currency. `amount` is a v1 float
 * major value exactly representable in that currency's minor units.
 */
const v1SubArb: fc.Arbitrary<Subscription> = fc
  .record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1 }),
    provider: fc.string(),
    category: fc.string(),
    currency: knownCurrencyArb,
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
  })
  .chain((base) =>
    exactMajorArb(exponentOf(base.currency)).map((amt) => ({
      ...base,
      amount: amt.value,
    })),
  );

const v1SettingsArb: fc.Arbitrary<Settings> = fc.record({
  defaultCurrency: knownCurrencyArb,
  notification: fc.record({
    enabled: fc.boolean(),
    leadTimes: fc.array(fc.constantFrom<ReminderLeadTime>("same-day", "one-day", "three-days"), { maxLength: 3 }),
  }),
  backupFrequency: fc.constantFrom<Settings["backupFrequency"]>("off", "daily", "weekly"),
  theme: fc.constantFrom<Settings["theme"]>("dark", "light", "system"),
  accentColor: fc.string(),
  trayMode: fc.boolean(),
  dataFolder: fc.option(fc.string(), { nil: null }),
});

// --- Property 28: v1 subscription -> schema-valid v2, fields preserved -------

describe("Feature: subby, Property 28: a v1 subscription migrates to a schema-valid v2 record preserving every carried field", () => {
  it("Feature: subby, Property 28: the result validates against subscriptionV2Schema and carries fields through unchanged", () => {
    fc.assert(
      fc.property(v1SubArb, (v1) => {
        const v2 = migrateSubscriptionV1toV2(v1);

        // Schema-valid v2.
        expect(subscriptionV2Schema.safeParse(v2).success).toBe(true);

        // isActive -> state.
        expect(v2.state).toBe(v1.isActive ? "Active" : "Paused");

        // amount -> exponent-correct amountMinor (exact, no rounding here).
        expect(v2.amountMinor).toBe(minorUnits(v1.amount, v1.currency));

        // currency preserved as Native.
        expect(v2.currency).toBe(v1.currency);

        // Safe-empty new fields.
        expect(v2.trial).toBeUndefined();
        expect(v2.priceHistory).toEqual([]);
        expect(v2.tags).toEqual([]);

        // Every other field carries over unchanged.
        expect(v2.id).toBe(v1.id);
        expect(v2.name).toBe(v1.name);
        expect(v2.provider).toBe(v1.provider);
        expect(v2.category).toBe(v1.category);
        expect(v2.billingCycle).toBe(v1.billingCycle);
        expect(v2.nextRenewal).toBe(v1.nextRenewal);
        expect(v2.startDate).toBe(v1.startDate);
        expect(v2.paymentMethod).toBe(v1.paymentMethod);
        expect(v2.website).toBe(v1.website);
        expect(v2.notes).toBe(v1.notes);
        expect(v2.color).toBe(v1.color);
        expect(v2.icon).toBe(v1.icon);
        expect(v2.autoRenew).toBe(v1.autoRenew);
        expect(v2.createdAt).toBe(v1.createdAt);
        expect(v2.updatedAt).toBe(v1.updatedAt);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 29: round-half-up, exponent-correct, value-exact money ---------

describe("Feature: subby, Property 29: amount migration is round-half-up, exponent-correct, and value-exact", () => {
  it("Feature: subby, Property 29: an already-exact amount converts to exactly minorUnits (no rounding drift)", () => {
    const arb = knownCurrencyArb.chain((currency) =>
      exactMajorArb(exponentOf(currency)).map((amt) => ({ currency, amt })),
    );
    fc.assert(
      fc.property(arb, ({ currency, amt }) => {
        expect(migrateAmountToMinor(amt.value, currency)).toBe(minorUnits(amt.text, currency));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 29: rounding half-up at the exponent matches hand arithmetic on the TRUE float value", () => {
    // Generate an over-precise major amount, then independently reimplement
    // round-half-up on the float's TRUE decimal expansion (not the constructed
    // string, which the float may not represent exactly). migrateAmountToMinor
    // must agree with this reference for every generated value.
    const arb = knownCurrencyArb.chain((currency) => {
      const exponent = exponentOf(currency);
      const extra = fc.integer({ min: 1, max: 3 }); // digits beyond the exponent
      return extra.chain((e) =>
        fc
          .record({
            whole: fc.integer({ min: 0, max: 100_000 }),
            frac: fc.string({
              unit: fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
              minLength: exponent + e,
              maxLength: exponent + e,
            }),
          })
          .map(({ whole, frac }) => ({ currency, exponent, value: Number(`${whole}.${frac}`) })),
      );
    });

    fc.assert(
      fc.property(arb, ({ currency, exponent, value }) => {
        // Reference round-half-up computed from the float's own fixed expansion
        // out to many guard digits — exactly the true-value semantics the
        // implementation uses, so a correct implementation always matches.
        const text = value.toFixed(exponent + 30);
        const [intPart, fracPart] = text.split(".");
        const kept = fracPart.slice(0, exponent);
        const firstDropped = fracPart.charCodeAt(exponent) - 48;
        let combined = BigInt(`${intPart}${kept}`);
        if (firstDropped >= 5) combined += 1n;
        const expected = Number(combined);

        expect(migrateAmountToMinor(value, currency)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 29: roundHalfUpToExponent output is always parseable by minorUnits", () => {
    const arb = knownCurrencyArb.chain((currency) =>
      fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }).map((amount) => ({ currency, amount })),
    );
    fc.assert(
      fc.property(arb, ({ currency, amount }) => {
        const exponent = exponentOf(currency);
        const rounded = roundHalfUpToExponent(amount, exponent);
        // The rounded string never has more fractional digits than the exponent,
        // so minorUnits (which rejects over-precision) always accepts it.
        expect(() => minorUnits(rounded, currency)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 32: strictly-below-tie amounts round DOWN (no double-round) ----

describe("Feature: subby, Property 32: an amount strictly below the half-tie rounds DOWN at the exponent", () => {
  it("Feature: subby, Property 32: value + 0.0xxx (dropped suffix < 5 at the exponent) truncates, never inflates to the tie", () => {
    // Build a major amount whose dropped suffix at `exponent` begins with a
    // digit in 0..4 — strictly below the half-up tie — so the correct result is
    // plain truncation. The expected minor units are computed from the EXACT
    // decimal digits (BigInt on the kept portion), never through toFixed, so
    // this fails if roundHalfUpToExponent double-rounds a <5 digit up to a tie.
    const arb = knownCurrencyArb.chain((currency) => {
      const exponent = exponentOf(currency);
      return fc
        .record({
          whole: fc.integer({ min: 0, max: 100_000 }),
          // The digits kept at the exponent.
          kept: fc.string({
            unit: fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
            minLength: exponent,
            maxLength: exponent,
          }),
          // First DROPPED digit forced into 0..4 (strictly below the tie).
          belowTie: fc.constantFrom("0", "1", "2", "3", "4"),
          // A couple more dropped digits (any value) — must NOT affect the result.
          tail: fc.string({
            unit: fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
            maxLength: 2,
          }),
        })
        .map(({ whole, kept, belowTie, tail }) => {
          const frac = `${kept}${belowTie}${tail}`;
          const value = Number(`${whole}.${frac}`);
          return { currency, exponent, value };
        });
    });

    fc.assert(
      fc.property(arb, ({ currency, exponent, value }) => {
        // Read the TRUE first-dropped digit from the float's own expansion. The
        // generator biases it toward 0..4 (below the tie), but we assert against
        // whatever the real value is, so this never flakes: a <5 digit must
        // round DOWN (plain truncation), proving no double-round inflates it.
        const text = value.toFixed(exponent + 30);
        const [intPart, fracPart] = text.split(".");
        const kept = fracPart.slice(0, exponent);
        const firstDropped = fracPart.charCodeAt(exponent) - 48;
        const expected = Number(BigInt(`${intPart}${kept}`) + (firstDropped >= 5 ? 1n : 0n));
        if (firstDropped < 5) {
          // The focus of this property: a strictly-below-tie digit truncates.
          expect(expected).toBe(Number(BigInt(`${intPart}${kept}`)));
        }
        expect(migrateAmountToMinor(value, currency)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 32: targeted round-DOWN cases (fixes the double-round defect)", () => {
    // 0.0048 and 0.0049 USD both drop a <5 digit at exponent 2 -> 0 (NOT 1).
    expect(migrateAmountToMinor(0.0048, "USD")).toBe(0);
    expect(migrateAmountToMinor(0.0049, "USD")).toBe(0);
    expect(roundHalfUpToExponent(0.0048, 2)).toBe("0.00");
    expect(roundHalfUpToExponent(0.0049, 2)).toBe("0.00");
    // 0.4 JPY drops a <5 digit at exponent 0 -> 0.
    expect(migrateAmountToMinor(0.4, "JPY")).toBe(0);
    expect(roundHalfUpToExponent(0.4, 0)).toBe("0");
    // The tie and just-above still round UP (regression fence for the fix).
    expect(migrateAmountToMinor(0.005, "USD")).toBe(1);
    expect(migrateAmountToMinor(0.0051, "USD")).toBe(1);
    expect(migrateAmountToMinor(0.5, "JPY")).toBe(1);
  });

  it("Feature: subby, Property 32: an amount >= 1e21 is a typed overflow, not a raw SyntaxError", () => {
    // toFixed yields exponential notation ("1e+21") at this magnitude; the
    // migrator must detect it and throw AmountOverflowError, never let BigInt
    // throw a raw SyntaxError on "1e+21".
    expect(() => roundHalfUpToExponent(1e21, 2)).toThrow(AmountOverflowError);
    expect(() => migrateAmountToMinor(1e21, "USD")).toThrow(AmountOverflowError);
    // Just below the exponential-notation boundary still renders as fixed digits
    // (though it will overflow the safe-integer range in minorUnits — also a
    // typed AmountOverflowError, never a raw throw).
    expect(() => migrateAmountToMinor(1e21, "JPY")).toThrow(AmountOverflowError);
  });
});

// --- Property 30: v1 settings -> valid v2 ------------------------------------

describe("Feature: subby, Property 30: v1 settings migrate to a valid v2 settings record", () => {
  it("Feature: subby, Property 30: defaultCurrency -> homeCurrency, online all-false, everything else preserved", () => {
    fc.assert(
      fc.property(v1SettingsArb, (v1) => {
        const v2 = migrateSettingsV1toV2(v1);

        expect(settingsV2Schema.safeParse(v2).success).toBe(true);
        expect(v2.homeCurrency).toBe(v1.defaultCurrency);
        expect(v2.online).toEqual({ liveLogoFetch: false, fxRefresh: false });

        // Everything else carried over.
        expect(v2.notification).toEqual(v1.notification);
        expect(v2.backupFrequency).toBe(v1.backupFrequency);
        expect(v2.theme).toBe(v1.theme);
        expect(v2.accentColor).toBe(v1.accentColor);
        expect(v2.trayMode).toBe(v1.trayMode);
        expect(v2.dataFolder).toBe(v1.dataFolder);

        // The v1 field is gone.
        expect((v2 as unknown as { defaultCurrency?: unknown }).defaultCurrency).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 31: whole-file migrate chains v1->v2 and no-ops v2 -------------

describe("Feature: subby, Property 31: migrate chains v1 whole files to v2 and no-ops an already-current file", () => {
  it("Feature: subby, Property 31: a v1 subscriptions file migrates to a schema-valid v2 file", () => {
    const fileArb = fc.array(v1SubArb, { maxLength: 8 }).map((subscriptions): SubscriptionsFile => ({
      version: 1,
      subscriptions,
    }));
    fc.assert(
      fc.property(fileArb, (file) => {
        const out = migrate(file, 1);
        expect(subscriptionsFileV2Schema.safeParse(out).success).toBe(true);
        expect(out.version).toBe(2);
        expect(out.subscriptions.length).toBe(file.subscriptions.length);
        // Records map 1:1 in order — no reorder, drop, or duplication.
        expect(out.subscriptions.map((s) => s.id)).toEqual(file.subscriptions.map((s) => s.id));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 31: an already-v2 subscriptions file is returned unchanged (no-op, same reference)", () => {
    const fileArb = fc.array(v1SubArb, { maxLength: 8 }).map((subs) =>
      migrateSubscriptionsFileV1toV2({ version: 1, subscriptions: subs }),
    );
    fc.assert(
      fc.property(fileArb, (v2File) => {
        const out = migrate(v2File, SCHEMA_VERSION);
        expect(out).toBe(v2File); // identical reference — true no-op
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 31: a v1 settings file migrates to a schema-valid v2 file; a v2 one no-ops", () => {
    const settingsFileArb = v1SettingsArb.map((s): SettingsFile => ({ ...s, version: 1 }));
    fc.assert(
      fc.property(settingsFileArb, (file) => {
        const out = migrate(file, 1);
        expect(settingsFileV2Schema.safeParse(out).success).toBe(true);
        expect(out.version).toBe(2);

        const noop = migrate(out, SCHEMA_VERSION);
        expect(noop).toBe(out);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Example matrix (every I/O-matrix row, hand-computed) --------------------

describe("v1 -> v2 migration (example matrix — real-beta-shaped records)", () => {
  /** A realistic, fully-populated v1 beta subscription. */
  const fullV1Sub: Subscription = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Netflix",
    provider: "Netflix",
    category: "Streaming",
    amount: 9.99,
    currency: "USD",
    billingCycle: "Monthly",
    nextRenewal: "2026-11-01",
    startDate: "2024-01-01",
    paymentMethod: "Visa •1234",
    website: "https://netflix.com",
    notes: "Family plan",
    color: "#E50914",
    icon: "netflix",
    isActive: true,
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2026-10-01T12:34:56.000Z",
  };

  it("full v1 record -> Active, amountMinor 999, currency Native, safe empties, all else identical", () => {
    const v2 = migrateSubscriptionV1toV2(fullV1Sub);
    expect(subscriptionV2Schema.safeParse(v2).success).toBe(true);
    expect(v2.state).toBe("Active");
    expect(v2.amountMinor).toBe(999); // 9.99 USD -> 999
    expect(v2.currency).toBe("USD");
    expect(v2.priceHistory).toEqual([]);
    expect(v2.tags).toEqual([]);
    expect(v2.trial).toBeUndefined();
    // Carried-over fields identical.
    expect(v2.id).toBe(fullV1Sub.id);
    expect(v2.name).toBe("Netflix");
    expect(v2.provider).toBe("Netflix");
    expect(v2.category).toBe("Streaming");
    expect(v2.billingCycle).toBe("Monthly");
    expect(v2.nextRenewal).toBe("2026-11-01");
    expect(v2.startDate).toBe("2024-01-01");
    expect(v2.paymentMethod).toBe("Visa •1234");
    expect(v2.website).toBe("https://netflix.com");
    expect(v2.notes).toBe("Family plan");
    expect(v2.color).toBe("#E50914");
    expect(v2.icon).toBe("netflix");
    expect(v2.autoRenew).toBe(true);
    expect(v2.createdAt).toBe(fullV1Sub.createdAt);
    expect(v2.updatedAt).toBe(fullV1Sub.updatedAt);
    // The v1-only fields are gone.
    expect((v2 as unknown as { amount?: unknown }).amount).toBeUndefined();
    expect((v2 as unknown as { isActive?: unknown }).isActive).toBeUndefined();
  });

  it("paused mapping: isActive:false -> state:'Paused'", () => {
    const v2 = migrateSubscriptionV1toV2({ ...fullV1Sub, isActive: false });
    expect(v2.state).toBe("Paused");
  });

  it("rounding rule: 9.999 USD -> 1000, 1000 JPY -> 1000, 1.2355 KWD -> 1236 (round-half-up to exponent)", () => {
    expect(migrateAmountToMinor(9.999, "USD")).toBe(1000);
    expect(migrateAmountToMinor(1000, "JPY")).toBe(1000);
    // KWD (exponent 3): the double 1.2355 is a true >=-tie at the 4th decimal,
    // so it rounds half-UP to 1.236 -> 1236. (See the IEEE note below for why
    // the spec matrix's literal 1.2345 is NOT a tie as a double.)
    expect(migrateAmountToMinor(1.2355, "KWD")).toBe(1236);

    // Full-record form stays schema-valid with the rounded amount.
    const usd = migrateSubscriptionV1toV2({ ...fullV1Sub, amount: 9.999, currency: "USD" });
    expect(usd.amountMinor).toBe(1000);
    expect(subscriptionV2Schema.safeParse(usd).success).toBe(true);
  });

  it("rounding rule: the decision uses the TRUE IEEE value, not toFixed (1.2345 KWD -> 1234, not 1235)", () => {
    // IMPORTANT: the double written `1.2345` is actually 1.23449999999999993…,
    // which is strictly BELOW the .2345 half-tie, so round-half-up truncates it
    // to 1.234 -> 1234. The spec matrix's expected 1235 presupposes an exact
    // decimal tie, which only the (now-removed) toFixed double-round produced.
    // Rounding on the real dropped suffix is the correct, defect-free behavior.
    expect(migrateAmountToMinor(1.2345, "KWD")).toBe(1234);
    expect(roundHalfUpToExponent(1.2345, 3)).toBe("1.234");
  });

  it("rounding rule: exact half ties round up (0.005 USD -> 1, 2.5 JPY -> 3)", () => {
    expect(migrateAmountToMinor(0.005, "USD")).toBe(1); // half -> up
    expect(migrateAmountToMinor(2.5, "JPY")).toBe(3); // half -> up at exp 0
    expect(roundHalfUpToExponent(1.2355, 3)).toBe("1.236");
    expect(roundHalfUpToExponent(9.999, 2)).toBe("10.00");
    expect(roundHalfUpToExponent(1000, 0)).toBe("1000");
  });

  it("rounding rule: an over-huge amount surfaces money.ts's overflow error", () => {
    // JPY (exponent 0): a value above Number.MAX_SAFE_INTEGER overflows.
    expect(() => migrateAmountToMinor(1e18, "JPY")).toThrow(AmountOverflowError);
  });

  it("unknown currency throws (never silently assumes exponent 2)", () => {
    expect(() => migrateAmountToMinor(9.99, "ZZZ")).toThrow();
  });

  it("settings rename: defaultCurrency 'INR' + no online block -> homeCurrency 'INR', online all-false", () => {
    const v1Settings: Settings = {
      defaultCurrency: "INR",
      notification: { enabled: true, leadTimes: ["same-day", "three-days"] },
      backupFrequency: "weekly",
      theme: "dark",
      accentColor: "#92400e",
      trayMode: false,
      dataFolder: null,
    };
    const v2 = migrateSettingsV1toV2(v1Settings);
    expect(v2.homeCurrency).toBe("INR");
    expect(v2.online).toEqual({ liveLogoFetch: false, fxRefresh: false });
    expect(settingsV2Schema.safeParse(v2).success).toBe(true);

    const fileV2 = migrateSettingsFileV1toV2({ ...v1Settings, version: 1 });
    expect(fileV2.version).toBe(2);
    expect(settingsFileV2Schema.safeParse(fileV2).success).toBe(true);
  });

  it("custom interval: billingCycle 'Custom' + customInterval carries over; v2 validates", () => {
    const custom: Subscription = {
      ...fullV1Sub,
      billingCycle: "Custom",
      customInterval: { unit: "week", count: 2 },
    };
    const v2 = migrateSubscriptionV1toV2(custom);
    expect(v2.billingCycle).toBe("Custom");
    expect(v2.customInterval).toEqual({ unit: "week", count: 2 });
    expect(subscriptionV2Schema.safeParse(v2).success).toBe(true);

    // A Custom cycle with no interval produces an invalid v2 file -> throw.
    const broken: Subscription = { ...fullV1Sub, billingCycle: "Custom", customInterval: undefined };
    expect(() => migrateSubscriptionsFileV1toV2({ version: 1, subscriptions: [broken] })).toThrow(MigrationError);
  });

  it("already v2: a version:2 subscriptions file is returned unchanged (no-op)", () => {
    const v2File = migrateSubscriptionsFileV1toV2({ version: 1, subscriptions: [fullV1Sub] });
    const out = migrate(v2File, 2);
    expect(out).toBe(v2File);
  });

  it("whole-file migrate: {version:1, subscriptions:[...]} -> {version:2, subscriptions:[...v2]} validating against v2", () => {
    const v1File: SubscriptionsFile = {
      version: 1,
      subscriptions: [
        fullV1Sub,
        { ...fullV1Sub, id: "22222222-2222-4222-8222-222222222222", amount: 1000, currency: "JPY", isActive: false },
        { ...fullV1Sub, id: "33333333-3333-4333-8333-333333333333", amount: 1.2355, currency: "KWD" },
      ],
    };
    const out = migrate(v1File, 1);
    expect(subscriptionsFileV2Schema.safeParse(out).success).toBe(true);
    expect(out.version).toBe(2);
    expect(out.subscriptions.map((s) => s.amountMinor)).toEqual([999, 1000, 1236]);
    expect(out.subscriptions.map((s) => s.state)).toEqual(["Active", "Paused", "Active"]);
  });

  it("whole-file migrate: an empty v1 file -> {version:2, subscriptions:[]} validating against the v2 schema", () => {
    const empty: SubscriptionsFile = { version: 1, subscriptions: [] };
    const out = migrate(empty, 1);
    expect(subscriptionsFileV2Schema.safeParse(out).success).toBe(true);
    expect(out).toEqual({ version: 2, subscriptions: [] });
  });

  it("whole-file migrate: a record that can't transform throws; no partial v2 file is emitted", () => {
    const v1File: SubscriptionsFile = {
      version: 1,
      subscriptions: [
        fullV1Sub, // fine
        { ...fullV1Sub, id: "bad", currency: "ZZZ" }, // unknown currency -> throws
      ],
    };
    expect(() => migrate(v1File, 1)).toThrow(MigrationError);
  });

  it("migrate: an unknown/unsupported fromVersion is a loud MigrationError (not a silent pass)", () => {
    const v1File: SubscriptionsFile = { version: 99, subscriptions: [fullV1Sub] };
    expect(() => migrate(v1File, 99)).toThrow(MigrationError);
  });

  it("migrate: fromVersion that disagrees with the file's own version throws (no unvalidated v1-as-v2)", () => {
    // A v1 file mislabeled as current must NOT no-op into unvalidated v2.
    const v1File: SubscriptionsFile = { version: 1, subscriptions: [fullV1Sub] };
    expect(() => migrate(v1File, 2)).toThrow(MigrationError);
    // And the reverse mismatch is caught too.
    const v2File = migrateSubscriptionsFileV1toV2({ version: 1, subscriptions: [fullV1Sub] });
    expect(() => migrate(v2File, 1)).toThrow(MigrationError);
  });
});
