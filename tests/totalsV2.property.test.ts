import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  homeMonthlyTotal,
  homeYearlyTotal,
  totalFor,
  InvalidCycleError,
  type HomeTotal,
} from "core/totalsV2";
import {
  exponentOf,
  toMajor,
  MINOR_UNIT_EXPONENT,
  UnknownCurrencyError,
  MissingRateError,
  InvalidRateError,
  InvalidAmountError,
  AmountOverflowError,
  type RateSnapshot,
} from "core/money";
import type { BillingCycle, CustomInterval, SubscriptionV2 } from "core/models/subscription";
import type { SettingsV2 } from "core/models/settings";

/**
 * Home-currency, convert-before-sum totals over v2 subscriptions
 * (FR-11, AD-10, AD-11, SM-6; Story 2.2).
 *
 * Property 35 — for arbitrary v2 subs in arbitrary Native currencies with
 *               arbitrary cycles and a dated rate snapshot, homeMonthly/Yearly
 *               total converts Native→Home BEFORE summing and equals an
 *               independent precise (exact-rational, round-once) reference — it
 *               is NEVER the raw sum of unlike currencies and NEVER the Σ of
 *               per-row-rounded shares; and changing `homeCurrency` recomputes
 *               to the Home-currency-correct total (single source).
 * Property 36 — the result's `asOf` equals the snapshot's verbatim, the total
 *               is a non-negative integer in Home minor units, and an empty set
 *               totals to 0.
 *
 * Plus example tests for every I/O-matrix row.
 *
 * Rounding note: the convert-before-sum is exact (per the independent oracle),
 * so there are zero mixed-currency summation errors (SM-6). The cycle
 * normalization is scaled exactly by the least-common cycle factor K and the
 * convert-sum is rounded once (inside `homeTotal`) at K×Home-minor granularity
 * before the single `/K` cycle round, so the Home-minor result can differ from
 * an abstract single-rational round by at most ONE minor unit, and only at a
 * measure-zero half-minor-unit tie. The oracle therefore asserts equality
 * within ≤1 minor unit (and exact equality in the overwhelming common case),
 * which pins the honest convert-before-sum while allowing that boundary.
 */

const NUM_RUNS = 300;

// --- Generators --------------------------------------------------------------

const ALL_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENT);
const knownCurrencyArb = fc.constantFrom(...ALL_CURRENCIES);

/**
 * Positive per-currency rates for a snapshot. The Home currency's own rate is
 * ALWAYS forced to exactly "1" by {@link snapshotFor} (the rate-table contract:
 * a snapshot is anchored to its Home currency, which maps to 1). The non-Home
 * values are arbitrary-but-fixed positive rates spanning <1 and >1.
 */
const BASE_RATES: Record<string, string> = {
  USD: "1.3",
  EUR: "1.085",
  GBP: "1.27",
  INR: "0.012",
  CAD: "0.74",
  AUD: "0.66",
  CHF: "1.12",
  CNY: "0.14",
  HKD: "0.128",
  SGD: "0.74",
  NZD: "0.61",
  SEK: "0.095",
  NOK: "0.093",
  DKK: "0.145",
  ZAR: "0.055",
  MXN: "0.058",
  BRL: "0.19",
  JPY: "0.0067",
  KRW: "0.00075",
  BHD: "2.65",
  KWD: "3.25",
  OMR: "2.60",
  // Common world majors added to the exponent table in Story 2.3 (ship list).
  // These are TEST-FIXTURE USD-base rates (USD per 1 unit) only — their
  // absolute values are deliberately kept in the same moderate band as the
  // existing entries so the re-anchoring in `snapshotFor` stays within the
  // documented ≤500k-minor / ≤20-sub overflow envelope (CYCLE_SCALE × a very
  // weak 2-exponent Home would otherwise overflow). The REAL, realistic ECB
  // values live in resources/fx-snapshot.json and tests/fxSnapshot.property.test.ts;
  // this fixture only exercises internal consistency against its own oracle.
  PLN: "0.256",
  CZK: "0.045",
  HUF: "0.08",
  RON: "0.22",
  TRY: "0.0285",
  ILS: "0.2656",
  AED: "0.2723",
  SAR: "0.2666",
  THB: "0.0291",
  MYR: "0.2238",
  IDR: "0.065",
  PHP: "0.0177",
};

/** Rate-string decimals used when re-anchoring {@link snapshotFor}. */
const REBASE_DECIMALS = 10;

/**
 * Divide two positive decimal rate strings exactly to {@link REBASE_DECIMALS}
 * fractional digits, returning a decimal string. Pure BigInt; used to re-base
 * the rate table so it is anchored to a chosen Home Currency.
 */
function divideRateStrings(a: string, b: string): string {
  const toScaled = (s: string): bigint => {
    const [i, f = ""] = s.split(".");
    return BigInt(`${i}${f.padEnd(REBASE_DECIMALS, "0")}`);
  };
  const scale = 10n ** BigInt(REBASE_DECIMALS);
  const num = toScaled(a) * scale; // a * 10^(2D)
  const den = toScaled(b); // b * 10^D  -> quotient is (a/b) * 10^D
  const q = num / den;
  const whole = q / scale;
  const frac = (q % scale).toString().padStart(REBASE_DECIMALS, "0");
  return `${whole.toString()}.${frac}`;
}

/**
 * Build a rate snapshot ANCHORED to `homeCurrency`: the Home currency maps to
 * exactly "1" (satisfying the rate-table contract) and every other currency is
 * re-based to "Home major units per 1 unit of that currency" by dividing its
 * USD-base rate by the Home currency's USD-base rate. Changing the Home
 * Currency therefore re-anchors the WHOLE table (not just the Home entry) — the
 * single-source behavior, with genuinely different cross-rates per Home.
 */
function snapshotFor(homeCurrency: string, asOf = "2026-10-02"): RateSnapshot {
  const homeBase = BASE_RATES[homeCurrency];
  const rates: Record<string, string> = {};
  for (const [currency, base] of Object.entries(BASE_RATES)) {
    rates[currency] = currency === homeCurrency ? "1" : divideRateStrings(base, homeBase);
  }
  return { asOf, rates };
}

const cycleArb: fc.Arbitrary<BillingCycle> = fc.constantFrom(
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
  "Custom",
);

const customIntervalArb: fc.Arbitrary<CustomInterval> = fc.record({
  unit: fc.constantFrom("day", "week", "month", "year"),
  count: fc.integer({ min: 1, max: 60 }),
});

/**
 * A schema-shaped v2 subscription with a known Native currency, a non-negative
 * integer `amountMinor`, and an arbitrary billing cycle (a `customInterval`
 * only when the cycle is `Custom`). Only the fields the totals layer reads
 * (`amountMinor`, `currency`, `billingCycle`, `customInterval`) vary; the rest
 * are fixed valid values.
 */
// Amounts and set size stay within the cycle-scaling safe envelope (so the
// SCALE-scaled line never overflows the safe-integer range inside homeTotal):
// amountMinor <= 500_000 minor units, <= 20 subs (see totalsV2's CYCLE_SCALE).
const subV2Arb: fc.Arbitrary<SubscriptionV2> = fc
  .record({
    currency: knownCurrencyArb,
    amountMinor: fc.integer({ min: 0, max: 500_000 }),
    billingCycle: cycleArb,
    customInterval: customIntervalArb,
  })
  .map(({ currency, amountMinor, billingCycle, customInterval }) => ({
    id: "s",
    name: "Sub",
    provider: "P",
    category: "C",
    amountMinor,
    currency,
    billingCycle,
    customInterval: billingCycle === "Custom" ? customInterval : undefined,
    nextRenewal: "2026-11-01",
    startDate: "2026-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "x",
    state: "Active" as const,
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));

/** Build a settings object whose single source of Home Currency is `homeCurrency`. */
function settingsWithHome(homeCurrency: string): SettingsV2 {
  return {
    homeCurrency,
    notification: { enabled: false, leadTimes: [] },
    backupFrequency: "off",
    theme: "system",
    accentColor: "#92400e",
    trayMode: false,
    dataFolder: null,
    online: { liveLogoFetch: false, fxRefresh: false },
  };
}

// --- Independent references --------------------------------------------------

function pow(n: number): bigint {
  let f = 1n;
  for (let i = 0; i < n; i++) f *= 10n;
  return f;
}

/** Round a BigInt quotient `num / den` to the nearest integer (half-up on ties). */
function roundDiv(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/**
 * One sub's PERIOD contribution as an exact rational (numer / denom) in Native
 * minor units — the independent mirror of the production cycle factors, derived
 * from scratch so a wrong factor in production is caught.
 */
function cycleFactor(cycle: BillingCycle, ci: CustomInterval | undefined): { numer: bigint; denom: bigint } {
  switch (cycle) {
    case "Monthly":
      return { numer: 1n, denom: 1n };
    case "Yearly":
      return { numer: 1n, denom: 12n };
    case "Half-Yearly":
      return { numer: 1n, denom: 6n };
    case "Quarterly":
      return { numer: 1n, denom: 3n };
    case "Weekly":
      return { numer: 52n, denom: 12n };
    case "Custom": {
      const c = BigInt(ci!.count);
      switch (ci!.unit) {
        case "day":
          return { numer: 30n, denom: c };
        case "week":
          return { numer: 30n, denom: 7n * c };
        case "month":
          return { numer: 1n, denom: c };
        case "year":
          return { numer: 1n, denom: 12n * c };
      }
    }
  }
}

/**
 * Independent EXACT-RATIONAL reference: convert every sub's exact period
 * contribution Native→Home, sum as a single common-denominator rational, and
 * round ONCE to Home minor units. This is the "precise sum, round once" oracle —
 * it never raw-sums unlike currencies and never rounds a per-row figure.
 */
function referenceExactTotal(
  subs: readonly SubscriptionV2[],
  snapshot: RateSnapshot,
  homeCurrency: string,
  period: "monthly" | "yearly",
): number {
  const homeExponent = exponentOf(homeCurrency);
  const homeFactor = pow(homeExponent);
  const periodMul = period === "yearly" ? 12n : 1n;

  let accNum = 0n;
  let accDen = 1n;
  for (const sub of subs) {
    const { numer, denom } = cycleFactor(sub.billingCycle, sub.customInterval);
    const nativeExp = exponentOf(sub.currency);
    const rate = String((snapshot.rates as Record<string, string | number>)[sub.currency]);
    const [ri, rf = ""] = rate.split(".");
    const rateScaled = BigInt(`${ri}${rf}` || "0");
    // Home-minor contribution of this sub (exact rational):
    //   amountMinor * (numer*periodMul/denom)   -> Native minor * cycle share
    //   / 10^nativeExp                            -> Native major
    //   * rateScaled / 10^rf.length               -> Home major
    //   * 10^homeExp                              -> Home minor
    const termNum = BigInt(sub.amountMinor) * numer * periodMul * rateScaled * homeFactor;
    const termDen = denom * pow(nativeExp) * pow(rf.length);
    accNum = accNum * termDen + termNum * accDen;
    accDen = accDen * termDen;
  }
  return Number(roundDiv(accNum, accDen));
}

/**
 * The WRONG "Σ of per-row rounded shares" figure: round each sub's own
 * Home-minor contribution to an integer first, then sum those integers. Used in
 * example tests to prove production is NOT this.
 */
function sumOfPerRowRounded(
  subs: readonly SubscriptionV2[],
  snapshot: RateSnapshot,
  homeCurrency: string,
  period: "monthly" | "yearly",
): number {
  return subs.reduce((acc, sub) => acc + referenceExactTotal([sub], snapshot, homeCurrency, period), 0);
}

// --- Property 35 -------------------------------------------------------------

describe("Feature: subby, Property 35: homeMonthly/YearlyTotal converts before summing, round-once, Home as single source", () => {
  it("Feature: subby, Property 35: equals the exact-rational precise reference (never raw-sum, never Σ-of-rounded), and recomputes per Home Currency", () => {
    const scenarioArb = fc.record({
      subs: fc.array(subV2Arb, { maxLength: 20 }),
      homeCurrency: knownCurrencyArb,
      period: fc.constantFrom("monthly" as const, "yearly" as const),
    });

    fc.assert(
      fc.property(scenarioArb, ({ subs, homeCurrency, period }) => {
        const settings = settingsWithHome(homeCurrency);
        const snapshot = snapshotFor(homeCurrency); // anchored to Home (Home -> "1")
        const result =
          period === "monthly"
            ? homeMonthlyTotal(subs, snapshot, settings)
            : homeYearlyTotal(subs, snapshot, settings);

        const reference = referenceExactTotal(subs, snapshot, homeCurrency, period);

        // Convert-before-sum is EXACT: zero mixed-currency summation error. The
        // only permissible deviation is the ≤1-minor-unit home-minor tie from
        // the cycle-scaling round (see the module's rounding note) — never a
        // raw sum or a Σ-of-rounded figure, which would deviate far more.
        expect(Math.abs(result.totalMinor - reference)).toBeLessThanOrEqual(1);

        // Home Currency is the single source: the output exponent is Home's and
        // the figure recomputes for THIS Home Currency (the reference above is
        // computed for the same homeCurrency, so a wrong Home source — e.g.
        // ignoring it — would blow the ≤1 bound for mixed sets).
        expect(result.homeCurrency).toBe(homeCurrency);

        // A bare-string Home source yields the same total as the settings source.
        const viaString =
          period === "monthly"
            ? homeMonthlyTotal(subs, snapshot, homeCurrency)
            : homeYearlyTotal(subs, snapshot, homeCurrency);
        expect(viaString.totalMinor).toBe(result.totalMinor);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 35: changing Home Currency recomputes the total (single source drives every figure)", () => {
    // A single non-zero EUR monthly sub, totalled at two different Home
    // currencies, must differ exactly as the EUR→Home rates differ (not stay
    // fixed, not raw-sum). Compared against the independent reference for each.
    const arb = fc.integer({ min: 1, max: 50_000_000 }).map((amountMinor) => amountMinor);
    fc.assert(
      fc.property(arb, (amountMinor) => {
        const subs: SubscriptionV2[] = [
          { ...buildSub("EUR", amountMinor, "Monthly") },
        ];
        // Each total uses a snapshot anchored to its own Home Currency.
        const usdSnap = snapshotFor("USD");
        const inrSnap = snapshotFor("INR");
        const inUsd = homeMonthlyTotal(subs, usdSnap, "USD");
        const inInr = homeMonthlyTotal(subs, inrSnap, "INR");
        expect(Math.abs(inUsd.totalMinor - referenceExactTotal(subs, usdSnap, "USD", "monthly"))).toBeLessThanOrEqual(1);
        expect(Math.abs(inInr.totalMinor - referenceExactTotal(subs, inrSnap, "INR", "monthly"))).toBeLessThanOrEqual(1);
        // €X is worth very different INR vs USD minor units -> the totals differ.
        expect(inUsd.totalMinor).not.toBe(inInr.totalMinor);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Build a single schema-shaped v2 sub (helper for example/property tests). */
function buildSub(
  currency: string,
  amountMinor: number,
  billingCycle: BillingCycle,
  customInterval?: CustomInterval,
): SubscriptionV2 {
  return {
    id: "x",
    name: "Sub",
    provider: "P",
    category: "C",
    amountMinor,
    currency,
    billingCycle,
    customInterval,
    nextRenewal: "2026-11-01",
    startDate: "2026-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "x",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// --- Property 36 -------------------------------------------------------------

describe("Feature: subby, Property 36: result carries asOf verbatim, is a non-negative integer, empty set totals to 0", () => {
  it("Feature: subby, Property 36: asOf passthrough, non-negative integer total, exponent follows Home", () => {
    const scenarioArb = fc.record({
      subs: fc.array(subV2Arb, { maxLength: 20 }),
      homeCurrency: knownCurrencyArb,
      asOf: fc
        .record({ y: fc.integer({ min: 2000, max: 2099 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }) })
        .map(({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`),
      period: fc.constantFrom("monthly" as const, "yearly" as const),
    });

    fc.assert(
      fc.property(scenarioArb, ({ subs, homeCurrency, asOf, period }) => {
        const snapshot = snapshotFor(homeCurrency, asOf); // Home-anchored, arbitrary asOf
        const result = totalFor(subs, snapshot, settingsWithHome(homeCurrency), period);

        // asOf is echoed verbatim.
        expect(result.asOf).toBe(asOf);
        // The total is a non-negative integer in Home minor units.
        expect(Number.isInteger(result.totalMinor)).toBe(true);
        expect(result.totalMinor).toBeGreaterThanOrEqual(0);
        // It renders in the Home Currency (output exponent follows Home).
        expect(() => toMajor(result.totalMinor, result.homeCurrency)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 36: an empty set totals to 0 and still echoes asOf", () => {
    fc.assert(
      fc.property(knownCurrencyArb, (homeCurrency) => {
        const snapshot = snapshotFor(homeCurrency);
        const m = homeMonthlyTotal([], snapshot, homeCurrency);
        const y = homeYearlyTotal([], snapshot, homeCurrency);
        expect(m.totalMinor).toBe(0);
        expect(y.totalMinor).toBe(0);
        expect(m.asOf).toBe(snapshot.asOf);
        expect(y.asOf).toBe(snapshot.asOf);
        expect(m.homeCurrency).toBe(homeCurrency);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Example tests: every I/O-matrix row -------------------------------------

describe("totalsV2 I/O matrix (example tests)", () => {
  it("mixed-currency monthly total: converts before summing (golden $10 + €10@1.08 + ₹1000@0.012 = $32.80)", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1", EUR: "1.08", INR: "0.012" } };
    const subs: SubscriptionV2[] = [
      buildSub("USD", 1000, "Monthly"), // $10.00
      buildSub("EUR", 1000, "Monthly"), // €10.00 -> $10.80
      buildSub("INR", 100000, "Monthly"), // ₹1000.00 -> $12.00
    ];
    const result = homeMonthlyTotal(subs, snapshot, { homeCurrency: "USD" } as SettingsV2);
    expect(result).toEqual<HomeTotal>({ totalMinor: 3280, asOf: "2026-10-02", homeCurrency: "USD" });
    expect(toMajor(result.totalMinor, "USD")).toBe("32.80");
  });

  it("Home-currency single source: same subs recompute for USD then EUR; output exponent follows Home", () => {
    const subs: SubscriptionV2[] = [buildSub("USD", 1000, "Monthly"), buildSub("JPY", 1000, "Monthly")];
    // A snapshot is anchored to its Home Currency (Home -> 1); switching Home
    // re-anchors the table, which is the single-source behavior.
    const usdSnap: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1", EUR: "0.9259", JPY: "0.0067" } };
    const eurSnap: RateSnapshot = { asOf: "2026-10-02", rates: { EUR: "1", USD: "1.08", JPY: "0.0072" } };
    const inUsd = homeMonthlyTotal(subs, usdSnap, "USD");
    const inEur = homeMonthlyTotal(subs, eurSnap, "EUR");
    expect(inUsd.homeCurrency).toBe("USD");
    expect(inEur.homeCurrency).toBe("EUR");
    // Same real spend, different Home currency -> different minor-unit figure.
    expect(inUsd.totalMinor).not.toBe(inEur.totalMinor);
  });

  it("cycle normalization, round-once: 3× yearly whose ÷12 share has a sub-minor remainder sums precisely", () => {
    // 3 yearly subs of $1.00/yr each: monthly share $1.00/12 = $0.0833… each.
    // Σ precise monthly = 3 × 100/12 = 25 minor units ($0.25), rounded ONCE.
    // Σ of per-row rounded shares would be 3 × round(8.33) = 3 × 8 = 24 (WRONG).
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    const subs: SubscriptionV2[] = [
      buildSub("USD", 100, "Yearly"),
      buildSub("USD", 100, "Yearly"),
      buildSub("USD", 100, "Yearly"),
    ];
    const monthly = homeMonthlyTotal(subs, snapshot, "USD");
    expect(monthly.totalMinor).toBe(25); // precise Σ, round once
    expect(sumOfPerRowRounded(subs, snapshot, "USD", "monthly")).toBe(24); // the WRONG re-summed-rounded answer
    expect(monthly.totalMinor).not.toBe(sumOfPerRowRounded(subs, snapshot, "USD", "monthly"));

    // Yearly of the same set is exactly 3 × $1.00 = $3.00.
    expect(homeYearlyTotal(subs, snapshot, "USD").totalMinor).toBe(300);
  });

  it("as-of passthrough: the result carries the snapshot's asOf unchanged", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    const subs: SubscriptionV2[] = [buildSub("USD", 500, "Monthly")];
    expect(homeMonthlyTotal(subs, snapshot, "USD").asOf).toBe("2026-10-02");
    expect(homeYearlyTotal(subs, snapshot, "USD").asOf).toBe("2026-10-02");
  });

  it("Home rate ≠ 1: throws the loud rate-contract error (never silent Home scaling)", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1.02", EUR: "1.08" } };
    const subs: SubscriptionV2[] = [buildSub("USD", 1000, "Monthly")];
    expect(() => homeMonthlyTotal(subs, snapshot, "USD")).toThrow(InvalidRateError);
  });

  it("zero rate: throws (an unfetched/zero rate is rejected, never a silent zero conversion)", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1", EUR: "0" } };
    const subs: SubscriptionV2[] = [buildSub("EUR", 1000, "Monthly")];
    expect(() => homeMonthlyTotal(subs, snapshot, "USD")).toThrow(InvalidAmountError);
  });

  it("missing rate: a line's currency absent from the snapshot throws MissingRateError (never a raw sum)", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } }; // no EUR
    const subs: SubscriptionV2[] = [buildSub("USD", 1000, "Monthly"), buildSub("EUR", 1000, "Monthly")];
    expect(() => homeMonthlyTotal(subs, snapshot, "USD")).toThrow(MissingRateError);
  });

  it("unknown currency: a sub whose currency is not in the exponent table throws UnknownCurrencyError", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1", ZZZ: "1.5" } };
    const subs: SubscriptionV2[] = [buildSub("ZZZ", 1000, "Monthly")];
    expect(() => homeMonthlyTotal(subs, snapshot, "USD")).toThrow(UnknownCurrencyError);
  });

  it("empty set: totals to 0 and echoes asOf", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    expect(homeMonthlyTotal([], snapshot, "USD")).toEqual<HomeTotal>({ totalMinor: 0, asOf: "2026-10-02", homeCurrency: "USD" });
  });

  it("custom cycle without an interval throws InvalidCycleError (loud, never a silent skip)", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    const bad = buildSub("USD", 1000, "Custom"); // no customInterval
    expect(() => homeMonthlyTotal([bad], snapshot, "USD")).toThrow(InvalidCycleError);
  });

  it("overflow: a CYCLE_SCALE-scaled line beyond the safe-integer range throws AmountOverflowError (loud, not silent)", () => {
    // CYCLE_SCALE is 10^6; a Monthly USD line scales to amountMinor × 10^6.
    // 10^10 × 10^6 = 10^16, past Number.MAX_SAFE_INTEGER (~9.007e15) -> loud.
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    const huge = buildSub("USD", 10_000_000_000, "Monthly");
    expect(() => homeMonthlyTotal([huge], snapshot, "USD")).toThrow(AmountOverflowError);
  });

  it("negative amount: a sub with a negative amountMinor throws InvalidAmountError (same loud error as homeTotal)", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    const negative = buildSub("USD", -1, "Monthly");
    expect(() => homeMonthlyTotal([negative], snapshot, "USD")).toThrow(InvalidAmountError);
  });

  it("weekly cycle normalizes to its monthly share (×52/12) and does not raw-sum the weekly amount", () => {
    // $12.00/week -> monthly = 1200 × 52 / 12 = 5200 minor units ($52.00).
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1" } };
    const subs: SubscriptionV2[] = [buildSub("USD", 1200, "Weekly")];
    expect(homeMonthlyTotal(subs, snapshot, "USD").totalMinor).toBe(5200);
  });

  it("does not mutate its inputs", () => {
    const snapshot: RateSnapshot = { asOf: "2026-10-02", rates: { USD: "1", EUR: "1.08" } };
    const subs: SubscriptionV2[] = [buildSub("USD", 1000, "Monthly"), buildSub("EUR", 1000, "Yearly")];
    const snapshotJson = JSON.stringify(snapshot);
    const subsJson = JSON.stringify(subs);
    homeMonthlyTotal(subs, snapshot, "USD");
    homeYearlyTotal(subs, snapshot, "USD");
    expect(JSON.stringify(snapshot)).toBe(snapshotJson);
    expect(JSON.stringify(subs)).toBe(subsJson);
  });
});
