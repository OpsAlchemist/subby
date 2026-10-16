import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { addDays, daysBetween, renewalUrgency } from "core/renewal";

/**
 * Tests for the pure renewal-urgency helper (Story 6.2, Req 10).
 *
 * `renewalUrgency(renewalDate, today)` turns a `(renewalDate, today)` pair into
 * a plain-text relative phrase ("today" / "tomorrow" / "in N days" / "yesterday"
 * / "N days ago") plus the signed whole-day difference `today → renewalDate`.
 * The Calendar threads this phrase into the day-cell `aria-label` and the side
 * panel so urgency is conveyed in TEXT, never color alone.
 *
 * The helper is pure (AD-1): `today` is injected, there is no wall-clock read,
 * and the signed day count reuses the UTC-correct `daysBetween` arithmetic. The
 * property test uses `addDays` as the independent reference so the day sign and
 * magnitude are checked against the production day shift, not re-derived here.
 */

// --- Example cases: the I/O & edge-case matrix -------------------------------

describe("renewalUrgency example cases (Req 10, Story 6.2)", () => {
  const today = "2026-10-16";

  it("renewal == today → 'today', days 0", () => {
    expect(renewalUrgency(today, today)).toEqual({ phrase: "today", days: 0 });
  });

  it("renewal == today + 1 → 'tomorrow', days 1", () => {
    expect(renewalUrgency("2026-10-17", today)).toEqual({
      phrase: "tomorrow",
      days: 1,
    });
  });

  it("renewal == today + 3 → 'in 3 days', days 3", () => {
    expect(renewalUrgency("2026-10-19", today)).toEqual({
      phrase: "in 3 days",
      days: 3,
    });
  });

  it("renewal == today - 1 → 'yesterday', days -1", () => {
    expect(renewalUrgency("2026-10-15", today)).toEqual({
      phrase: "yesterday",
      days: -1,
    });
  });

  it("renewal == today - 2 → '2 days ago', days -2", () => {
    expect(renewalUrgency("2026-10-14", today)).toEqual({
      phrase: "2 days ago",
      days: -2,
    });
  });

  it("a malformed/empty date yields an empty phrase (never 'NaN days ago')", () => {
    // Unparseable inputs make the day arithmetic NaN; the guard must suppress
    // the "NaN days ago" literal and return an empty phrase instead.
    for (const bad of ["", "not-a-date", "garbage"]) {
      const u = renewalUrgency(bad, today);
      expect(u.phrase).toBe("");
      expect(Number.isNaN(u.days)).toBe(true);
    }
    // Malformed `today` is handled the same way.
    const u2 = renewalUrgency("2026-10-19", "");
    expect(u2.phrase).toBe("");
    expect(Number.isNaN(u2.days)).toBe(true);
  });
});

// --- daysBetween: signed, whole-day magnitude --------------------------------

describe("daysBetween signed whole-day difference", () => {
  it("is positive when `to` is later, negative when earlier, zero when equal", () => {
    expect(daysBetween("2026-10-16", "2026-10-19")).toBe(3);
    expect(daysBetween("2026-10-19", "2026-10-16")).toBe(-3);
    expect(daysBetween("2026-10-16", "2026-10-16")).toBe(0);
  });

  it("counts whole days across month and leap-year boundaries", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // leap year
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });
});

// --- Boundary & arithmetic correctness ---------------------------------------

describe("renewalUrgency boundaries & UTC arithmetic (Req 10)", () => {
  it("crosses a month boundary correctly (future)", () => {
    // Oct 31 → Nov 2 is 2 days.
    expect(renewalUrgency("2026-11-02", "2026-10-31")).toEqual({
      phrase: "in 2 days",
      days: 2,
    });
  });

  it("crosses a month boundary correctly (past)", () => {
    // today Nov 1, renewal Oct 30 → 2 days ago.
    expect(renewalUrgency("2026-10-30", "2026-11-01")).toEqual({
      phrase: "2 days ago",
      days: -2,
    });
  });

  it("spans a leap-day correctly", () => {
    // 2024 is a leap year: Feb 28 → Mar 1 is 2 days (via Feb 29).
    expect(renewalUrgency("2024-03-01", "2024-02-28")).toEqual({
      phrase: "in 2 days",
      days: 2,
    });
  });

  it("crosses a year boundary correctly", () => {
    expect(renewalUrgency("2027-01-01", "2026-12-31")).toEqual({
      phrase: "tomorrow",
      days: 1,
    });
  });
});

// --- Property: signed days + phrase are consistent for any offset ------------

describe("renewalUrgency properties (Req 10)", () => {
  const NUM_RUNS = 300;

  /** A YYYY-MM-DD "today" and an integer day offset to the renewal. */
  const todayArb = fc
    .record({
      year: fc.integer({ min: 2000, max: 2100 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map(
      ({ year, month, day }) =>
        `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
          day,
        ).padStart(2, "0")}`,
    );
  const offsetArb = fc.integer({ min: -1000, max: 1000 });

  it("`days` equals the signed offset today → renewalDate (matches addDays)", () => {
    fc.assert(
      fc.property(todayArb, offsetArb, (today, offset) => {
        const renewal = addDays(today, offset);
        const { days } = renewalUrgency(renewal, today);
        expect(days).toBe(offset);
        // And it agrees with the standalone daysBetween helper.
        expect(days).toBe(daysBetween(today, renewal));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("the phrase is consistent with the signed days (never color-dependent)", () => {
    fc.assert(
      fc.property(todayArb, offsetArb, (today, offset) => {
        const renewal = addDays(today, offset);
        const { phrase, days } = renewalUrgency(renewal, today);
        if (days === 0) expect(phrase).toBe("today");
        else if (days === 1) expect(phrase).toBe("tomorrow");
        else if (days === -1) expect(phrase).toBe("yesterday");
        else if (days > 1) expect(phrase).toBe(`in ${days} days`);
        else expect(phrase).toBe(`${-days} days ago`);
        // The phrase is always non-empty text — urgency carried in words.
        expect(phrase.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("is pure: same inputs always yield the same output (no wall clock)", () => {
    fc.assert(
      fc.property(todayArb, offsetArb, (today, offset) => {
        const renewal = addDays(today, offset);
        expect(renewalUrgency(renewal, today)).toEqual(
          renewalUrgency(renewal, today),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
