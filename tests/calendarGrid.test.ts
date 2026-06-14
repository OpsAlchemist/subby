import { describe, it, expect } from "vitest";

import {
  addMonths,
  buildMonthGrid,
  daysInMonth,
  firstWeekdayOfMonth,
  indexByRenewalDate,
  monthLabel,
  toISODate,
  type YearMonth,
} from "../src/views/calendarGrid";
import type { Subscription } from "core/models/subscription";

/**
 * Unit tests for Calendar month navigation (task 23.2, Req 10.3).
 *
 * The Calendar view keeps a `{ year, month }` "visible month" in state and
 * derives the rendered grid + renewal indicators from it. Navigation works by
 * shifting that state with `addMonths` and rebuilding the grid; indicators come
 * from looking up each in-month cell's ISO date in the renewal index. These
 * helpers are pure and DOM-free, so the recomputation semantics can be verified
 * directly (no jsdom needed).
 */

// --- Fixtures ----------------------------------------------------------------

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: overrides.id ?? `sub-${Math.random()}`,
    name: "Service",
    provider: "Provider",
    category: "Entertainment",
    amount: 100,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-01-01",
    startDate: "2024-01-01",
    paymentMethod: "card",
    website: "",
    notes: "",
    color: "#000000",
    icon: "box",
    isActive: true,
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Mirror of how `CalendarView` derives the set of dates that should show a
 * renewal indicator for a given visible month: the in-month cells whose ISO
 * date appears in the renewal index. Returns a Set of `YYYY-MM-DD` strings.
 */
function indicatorDatesFor(
  visible: YearMonth,
  index: Map<string, Subscription[]>,
): Set<string> {
  const grid = buildMonthGrid(visible.year, visible.month);
  const dates = new Set<string>();
  for (const week of grid) {
    for (const cell of week) {
      if (cell.inMonth && cell.date && index.has(cell.date)) {
        dates.add(cell.date);
      }
    }
  }
  return dates;
}

// --- addMonths normalization (Req 10.3) --------------------------------------

describe("addMonths normalizes across year boundaries (Req 10.3)", () => {
  it("steps back from January into the previous December", () => {
    expect(addMonths({ year: 2025, month: 0 }, -1)).toEqual({
      year: 2024,
      month: 11,
    });
  });

  it("steps forward from December into the next January", () => {
    expect(addMonths({ year: 2025, month: 11 }, 1)).toEqual({
      year: 2026,
      month: 0,
    });
  });

  it("handles large positive deltas spanning multiple years", () => {
    // 25 months after Jan 2025 = Feb 2027.
    expect(addMonths({ year: 2025, month: 0 }, 25)).toEqual({
      year: 2027,
      month: 1,
    });
  });

  it("handles large negative deltas spanning multiple years", () => {
    // 13 months before Jan 2025 = Dec 2023.
    expect(addMonths({ year: 2025, month: 0 }, -13)).toEqual({
      year: 2023,
      month: 11,
    });
  });

  it("is the identity for a zero delta", () => {
    expect(addMonths({ year: 2025, month: 5 }, 0)).toEqual({
      year: 2025,
      month: 5,
    });
  });

  it("round-trips: forward then back returns the original month", () => {
    const start: YearMonth = { year: 2025, month: 0 };
    expect(addMonths(addMonths(start, 7), -7)).toEqual(start);
  });
});

// --- buildMonthGrid structure (Req 10.1, supports 10.3) ----------------------

describe("buildMonthGrid covers the month exactly (Req 10.1)", () => {
  it("February 2025 starts on Saturday and has 28 days", () => {
    const year = 2025;
    const month = 1; // February (0-indexed)
    expect(firstWeekdayOfMonth(year, month)).toBe(6); // Saturday
    expect(daysInMonth(year, month)).toBe(28);

    const grid = buildMonthGrid(year, month);

    // Every week has exactly 7 cells.
    for (const week of grid) {
      expect(week).toHaveLength(7);
    }

    // Leading blanks equal the first weekday.
    const flat = grid.flat();
    const leadingBlanks = flat.findIndex((c) => c.inMonth);
    expect(leadingBlanks).toBe(firstWeekdayOfMonth(year, month));

    // In-month cells exactly cover days 1..daysInMonth with correct ISO dates.
    const inMonth = flat.filter((c) => c.inMonth);
    expect(inMonth.map((c) => c.day)).toEqual(
      Array.from({ length: 28 }, (_, i) => i + 1),
    );
    expect(inMonth.map((c) => c.date)).toEqual(
      Array.from({ length: 28 }, (_, i) => toISODate(year, month, i + 1)),
    );
    expect(inMonth[0].date).toBe("2025-02-01");
    expect(inMonth[27].date).toBe("2025-02-28");
  });

  it("February 2024 is a leap month with 29 days", () => {
    const year = 2024;
    const month = 1; // February
    expect(daysInMonth(year, month)).toBe(29);

    const grid = buildMonthGrid(year, month);
    const inMonth = grid.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[28].date).toBe("2024-02-29");

    // Leading blanks still match the first weekday (Thursday = 4).
    expect(firstWeekdayOfMonth(year, month)).toBe(4);
    const leadingBlanks = grid.flat().findIndex((c) => c.inMonth);
    expect(leadingBlanks).toBe(4);
  });

  it("blank cells carry no date or day and are flagged out-of-month", () => {
    const grid = buildMonthGrid(2025, 1); // Feb 2025
    for (const cell of grid.flat()) {
      if (!cell.inMonth) {
        expect(cell.date).toBeNull();
        expect(cell.day).toBeNull();
      }
    }
  });
});

// --- Recomputation semantics: indicators follow the visible month (Req 10.3) -

describe("renewal indicators recompute with the visible month (Req 10.3)", () => {
  // Renewals spread across two adjacent months, plus one outside both.
  const subs = [
    sub({ id: "jan-5", nextRenewal: "2025-01-05" }),
    sub({ id: "jan-5b", nextRenewal: "2025-01-05" }), // same date as jan-5
    sub({ id: "jan-20", nextRenewal: "2025-01-20" }),
    sub({ id: "feb-10", nextRenewal: "2025-02-10" }),
    sub({ id: "feb-28", nextRenewal: "2025-02-28" }),
    sub({ id: "mar-01", nextRenewal: "2025-03-01" }),
  ];
  const index = indexByRenewalDate(subs);

  const january: YearMonth = { year: 2025, month: 0 };
  const february = addMonths(january, 1);

  it("indexByRenewalDate buckets subscriptions by date", () => {
    expect(index.get("2025-01-05")!.map((s) => s.id)).toEqual([
      "jan-5",
      "jan-5b",
    ]);
    expect(index.get("2025-01-20")!.map((s) => s.id)).toEqual(["jan-20"]);
    expect(index.get("2025-02-10")!.map((s) => s.id)).toEqual(["feb-10"]);
  });

  it("January's indicator set is exactly January's renewal dates", () => {
    expect(indicatorDatesFor(january, index)).toEqual(
      new Set(["2025-01-05", "2025-01-20"]),
    );
  });

  it("navigating to February surfaces a different indicator set", () => {
    const janDates = indicatorDatesFor(january, index);
    const febDates = indicatorDatesFor(february, index);

    expect(febDates).toEqual(new Set(["2025-02-10", "2025-02-28"]));
    // The visible-month change actually changes the indicator set.
    expect(febDates).not.toEqual(janDates);
  });

  it("indicators never leak renewals from adjacent months into the grid", () => {
    // March renewal must not appear while February is visible, and February's
    // renewals must not appear while January is visible.
    expect(indicatorDatesFor(february, index).has("2025-03-01")).toBe(false);
    expect(indicatorDatesFor(january, index).has("2025-02-10")).toBe(false);
  });

  it("a month with no renewals has an empty indicator set", () => {
    // April 2025 has none of the fixture renewals.
    expect(indicatorDatesFor({ year: 2025, month: 3 }, index).size).toBe(0);
  });
});

// --- monthLabel formatting ---------------------------------------------------

describe("monthLabel formats the visible month (Req 10.3)", () => {
  it("formats month 2 (March) as 'March 2025'", () => {
    expect(monthLabel({ year: 2025, month: 2 })).toBe("March 2025");
  });

  it("formats January and December correctly", () => {
    expect(monthLabel({ year: 2025, month: 0 })).toBe("January 2025");
    expect(monthLabel({ year: 2024, month: 11 })).toBe("December 2024");
  });

  it("tracks the label after navigation across a year boundary", () => {
    const prev = addMonths({ year: 2025, month: 0 }, -1);
    expect(monthLabel(prev)).toBe("December 2024");
  });
});
