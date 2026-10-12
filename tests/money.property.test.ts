import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  minorUnits,
  toMajor,
  homeTotal,
  exponentOf,
  MINOR_UNIT_EXPONENT,
  UnknownCurrencyError,
  InvalidAmountError,
  AmountOverflowError,
  MissingRateError,
  type MoneyLine,
  type RateTable,
} from "core/money";

/**
 * Money core properties (AD-10 / AD-11).
 *
 * Property 24 — exponent-correct minor-unit round-trip (¥1000 <-> 1000, never 100000).
 * Property 25 — `homeTotal` converts before summing and equals the precise sum,
 *               never Σ of rounded rows.
 *
 * Plus example tests for every I/O-matrix row (round-trip, display conversion,
 * mixed-currency total, rounding discipline, error handling).
 */

const NUM_RUNS = 300;

// --- Generators --------------------------------------------------------------

/** Currencies the exponent table knows about, grouped by exponent. */
const CURRENCIES_BY_EXPONENT: Record<number, string[]> = { 0: [], 2: [], 3: [] };
for (const [currency, exponent] of Object.entries(MINOR_UNIT_EXPONENT)) {
  (CURRENCIES_BY_EXPONENT[exponent] ??= []).push(currency);
}
const ALL_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENT);

const knownCurrencyArb = fc.constantFrom(...ALL_CURRENCIES);

/**
 * A non-negative major amount string with at most `exponent` fractional digits,
 * i.e. an amount that is exactly representable in the currency's minor units.
 */
function majorAmountArb(exponent: number) {
  return fc
    .record({
      whole: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      frac: fc.string({ unit: fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"), maxLength: exponent }),
    })
    .map(({ whole, frac }) => (exponent === 0 || frac === "" ? whole.toString() : `${whole}.${frac}`));
}

// --- Property 24: exponent-correct round-trip --------------------------------

describe("Feature: subby, Property 24: minor-unit round-trip is value-exact and exponent-correct", () => {
  it("Feature: subby, Property 24: minorUnits then toMajor is the identity (value-exact) for every known currency", () => {
    const roundTripArb = knownCurrencyArb.chain((currency) =>
      majorAmountArb(exponentOf(currency)).map((major) => ({ currency, major })),
    );

    fc.assert(
      fc.property(roundTripArb, ({ currency, major }) => {
        const exponent = exponentOf(currency);
        const minor = minorUnits(major, currency);
        // Minor units are an exponent-correct integer scaling of the major amount.
        expect(Number.isInteger(minor)).toBe(true);
        // Round-tripping back yields the canonical (zero-padded) major string.
        const back = toMajor(minor, currency);
        const expected = exponent === 0 ? major : canonicalMajor(major, exponent);
        expect(back).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 24: a 0-exponent currency never scales up (¥1000 -> 1000, not 100000)", () => {
    const jpyArb = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((n) => n.toString());
    fc.assert(
      fc.property(jpyArb, (major) => {
        const minor = minorUnits(major, "JPY");
        // JPY exponent is 0 -> minor units equal the major value exactly.
        expect(minor.toString()).toBe(BigInt(major).toString());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** Reference canonical major string: pad/truncate the fractional part exactly. */
function canonicalMajor(major: string, exponent: number): string {
  const [whole, frac = ""] = major.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  return `${normalizedWhole}.${frac.padEnd(exponent, "0").slice(0, exponent)}`;
}

// --- Property 27: inverse round-trip (minor -> major -> minor) ---------------

describe("Feature: subby, Property 27: toMajor then minorUnits recovers the exact minor-unit integer", () => {
  it("Feature: subby, Property 27: minorUnits(toMajor(m, c), c) === m for every known currency", () => {
    // m stays well within the safe-integer range so the round-trip is lossless.
    const inverseArb = knownCurrencyArb.chain((currency) =>
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map((minor) => ({ currency, minor })),
    );

    fc.assert(
      fc.property(inverseArb, ({ currency, minor }) => {
        const major = toMajor(minor, currency);
        expect(minorUnits(major, currency)).toBe(minor);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 25: convert-before-sum, round once -----------------------------

describe("Feature: subby, Property 25: homeTotal converts before summing and equals the precise sum", () => {
  // Home = USD; rates are Native-major -> Home-major.
  const RATES: RateTable = {
    USD: "1",
    EUR: "1.085",
    INR: "0.012",
    JPY: "0.0067",
    GBP: "1.27",
    KWD: "3.25",
  };
  const RATE_CURRENCIES = Object.keys(RATES);

  /** A line whose currency is one of the rated currencies. */
  const ratedLineArb: fc.Arbitrary<MoneyLine> = fc
    .constantFrom(...RATE_CURRENCIES)
    .chain((currency) =>
      fc.integer({ min: 0, max: 50_000_000 }).map((amountMinor) => ({ currency, amountMinor })),
    );

  it("Feature: subby, Property 25: homeTotal equals the single-pass precise sum regardless of per-row rounding", () => {
    fc.assert(
      fc.property(fc.array(ratedLineArb, { maxLength: 60 }), (lines) => {
        const total = homeTotal(lines, RATES, "USD");

        // Reference: accumulate every line at full precision, round once at the end.
        const reference = referenceHomeTotal(lines, RATES, "USD");
        expect(total).toBe(reference);

        // And it is NOT the (wrong) Σ-of-rounded-rows for round-sensitive inputs,
        // which is asserted explicitly in the example tests below.
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 25: a line's own currency is never summed raw across unlike currencies", () => {
    // Two lines of equal minor units but different currencies must not total to
    // 2× one line unless their rates happen to be equal — i.e. conversion happened.
    const pairArb = fc
      .record({
        a: fc.constantFrom("EUR", "JPY", "INR", "GBP", "KWD"),
        b: fc.constantFrom("EUR", "JPY", "INR", "GBP", "KWD"),
        amount: fc.integer({ min: 1, max: 10_000_000 }),
      })
      .filter(({ a, b }) => a !== b);

    fc.assert(
      fc.property(pairArb, ({ a, b, amount }) => {
        const total = homeTotal([{ currency: a, amountMinor: amount }, { currency: b, amountMinor: amount }], RATES, "USD");
        const ref = referenceHomeTotal(
          [{ currency: a, amountMinor: amount }, { currency: b, amountMinor: amount }],
          RATES,
          "USD",
        );
        expect(total).toBe(ref);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/**
 * Independent reference implementation of the precise home total using JS
 * BigInt directly (mirrors the documented formula) — if the two agree over
 * hundreds of random inputs, the production path rounds exactly once.
 */
function referenceHomeTotal(lines: readonly MoneyLine[], rates: RateTable, home: string): number {
  const homeExponent = exponentOf(home);
  const guard = 10n ** 6n;
  const pow = (n: number) => 10n ** BigInt(n);
  let acc = 0n;
  for (const line of lines) {
    const nativeExp = exponentOf(line.currency);
    const rate = String((rates as Record<string, string | number>)[line.currency]);
    const [ri, rf = ""] = rate.split(".");
    const rateScaled = BigInt(`${ri}${rf}` || "0");
    const num = BigInt(line.amountMinor) * rateScaled * pow(homeExponent) * guard;
    const den = pow(nativeExp) * pow(rf.length);
    acc += roundDiv(num, den);
  }
  return Number(roundDiv(acc, guard));
}

function roundDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  return r * 2n >= den ? q + 1n : q;
}

// --- Example tests: every I/O-matrix row -------------------------------------

describe("money I/O matrix (example tests)", () => {
  it("minor-unit round-trip: USD and JPY are exponent-correct", () => {
    expect(minorUnits("10.00", "USD")).toBe(1000);
    expect(minorUnits("1000", "JPY")).toBe(1000); // NOT 100000
    expect(minorUnits("1.500", "KWD")).toBe(1500); // 3-exponent currency
  });

  it("minor-unit round-trip: invalid / negative / NaN major is rejected", () => {
    expect(() => minorUnits("-1.00", "USD")).toThrow(InvalidAmountError);
    expect(() => minorUnits(Number.NaN, "USD")).toThrow(InvalidAmountError);
    expect(() => minorUnits("abc", "USD")).toThrow(InvalidAmountError);
    // Negative zero is still zero -> allowed.
    expect(minorUnits("-0.00", "USD")).toBe(0);
    // More fractional digits than the currency supports is rejected.
    expect(() => minorUnits("1.001", "USD")).toThrow(InvalidAmountError);
  });

  it("display conversion: toMajor renders the correct exponent", () => {
    expect(toMajor(1000, "JPY")).toBe("1000");
    expect(toMajor(1000, "USD")).toBe("10.00");
    expect(toMajor(1500, "KWD")).toBe("1.500");
    expect(toMajor(5, "USD")).toBe("0.05");
  });

  it("display / parse: unknown currency errors, never a silent exponent-2 default", () => {
    expect(() => minorUnits("10.00", "ZZZ")).toThrow(UnknownCurrencyError);
    expect(() => toMajor(1000, "ZZZ")).toThrow(UnknownCurrencyError);
    expect(() => exponentOf("ZZZ")).toThrow(UnknownCurrencyError);
  });

  it("home total, mixed currencies: one Home-currency sum, converted before summing", () => {
    // Home = USD. $10 + €10 (@1.08) + ₹1000 (@0.012).
    const lines: MoneyLine[] = [
      { currency: "USD", amountMinor: 1000 }, // $10.00
      { currency: "EUR", amountMinor: 1000 }, // €10.00 -> $10.80
      { currency: "INR", amountMinor: 100000 }, // ₹1000.00 -> $12.00
    ];
    const rates: RateTable = { USD: "1", EUR: "1.08", INR: "0.012" };
    const total = homeTotal(lines, rates, "USD");
    // 1000 + 1080 + 1200 = 3280 minor units = $32.80.
    expect(total).toBe(3280);
    expect(toMajor(total, "USD")).toBe("32.80");
  });

  it("home total: a missing rate for a line errors, never a raw sum", () => {
    const lines: MoneyLine[] = [
      { currency: "USD", amountMinor: 1000 },
      { currency: "EUR", amountMinor: 1000 },
    ];
    const rates: RateTable = { USD: "1" }; // no EUR rate
    expect(() => homeTotal(lines, rates, "USD")).toThrow(MissingRateError);
  });

  it("rounding discipline: homeTotal equals the precise sum, NOT Σ of rounded rows (golden)", () => {
    // Three lines whose per-row Home values each have a sub-cent remainder that
    // rounds DOWN individually but carries UP when summed precisely.
    // Rate 0.333 for a 3-of-them INR-like currency.
    const rates: RateTable = { USD: "1", EUR: "0.3334" };
    const lines: MoneyLine[] = [
      { currency: "EUR", amountMinor: 100 }, // €1.00 -> $0.3334 -> rounds to $0.33
      { currency: "EUR", amountMinor: 100 }, // $0.33
      { currency: "EUR", amountMinor: 100 }, // $0.33
    ];

    // Σ of rounded rows: toMajor each converted-and-rounded row, then re-sum.
    const roundedRows = lines.map((l) => {
      const single = homeTotal([l], rates, "USD"); // 33 minor units each
      return single;
    });
    const sumOfRounded = roundedRows.reduce((a, b) => a + b, 0); // 33+33+33 = 99

    // Precise total: 3 × 0.3334 = 1.0002 -> rounds to $1.00 = 100 minor units.
    const precise = homeTotal(lines, rates, "USD");

    expect(sumOfRounded).toBe(99); // the WRONG, re-summed-rounded answer
    expect(precise).toBe(100); // the RIGHT, round-once answer
    expect(precise).not.toBe(sumOfRounded); // the rule this test guards
  });

  it("home total: empty lines total to zero", () => {
    expect(homeTotal([], { USD: "1" }, "USD")).toBe(0);
  });

  it("home total: a negative line amountMinor is rejected (AD-10 non-negative at rest)", () => {
    expect(() => homeTotal([{ currency: "USD", amountMinor: -1 }], { USD: "1" }, "USD")).toThrow(InvalidAmountError);
  });

  it("overflow: a minor-unit result beyond MAX_SAFE_INTEGER throws instead of returning a lossy number", () => {
    // 10^16 is above Number.MAX_SAFE_INTEGER (~9.007e15); as 2-exponent major it
    // would need 10^18 minor units, both beyond the safe range.
    const huge = "1".padEnd(17, "0"); // 1e16
    expect(() => minorUnits(huge, "JPY")).toThrow(AmountOverflowError);

    const lines: MoneyLine[] = [{ currency: "JPY", amountMinor: Number.MAX_SAFE_INTEGER }];
    // Converting at a rate > 1 pushes the home total past the safe range.
    expect(() => homeTotal(lines, { USD: "2", JPY: "2" }, "USD")).toThrow(AmountOverflowError);
  });
});
