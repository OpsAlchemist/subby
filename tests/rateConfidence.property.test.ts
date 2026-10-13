import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  rateConfidence,
  monthsStale,
  FX_STALE_DAYS,
  InvalidDateError,
  type RateConfidence,
} from "core/money";

/**
 * Stale-rate guard predicate (AD-12; Story 2.4).
 *
 * Property 39 — for an arbitrary valid `today`, an arbitrary non-negative
 *               day-offset `d`, and an arbitrary `fxRefreshOn`,
 *               `rateConfidence(today−d, today, fxRefreshOn) === "stale"` IFF
 *               (`d > FX_STALE_DAYS` AND `!fxRefreshOn`), else `"confident"`; the
 *               predicate is a PURE total function (same inputs -> same output),
 *               and flipping ONLY `fxRefreshOn` flips the verdict exactly when
 *               `d > FX_STALE_DAYS`. The run includes the 89/90/91 boundary
 *               offsets so the strictly-`>90` edge is exercised, not just sampled.
 *
 * Plus example tests covering every I/O-matrix row (89/90/91 both refresh states,
 * future-dated, same-day, `monthsStale` known spans, and `InvalidDateError` on a
 * malformed `asOf` and a malformed `today`).
 */

const NUM_RUNS = 300;

// --- Independent-oracle date helper (UTC epoch-day, no production import) -----

/** Shift a `YYYY-MM-DD` string by `deltaDays` using an independent UTC path. */
function shiftISO(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  const dt = new Date(ms);
  const yyyy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// --- Generators --------------------------------------------------------------

/** An arbitrary valid `today` well inside the Date range (avoids year < 1000). */
const todayArb = fc
  .date({ min: new Date(Date.UTC(2000, 0, 1)), max: new Date(Date.UTC(2100, 11, 31)) })
  .map((d) => {
    const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

/**
 * A non-negative day offset biased to hit the 89/90/91 boundary (and 0) often,
 * so the strictly-`>FX_STALE_DAYS` edge is exercised on nearly every run rather
 * than only sampled from a wide uniform range.
 */
const offsetArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 88, 89, 90, 91, 92, 180) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 4000 }) },
);

// --- Property 39: the single-threshold staleness verdict ---------------------

describe("Feature: subby, Property 39: rateConfidence is stale IFF age > FX_STALE_DAYS and refresh off; pure and boundary-exact", () => {
  it("Feature: subby, Property 39: verdict matches the (d > FX_STALE_DAYS && !refresh) oracle and is a pure total function", () => {
    fc.assert(
      fc.property(todayArb, offsetArb, fc.boolean(), (today, d, fxRefreshOn) => {
        const asOf = shiftISO(today, -d); // snapshot d days BEFORE today
        const expected: RateConfidence = d > FX_STALE_DAYS && !fxRefreshOn ? "stale" : "confident";

        const verdict = rateConfidence(asOf, today, fxRefreshOn);
        expect(verdict).toBe(expected);

        // Purity: same inputs -> same output (no wall-clock, no state).
        expect(rateConfidence(asOf, today, fxRefreshOn)).toBe(verdict);

        // Flipping ONLY fxRefreshOn flips the verdict exactly when d > threshold.
        const flipped = rateConfidence(asOf, today, !fxRefreshOn);
        if (d > FX_STALE_DAYS) {
          expect(flipped).not.toBe(verdict);
        } else {
          expect(flipped).toBe("confident");
          expect(verdict).toBe("confident");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 39: a future-dated snapshot (negative age) is always confident", () => {
    fc.assert(
      fc.property(todayArb, fc.integer({ min: 1, max: 4000 }), fc.boolean(), (today, ahead, fxRefreshOn) => {
        const asOf = shiftISO(today, ahead); // snapshot AFTER today
        expect(rateConfidence(asOf, today, fxRefreshOn)).toBe("confident");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 39: changing only snapshotAsOf re-derives the verdict (fresher confident, staler stale)", () => {
    // Fixed today and refresh-off; two offsets straddling the 90-day boundary.
    // A fresher snapshot (<=90 days) is confident; a staler one (>90) is stale —
    // the verdict tracks the changed snapshotAsOf, with nothing else varying.
    const fresherArb = fc.integer({ min: 0, max: FX_STALE_DAYS }); // <= 90 -> confident
    const stalerArb = fc.integer({ min: FX_STALE_DAYS + 1, max: 4000 }); // > 90 -> stale
    fc.assert(
      fc.property(todayArb, fresherArb, stalerArb, (today, fresher, staler) => {
        const fresherAsOf = shiftISO(today, -fresher);
        const stalerAsOf = shiftISO(today, -staler);
        expect(rateConfidence(fresherAsOf, today, false)).toBe("confident");
        expect(rateConfidence(stalerAsOf, today, false)).toBe("stale");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 39: monthsStale is a non-negative floored whole-month count, 0 when newer-or-equal", () => {
    fc.assert(
      fc.property(todayArb, offsetArb, (today, d) => {
        const asOf = shiftISO(today, -d);
        const n = monthsStale(asOf, today);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        // A d-day span is at most ceil(d / 28) months and at least floor(d / 31).
        expect(n).toBeLessThanOrEqual(Math.ceil(d / 28));
        expect(n).toBeGreaterThanOrEqual(Math.floor(d / 31));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Example tests: every I/O-matrix row -------------------------------------

describe("stale-rate guard I/O matrix (example tests)", () => {
  it("the 90-day threshold is a single exported constant", () => {
    expect(FX_STALE_DAYS).toBe(90);
  });

  it("fresh snapshot, refresh off -> confident", () => {
    // asOf 10 days before today.
    expect(rateConfidence("2026-10-01", "2026-10-11", false)).toBe("confident");
  });

  it("old snapshot, refresh on -> confident (refresh overrides age)", () => {
    // asOf 200 days before today.
    expect(rateConfidence("2026-03-20", "2026-10-06", true)).toBe("confident");
  });

  it("old snapshot, refresh off -> stale", () => {
    // asOf 200 days before today.
    expect(rateConfidence("2026-03-20", "2026-10-06", false)).toBe("stale");
  });

  it("boundary: exactly 89 days, refresh off -> confident", () => {
    expect(rateConfidence("2026-07-04", "2026-10-01", false)).toBe("confident"); // 89 days
  });

  it("boundary: exactly 90 days, refresh off -> confident (strictly >90 is stale)", () => {
    expect(rateConfidence("2026-07-03", "2026-10-01", false)).toBe("confident"); // 90 days
  });

  it("boundary: exactly 91 days, refresh off -> stale", () => {
    expect(rateConfidence("2026-07-02", "2026-10-01", false)).toBe("stale"); // 91 days
  });

  it("boundary: 89/90/91 are stable under both refresh states", () => {
    // Refresh ON keeps all three confident; refresh OFF stales only >90.
    expect(rateConfidence("2026-07-04", "2026-10-01", true)).toBe("confident"); // 89, on
    expect(rateConfidence("2026-07-03", "2026-10-01", true)).toBe("confident"); // 90, on
    expect(rateConfidence("2026-07-02", "2026-10-01", true)).toBe("confident"); // 91, on
    expect(rateConfidence("2026-07-04", "2026-10-01", false)).toBe("confident"); // 89, off
    expect(rateConfidence("2026-07-03", "2026-10-01", false)).toBe("confident"); // 90, off
    expect(rateConfidence("2026-07-02", "2026-10-01", false)).toBe("stale"); // 91, off
  });

  it("future-dated snapshot -> confident (negative age)", () => {
    expect(rateConfidence("2026-10-05", "2026-10-01", false)).toBe("confident");
    expect(rateConfidence("2027-01-01", "2026-10-01", false)).toBe("confident");
  });

  it("same day -> confident (age 0)", () => {
    expect(rateConfidence("2026-10-01", "2026-10-01", false)).toBe("confident");
    expect(rateConfidence("2026-10-01", "2026-10-01", true)).toBe("confident");
  });

  it("golden examples from the spec", () => {
    expect(rateConfidence("2026-07-01", "2026-10-01", false)).toBe("stale"); // 92 days
    expect(rateConfidence("2026-07-03", "2026-10-01", false)).toBe("confident"); // 90 exactly
    expect(rateConfidence("2026-07-02", "2026-10-01", false)).toBe("stale"); // 91 days
    expect(rateConfidence("2026-01-01", "2026-10-01", true)).toBe("confident"); // 273 days, refresh on
    expect(rateConfidence("2026-10-05", "2026-10-01", false)).toBe("confident"); // future
  });

  it("monthsStale: known spans floor to completed months", () => {
    expect(monthsStale("2026-07-01", "2026-10-01")).toBe(3); // 3 whole months
    expect(monthsStale("2026-01-15", "2026-10-15")).toBe(9); // exactly 9 months
    expect(monthsStale("2026-01-15", "2026-10-14")).toBe(8); // one day short of the 9th
    expect(monthsStale("2026-01-15", "2026-10-16")).toBe(9); // one day past the 9th
    expect(monthsStale("2025-10-01", "2026-10-01")).toBe(12); // one year
  });

  it("monthsStale: newer-or-equal / future snapshot -> 0", () => {
    expect(monthsStale("2026-10-01", "2026-10-01")).toBe(0); // same day
    expect(monthsStale("2026-10-01", "2026-10-20")).toBe(0); // same month, 19 days
    expect(monthsStale("2026-12-01", "2026-10-01")).toBe(0); // future-dated snapshot
  });

  it("malformed date -> throws InvalidDateError (never a silent confident)", () => {
    // Malformed asOf.
    expect(() => rateConfidence("2026-13-99", "2026-10-01", false)).toThrow(InvalidDateError);
    expect(() => rateConfidence("not-a-date", "2026-10-01", false)).toThrow(InvalidDateError);
    expect(() => rateConfidence("2026-02-30", "2026-10-01", false)).toThrow(InvalidDateError); // Feb 30 non-real
    // Malformed today.
    expect(() => rateConfidence("2026-10-01", "2026-00-10", false)).toThrow(InvalidDateError);
    expect(() => rateConfidence("2026-10-01", "20261001", false)).toThrow(InvalidDateError);
    // monthsStale is equally loud on malformed input.
    expect(() => monthsStale("2026-13-01", "2026-10-01")).toThrow(InvalidDateError);
    expect(() => monthsStale("2026-10-01", "bad")).toThrow(InvalidDateError);
  });
});
