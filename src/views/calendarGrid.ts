/**
 * Pure, platform-independent calendar helpers for the Calendar view (task 23.1,
 * Req 10.1–10.3).
 *
 * These functions contain all the date math and renewal-indexing logic so the
 * `CalendarView` component stays a thin presentational shell and the logic can
 * be unit-tested deterministically (task 23.2) without a DOM.
 *
 * Date handling matches the platform-independent `core/` convention: dates are
 * the raw `YYYY-MM-DD` strings stored on `Subscription.nextRenewal`, and all
 * comparison/indexing is done by string equality. Grid construction derives
 * calendar positions from integer year/month/day arithmetic (using `Date.UTC`
 * only for day-count/weekday derivation) so it is free of local-timezone drift.
 *
 * Months are **0-indexed** here (January = 0, December = 11), matching the JS
 * `Date.getMonth()` convention used by callers.
 */

import type { Subscription } from "core/models/subscription";

/** A single cell in the month grid. */
export interface MonthGridCell {
  /** `YYYY-MM-DD` for a real day, or `null` for a leading/trailing blank. */
  date: string | null;
  /** Day-of-month number (1–31), or `null` for a blank alignment cell. */
  day: number | null;
  /** Whether this cell belongs to the rendered month (false for blanks). */
  inMonth: boolean;
}

/** A month grid: an array of weeks, each a fixed array of 7 cells (Sun→Sat). */
export type MonthGrid = MonthGridCell[][];

/** Weekday header labels, Sunday-first to match {@link buildMonthGrid}. */
export const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Full month names for labels/aria text, indexed by 0-based month. */
export const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Zero-pad a number to two digits (`5` → `"05"`). */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format integer Y/M/D parts into a `YYYY-MM-DD` string. `month` is 0-indexed.
 * Pure string assembly — never touches the local timezone.
 */
export function toISODate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Number of days in a 0-indexed month (handles leap years via `Date.UTC`). */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Weekday (0 = Sunday … 6 = Saturday) of the first day of a 0-indexed month. */
export function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 1)).getUTCDay();
}

/**
 * A `{ year, month }` pair with a 0-indexed month. Used for the visible-month
 * state and month navigation.
 */
export interface YearMonth {
  year: number;
  /** 0-indexed month (January = 0). */
  month: number;
}

/**
 * Shift a `{ year, month }` by `delta` months, normalizing across year
 * boundaries (e.g. `addMonths({2025, 0}, -1)` → `{2024, 11}`). Pure; used by the
 * prev/next month navigation so indicators recompute for the new month
 * (Req 10.3).
 */
export function addMonths({ year, month }: YearMonth, delta: number): YearMonth {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** Human-readable label for a visible month, e.g. `"March 2025"`. */
export function monthLabel({ year, month }: YearMonth): string {
  return `${MONTH_LABELS[month]} ${year}`;
}

/**
 * Build a Sunday-first month grid (weeks × 7) for a 0-indexed `month`,
 * including leading/trailing blank cells so each week is exactly 7 cells and the
 * real days line up under the correct weekday headers (Req 10.1).
 *
 * Deterministic and timezone-independent: the returned date strings are derived
 * purely from the integer Y/M/D arguments.
 */
export function buildMonthGrid(year: number, month: number): MonthGrid {
  const leading = firstWeekdayOfMonth(year, month);
  const total = daysInMonth(year, month);

  const cells: MonthGridCell[] = [];

  // Leading blanks to push day 1 under its weekday column.
  for (let i = 0; i < leading; i += 1) {
    cells.push({ date: null, day: null, inMonth: false });
  }

  // Real days of the month.
  for (let day = 1; day <= total; day += 1) {
    cells.push({ date: toISODate(year, month, day), day, inMonth: true });
  }

  // Trailing blanks to complete the final week.
  while (cells.length % 7 !== 0) {
    cells.push({ date: null, day: null, inMonth: false });
  }

  // Chunk the flat list into weeks of 7.
  const weeks: MonthGrid = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

/**
 * Index subscriptions by their `nextRenewal` date (`YYYY-MM-DD`), returning a
 * map from date string to the subscriptions renewing on that date (Req 10.1,
 * 10.2). Insertion order within each bucket follows the input order. The map is
 * built once over all subscriptions; the view looks up indicators/lists by the
 * cell's date string, so navigating months reuses the same map (Req 10.3).
 */
export function indexByRenewalDate(
  subs: Subscription[],
): Map<string, Subscription[]> {
  const map = new Map<string, Subscription[]>();
  for (const sub of subs) {
    const key = sub.nextRenewal;
    const bucket = map.get(key);
    if (bucket) bucket.push(sub);
    else map.set(key, [sub]);
  }
  return map;
}

/** Today's date as a local-calendar `YYYY-MM-DD` string (for the "today" cell). */
export function todayISO(): string {
  const now = new Date();
  return toISODate(now.getFullYear(), now.getMonth(), now.getDate());
}

/** The `{ year, month }` of the current local month (default visible month). */
export function currentYearMonth(): YearMonth {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}
