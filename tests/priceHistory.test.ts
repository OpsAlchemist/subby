import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { appendPriceEntry, priceChanged } from "core/priceHistory";
import { priceEntrySchema } from "core/models/schema";
import type { PriceEntryV2 } from "core/models/subscription";

/**
 * Append-only price history (Story 5.3; AD-21).
 *
 * Property + example tests for the two pure helpers in `core/priceHistory.ts`:
 *   - `priceChanged` is a plain integer-minor-units inequality check.
 *   - `appendPriceEntry` returns a NEW array with the entry appended (forward
 *     log, oldest → newest), never mutating the input, preserving order, and
 *     de-duplicating an identical CONSECUTIVE entry (same amount+currency+date).
 *
 * Each `fc.assert` runs at least 100 iterations.
 */

const NUM_RUNS = 300;

// --- Arbitraries -------------------------------------------------------------

/**
 * ISO `YYYY-MM-DD` dates in a stable range, built directly from integer
 * year/month/day components (never via `fc.date().toISOString()`, which can emit
 * an Invalid Date at range edges and throw a RangeError). Days are capped at 28
 * so every (year, month, day) triple is a real calendar date in any month.
 */
const isoDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2100 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );

/** Non-negative integer minor units (the money-at-rest shape, AD-10). */
const minorArb = fc.integer({ min: 0, max: 10_000_000 });

/** A currency string the schema accepts (`min(1)`); a few realistic codes. */
const currencyArb = fc.constantFrom("USD", "EUR", "GBP", "INR", "JPY");

/** A schema-valid price entry. */
const entryArb: fc.Arbitrary<PriceEntryV2> = fc.record({
  amountMinor: minorArb,
  currency: currencyArb,
  date: isoDateArb,
});

// --- priceChanged ------------------------------------------------------------

describe("priceChanged (Story 5.3)", () => {
  it("true when the amount differs, false when identical (examples)", () => {
    expect(priceChanged(1000, 1200)).toBe(true);
    expect(priceChanged(1000, 1000)).toBe(false);
    expect(priceChanged(0, 1)).toBe(true);
    expect(priceChanged(0, 0)).toBe(false);
  });

  it("is exactly integer inequality (property)", () => {
    fc.assert(
      fc.property(minorArb, minorArb, (a, b) => {
        expect(priceChanged(a, b)).toBe(a !== b);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is always false for equal values (property)", () => {
    fc.assert(
      fc.property(minorArb, (a) => {
        expect(priceChanged(a, a)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- appendPriceEntry --------------------------------------------------------

describe("appendPriceEntry (Story 5.3)", () => {
  it("appends to an empty history (example)", () => {
    const entry: PriceEntryV2 = {
      amountMinor: 1200,
      currency: "USD",
      date: "2026-10-15",
    };
    expect(appendPriceEntry([], entry)).toEqual([entry]);
  });

  it("appends B after A at the END, forward-log order (example)", () => {
    const a: PriceEntryV2 = { amountMinor: 1000, currency: "USD", date: "2026-01-01" };
    const b: PriceEntryV2 = { amountMinor: 1200, currency: "USD", date: "2026-10-15" };
    expect(appendPriceEntry([a], b)).toEqual([a, b]);
  });

  it("never mutates the input array (example)", () => {
    const a: PriceEntryV2 = { amountMinor: 1000, currency: "USD", date: "2026-01-01" };
    const b: PriceEntryV2 = { amountMinor: 1200, currency: "USD", date: "2026-10-15" };
    const input = [a];
    const result = appendPriceEntry(input, b);
    // Input unchanged (still just [A]); the result is a different array.
    expect(input).toEqual([a]);
    expect(input).toHaveLength(1);
    expect(result).not.toBe(input);
  });

  it("skips an identical CONSECUTIVE entry (same amount+currency+date) (example)", () => {
    const a: PriceEntryV2 = { amountMinor: 1000, currency: "USD", date: "2026-01-01" };
    const input = [a];
    const result = appendPriceEntry(input, { ...a });
    expect(result).toEqual([a]);
    expect(result).toHaveLength(1);
    // A fresh array (not the same reference as the actual input), and the input
    // is left unchanged.
    expect(result).not.toBe(input);
    expect(input).toEqual([a]);
    expect(input).toHaveLength(1);
  });

  it("appends when any of amount/currency/date differs from the last (examples)", () => {
    const a: PriceEntryV2 = { amountMinor: 1000, currency: "USD", date: "2026-01-01" };
    // Different amount.
    expect(appendPriceEntry([a], { ...a, amountMinor: 1001 })).toHaveLength(2);
    // Different currency.
    expect(appendPriceEntry([a], { ...a, currency: "EUR" })).toHaveLength(2);
    // Different date.
    expect(appendPriceEntry([a], { ...a, date: "2026-01-02" })).toHaveLength(2);
  });

  it("appends a RE-occurrence of an older price when it is not consecutive (example)", () => {
    // The de-dup only compares the immediately-preceding entry. A price that
    // moved and came back is a legitimate new entry.
    const a: PriceEntryV2 = { amountMinor: 1000, currency: "USD", date: "2026-01-01" };
    const b: PriceEntryV2 = { amountMinor: 1200, currency: "USD", date: "2026-06-01" };
    const aAgain: PriceEntryV2 = { amountMinor: 1000, currency: "USD", date: "2026-12-01" };
    expect(appendPriceEntry([a, b], aAgain)).toEqual([a, b, aAgain]);
  });

  it("is append-only, order-preserving, non-mutating; the entry is last (property)", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 20 }), entryArb, (history, entry) => {
        const snapshot = history.map((e) => ({ ...e }));
        const result = appendPriceEntry(history, entry);

        // The input is never mutated.
        expect(history).toEqual(snapshot);
        // A new array is always returned.
        expect(result).not.toBe(history);

        const last = history[history.length - 1];
        const isConsecutiveDup =
          last !== undefined &&
          last.amountMinor === entry.amountMinor &&
          last.currency === entry.currency &&
          last.date === entry.date;

        if (isConsecutiveDup) {
          // De-dup: history unchanged (content-wise).
          expect(result).toEqual(history);
        } else {
          // Appended at the end; every prior entry preserved in order.
          expect(result).toHaveLength(history.length + 1);
          expect(result.slice(0, history.length)).toEqual(history);
          expect(result[result.length - 1]).toEqual(entry);
        }
        // Append-only: the result is never SHORTER than the input (nothing dropped).
        expect(result.length).toBeGreaterThanOrEqual(history.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("every appended entry round-trips through priceEntrySchema (property)", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 10 }), entryArb, (history, entry) => {
        const result = appendPriceEntry(history, entry);
        for (const e of result) {
          expect(priceEntrySchema.safeParse(e).success).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("repeated identical appends never grow the history past one (property)", () => {
    fc.assert(
      fc.property(entryArb, fc.integer({ min: 1, max: 10 }), (entry, times) => {
        let history: PriceEntryV2[] = [];
        for (let i = 0; i < times; i++) {
          history = appendPriceEntry(history, { ...entry });
        }
        // First append lands; every identical consecutive re-append is a no-op.
        expect(history).toEqual([entry]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
