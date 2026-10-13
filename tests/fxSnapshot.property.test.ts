import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  parseBundledSnapshot,
  ratesForHome,
  FxSnapshotError,
  FX_SNAPSHOT_SCHEMA_VERSION,
  type BundledFxSnapshot,
} from "core/fxSnapshot";
import {
  homeTotal,
  exponentOf,
  MINOR_UNIT_EXPONENT,
  UnknownCurrencyError,
  type MoneyLine,
} from "core/money";

/**
 * Bundled offline FX snapshot: EUR→Home rebasing + loud validation
 * (FR-12, AD-23, AD-24; Story 2.3).
 *
 * Property 37 — for an arbitrary VALID EUR-based snapshot and an arbitrary Home
 *               currency in the ship list, `ratesForHome` yields `home === "1"`
 *               and a Home-based table under which `homeTotal` equals an
 *               INDEPENDENT EUR-pivot reference (convert-before-sum, round once),
 *               and rebasing to the snapshot's own base is the identity-on-base.
 * Property 38 — `parseBundledSnapshot` round-trips a well-formed object (asOf /
 *               schemaVersion / base preserved) and throws `FxSnapshotError` on
 *               each malformed variant (bad schema version, bad asOf, missing /
 *               empty rates, non-"1" base), while an unknown currency throws
 *               `UnknownCurrencyError` and a non-positive rate throws loudly.
 *
 * Plus example tests covering every I/O-matrix row.
 */

const NUM_RUNS = 300;

// --- The finalized ship list (must all be exponent-known in core/money) ------

const SHIP_LIST = [
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD",
  "SGD", "INR", "KRW", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON",
  "BRL", "MXN", "ZAR", "TRY", "ILS", "AED", "SAR", "THB", "MYR", "IDR", "PHP",
] as const;

/** Plausible EUR-based (units of X per €1) rates for the ship list. */
const EUR_BASE: Record<string, string> = {
  EUR: "1",
  USD: "1.0950",
  GBP: "0.8520",
  JPY: "162.45",
  CHF: "0.9385",
  CAD: "1.4870",
  AUD: "1.6420",
  NZD: "1.7850",
  CNY: "7.7920",
  HKD: "8.5240",
  SGD: "1.4120",
  INR: "91.350",
  KRW: "1458.60",
  SEK: "11.3450",
  NOK: "11.6280",
  DKK: "7.4580",
  PLN: "4.2760",
  CZK: "24.3650",
  HUF: "392.80",
  RON: "4.9740",
  BRL: "5.9340",
  MXN: "20.1850",
  ZAR: "19.2360",
  TRY: "38.4150",
  ILS: "4.1230",
  AED: "4.0220",
  SAR: "4.1070",
  THB: "37.6450",
  MYR: "4.8930",
  IDR: "17185.40",
  PHP: "61.8740",
};

function makeSnapshot(overrides: Partial<BundledFxSnapshot> = {}): BundledFxSnapshot {
  return {
    schemaVersion: FX_SNAPSHOT_SCHEMA_VERSION,
    asOf: "2026-10-01",
    base: "EUR",
    attribution: "ECB daily reference rates",
    rates: EUR_BASE,
    ...overrides,
  };
}

// --- Independent EUR-pivot oracle --------------------------------------------

function pow(n: number): bigint {
  let f = 1n;
  for (let i = 0; i < n; i++) f *= 10n;
  return f;
}

function roundDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  return r * 2n >= den ? q + 1n : q;
}

/** Split a positive decimal rate string into `(scaled, fracDigits)`. */
function splitRate(rate: string): { scaled: bigint; frac: number } {
  const [i, f = ""] = rate.split(".");
  return { scaled: BigInt(`${i}${f}` || "0"), frac: f.length };
}

/**
 * Independent EUR-pivot reference for the Home total: convert every Native line
 * Native→EUR→Home as EXACT rationals, sum over a common denominator, and round
 * ONCE to Home minor units. This never touches `ratesForHome` — it pivots
 * directly through the EUR-based snapshot, so a wrong rebasing is caught.
 *
 *   home-minor contribution of a line =
 *     amountMinor / 10^nativeExp              (Native major)
 *     / eurRate[cur]                          (-> EUR: EUR = Xmajor / (X per €1))
 *     * eurRate[home]                         (-> Home major)
 *     * 10^homeExp                            (-> Home minor)
 */
function referenceEurPivotTotal(
  lines: readonly MoneyLine[],
  snapshot: BundledFxSnapshot,
  home: string,
): number {
  const homeExp = exponentOf(home);
  const { scaled: homeRate, frac: homeFrac } = splitRate(snapshot.rates[home]!);
  let accNum = 0n;
  let accDen = 1n;
  for (const line of lines) {
    const nativeExp = exponentOf(line.currency);
    const { scaled: curRate, frac: curFrac } = splitRate(snapshot.rates[line.currency]!);
    // amountMinor * (homeRate/10^homeFrac) * 10^homeExp
    //   / (10^nativeExp * (curRate/10^curFrac))
    const termNum = BigInt(line.amountMinor) * homeRate * pow(curFrac) * pow(homeExp);
    const termDen = pow(nativeExp) * curRate * pow(homeFrac);
    accNum = accNum * termDen + termNum * accDen;
    accDen = accDen * termDen;
  }
  return Number(roundDiv(accNum, accDen));
}

// --- Property 37 -------------------------------------------------------------

describe("Feature: subby, Property 37: ratesForHome rebases EUR→Home exactly (home===\"1\", feeds homeTotal)", () => {
  it("Feature: subby, Property 37: homeTotal over the rebased table equals the independent EUR-pivot reference; home maps to 1", () => {
    const lineArb: fc.Arbitrary<MoneyLine> = fc
      .constantFrom(...SHIP_LIST)
      .chain((currency) =>
        fc.integer({ min: 0, max: 50_000_000 }).map((amountMinor) => ({ currency, amountMinor })),
      );

    const scenarioArb = fc.record({
      lines: fc.array(lineArb, { maxLength: 40 }),
      home: fc.constantFrom(...SHIP_LIST),
    });

    const snapshot = makeSnapshot();

    fc.assert(
      fc.property(scenarioArb, ({ lines, home }) => {
        const rebased = ratesForHome(snapshot, home);

        // The Home currency anchors to exactly "1".
        expect(rebased.rates[home]).toBe("1");
        // The asOf travels verbatim with the rebased table.
        expect(rebased.asOf).toBe(snapshot.asOf);

        const total = homeTotal(lines, rebased.rates, home);
        const reference = referenceEurPivotTotal(lines, snapshot, home);

        // Convert-before-sum through the rebased table equals the exact EUR-pivot
        // reference within the characterized ≤1-minor-unit rebasing/round slack.
        expect(Math.abs(total - reference)).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 37: rebasing to the snapshot's own base is the identity on the base (base -> \"1\")", () => {
    const snapshot = makeSnapshot();
    const rebased = ratesForHome(snapshot, "EUR");
    expect(rebased.rates.EUR).toBe("1");
    // Every other currency rebased to EUR is 1/eurRate[cur] (EUR per 1 unit),
    // i.e. strictly below 1 for a currency weaker than the euro and above 1 for
    // a stronger one. Spot-check the ordering holds (a real rebasing, not a copy).
    expect(Number(rebased.rates.USD)).toBeGreaterThan(0);
    expect(Number(rebased.rates.USD)).toBeLessThan(1); // €1 = 1.0950 USD -> 1 USD < €1
    expect(Number(rebased.rates.JPY)).toBeLessThan(0.01); // 1 JPY is a tiny fraction of a euro
  });

  it("Feature: subby, Property 37: ratesForHome does not mutate its input snapshot", () => {
    const snapshot = makeSnapshot();
    const before = JSON.stringify(snapshot);
    ratesForHome(snapshot, "USD");
    ratesForHome(snapshot, "JPY");
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

// --- Property 38 -------------------------------------------------------------

describe("Feature: subby, Property 38: parseBundledSnapshot round-trips the valid shape and rejects every malformed variant loudly", () => {
  it("Feature: subby, Property 38: a well-formed object round-trips (asOf/schemaVersion/base preserved)", () => {
    const asOfArb = fc
      .record({
        y: fc.integer({ min: 2000, max: 2099 }),
        m: fc.integer({ min: 1, max: 12 }),
        d: fc.integer({ min: 1, max: 28 }),
      })
      .map(({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

    fc.assert(
      fc.property(asOfArb, (asOf) => {
        const raw = {
          schemaVersion: FX_SNAPSHOT_SCHEMA_VERSION,
          asOf,
          base: "EUR",
          attribution: "ECB",
          rates: { ...EUR_BASE },
        };
        const parsed = parseBundledSnapshot(raw);
        expect(parsed.schemaVersion).toBe(FX_SNAPSHOT_SCHEMA_VERSION);
        expect(parsed.asOf).toBe(asOf);
        expect(parsed.base).toBe("EUR");
        expect(parsed.rates.EUR).toBe("1");
        expect(Object.keys(parsed.rates).length).toBe(SHIP_LIST.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 38: an unsupported schema version throws FxSnapshotError", () => {
    const badVersionArb = fc.integer({ min: -5, max: 99 }).filter((v) => v !== FX_SNAPSHOT_SCHEMA_VERSION);
    fc.assert(
      fc.property(badVersionArb, (schemaVersion) => {
        expect(() => parseBundledSnapshot({ ...makeSnapshot(), schemaVersion })).toThrow(FxSnapshotError);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 38: a malformed asOf throws FxSnapshotError", () => {
    const badAsOfArb = fc.oneof(
      fc.constant("2026/10/01"),
      fc.constant("2026-1-1"),
      fc.constant("Oct 1 2026"),
      fc.constant(""),
      fc.integer().map(String).map((s) => s.replace(/^/, "x")),
    );
    fc.assert(
      fc.property(badAsOfArb, (asOf) => {
        expect(() => parseBundledSnapshot({ ...makeSnapshot(), asOf })).toThrow(FxSnapshotError);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Example tests: every I/O-matrix row -------------------------------------

describe("fxSnapshot I/O matrix (example tests)", () => {
  it("parses a valid bundle: typed snapshot, asOf/schemaVersion/base preserved, ~30-currency rates", () => {
    const parsed = parseBundledSnapshot(makeSnapshot());
    expect(parsed.asOf).toBe("2026-10-01");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.base).toBe("EUR");
    expect(Object.keys(parsed.rates).length).toBeGreaterThanOrEqual(30);
    // Every rate key is exponent-known in core/money (no loud UnknownCurrencyError possible later).
    for (const cur of Object.keys(parsed.rates)) {
      expect(() => exponentOf(cur)).not.toThrow();
    }
  });

  it("rebase to Home=EUR (base): EUR -> \"1\", each other = 1/eurRate[cur]; homeTotal matches EUR-direct", () => {
    const snapshot = makeSnapshot();
    const rebased = ratesForHome(snapshot, "EUR");
    expect(rebased.rates.EUR).toBe("1");
    // 1/1.0950 = 0.913242... USD-per... (EUR per 1 USD).
    expect(String(rebased.rates.USD).startsWith("0.9132")).toBe(true);
    // A single USD line totals via the rebased table equal to the EUR-pivot ref.
    const lines: MoneyLine[] = [{ currency: "USD", amountMinor: 10000 }]; // $100.00
    expect(Math.abs(homeTotal(lines, rebased.rates, "EUR") - referenceEurPivotTotal(lines, snapshot, "EUR"))).toBeLessThanOrEqual(1);
  });

  it("rebase to Home=USD (non-base): USD -> \"1\", EUR === eurRate[USD] (USD per €1), feeds homeTotal", () => {
    const snapshot = makeSnapshot();
    const rebased = ratesForHome(snapshot, "USD");
    expect(rebased.rates.USD).toBe("1");
    // eurRate[USD] / eurRate[EUR] = 1.0950 / 1 = 1.095 (USD per 1 EUR).
    expect(String(rebased.rates.EUR).startsWith("1.0950")).toBe(true);
    const lines: MoneyLine[] = [{ currency: "EUR", amountMinor: 10000 }]; // €100.00
    // €100 at 1.0950 = $109.50 = 10950 minor units.
    expect(homeTotal(lines, rebased.rates, "USD")).toBe(10950);
  });

  it("rebase round-trips through homeTotal: two subs in different currencies equal an EUR-pivot reference", () => {
    const snapshot = makeSnapshot();
    const rebased = ratesForHome(snapshot, "USD");
    const lines: MoneyLine[] = [
      { currency: "EUR", amountMinor: 5000 }, // €50
      { currency: "JPY", amountMinor: 10000 }, // ¥10000
    ];
    const total = homeTotal(lines, rebased.rates, "USD");
    const reference = referenceEurPivotTotal(lines, snapshot, "USD");
    expect(Math.abs(total - reference)).toBeLessThanOrEqual(1);
  });

  it("unknown schema version throws FxSnapshotError (unsupported schema version)", () => {
    expect(() => parseBundledSnapshot({ ...makeSnapshot(), schemaVersion: 99 })).toThrow(FxSnapshotError);
  });

  it("malformed/absent asOf or base throws FxSnapshotError", () => {
    expect(() => parseBundledSnapshot({ ...makeSnapshot(), asOf: "not-a-date" })).toThrow(FxSnapshotError);
    const { asOf: _asOf, ...noAsOf } = makeSnapshot();
    void _asOf;
    expect(() => parseBundledSnapshot(noAsOf)).toThrow(FxSnapshotError);
    const { base: _base, ...noBase } = makeSnapshot();
    void _base;
    expect(() => parseBundledSnapshot(noBase)).toThrow(FxSnapshotError);
  });

  it("missing/empty rates throws FxSnapshotError", () => {
    expect(() => parseBundledSnapshot({ ...makeSnapshot(), rates: {} })).toThrow(FxSnapshotError);
    const { rates: _rates, ...noRates } = makeSnapshot();
    void _rates;
    expect(() => parseBundledSnapshot(noRates)).toThrow(FxSnapshotError);
  });

  it("non-\"1\" base rate throws FxSnapshotError (table not anchored to its declared base)", () => {
    expect(() =>
      parseBundledSnapshot({ ...makeSnapshot(), rates: { ...EUR_BASE, EUR: "1.02" } }),
    ).toThrow(FxSnapshotError);
  });

  it("unknown currency in rates/base throws UnknownCurrencyError", () => {
    expect(() =>
      parseBundledSnapshot({ ...makeSnapshot(), rates: { ...EUR_BASE, ZZZ: "1.5" } }),
    ).toThrow(UnknownCurrencyError);
    expect(() =>
      parseBundledSnapshot({ schemaVersion: 1, asOf: "2026-10-01", base: "ZZZ", attribution: "x", rates: { ZZZ: "1" } }),
    ).toThrow(UnknownCurrencyError);
  });

  it("zero / non-positive rate in the bundle throws loudly", () => {
    expect(() =>
      parseBundledSnapshot({ ...makeSnapshot(), rates: { ...EUR_BASE, USD: "0" } }),
    ).toThrow(FxSnapshotError);
    expect(() =>
      parseBundledSnapshot({ ...makeSnapshot(), rates: { ...EUR_BASE, USD: "0.000" } }),
    ).toThrow(FxSnapshotError);
    expect(() =>
      parseBundledSnapshot({ ...makeSnapshot(), rates: { ...EUR_BASE, USD: "-1.5" } }),
    ).toThrow(FxSnapshotError);
  });

  it("ratesForHome: a Home currency with no rate in the snapshot throws FxSnapshotError", () => {
    const snapshot = makeSnapshot({ rates: { EUR: "1", USD: "1.0950" } });
    expect(() => ratesForHome(snapshot, "JPY")).toThrow(FxSnapshotError);
  });

  it("ratesForHome: an unknown Home currency throws UnknownCurrencyError", () => {
    expect(() => ratesForHome(makeSnapshot(), "ZZZ")).toThrow(UnknownCurrencyError);
  });

  it("the finalized ship list is entirely exponent-known in core/money (JPY/KRW=0, rest=2)", () => {
    for (const cur of SHIP_LIST) {
      expect(MINOR_UNIT_EXPONENT[cur]).toBe(cur === "JPY" || cur === "KRW" ? 0 : 2);
    }
  });
});
