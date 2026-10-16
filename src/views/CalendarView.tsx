/**
 * Calendar view (task 23.1, Req 10.1–10.3), lazy-loaded by the app shell.
 *
 * A monthly calendar of subscription renewals. It reads the live subscription
 * list from the client store via `useStoreData` (a `useSyncExternalStore`
 * adapter), so it re-renders whenever subscription data changes after any
 * mutation — the store is reloaded on the `onDataChanged` broadcast.
 *
 * All date math + renewal indexing lives in the pure, unit-testable
 * `./calendarGrid` module (`buildMonthGrid`, `indexByRenewalDate`, …) so this
 * file stays a thin presentational shell and month-navigation recomputation can
 * be verified deterministically (task 23.2):
 *
 *   - The visible month is component state, defaulting to the current month.
 *   - `buildMonthGrid` produces a Sunday-first weeks × 7 grid with leading/
 *     trailing blanks for alignment.
 *   - `indexByRenewalDate` maps `YYYY-MM-DD` → renewing subscriptions; cells
 *     with ≥1 renewal show a count badge (Req 10.1).
 *   - Selecting a day opens a side panel listing that date's renewals — name,
 *     amount, billing cycle — plus a "Renewing {phrase}" urgency line (text,
 *     not color), or an empty state (Req 10.2, Story 6.2).
 *   - Prev/next navigation shifts the visible month and recomputes the grid +
 *     indicators (Req 10.3).
 *
 * Accessibility: the calendar is an ARIA `grid` with weekday `columnheader`s;
 * each day is a `button` with an aria-label naming the date, renewal count, and
 * (for days with renewals) the renewal urgency in TEXT (e.g. "in 3 days") so
 * assistive tech conveys how soon a renewal is without relying on color
 * (Story 6.2). It also carries `aria-pressed` for the selected day,
 * `aria-current="date"` for today, and a visible focus ring. This file MUST
 * keep a default export for `React.lazy`.
 */

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { SubscriptionV2 } from "core/models/subscription";
import { toMajor } from "core/money";
import { renewalUrgency } from "core/renewal";
import { subscriptionsStore } from "@/stores/subscriptionsStore";
import { useStoreData } from "@/stores/hooks";
import { cn } from "@/lib/utils";
import {
  addMonths,
  buildMonthGrid,
  currentYearMonth,
  indexByRenewalDate,
  monthLabel,
  todayISO,
  WEEKDAY_LABELS,
  type YearMonth,
} from "./calendarGrid";

/**
 * Shared focus-ring utility matching the rest of the app so every interactive
 * control has a visible, consistent keyboard focus indicator (Req 22.1, 22.3).
 */
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * Format a subscription's native amount (integer minor units) in its own
 * currency, falling back gracefully. The minor units are rendered to a major
 * display string via the money seam, then formatted.
 */
function formatCurrency(amountMinor: number, currency: string): string {
  const major = toMajor(amountMinor, currency);
  const amount = Number(major);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${major}`;
  }
}

/** Format an ISO `YYYY-MM-DD` date into a long, human-readable form. */
function formatLongDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Build the screen-reader label for a day cell (date + renewal count). For a
 * day that has renewals, append the urgency phrase in TEXT with the same
 * past/future sense the side panel carries — "due {phrase}" for upcoming
 * renewals ("…, 2 renewals, due in 3 days", "…, due today") and
 * "renewed {phrase}" for past ones ("…, 2 renewals, renewed 3 days ago") — so
 * the cell and panel wording align and a past renewal is never ambiguous
 * (happened vs due). Urgency is text, never color alone (Story 6.2, Req 10).
 * The cell's own date IS the renewal date, so one `renewalUrgency(iso, today)`
 * describes every renewal on that day. A malformed date yields an empty phrase,
 * so the label gracefully omits the urgency clause.
 */
function dayAriaLabel(iso: string, count: number, today: string): string {
  const date = formatLongDate(iso);
  if (count === 0) return `${date}, no renewals`;
  const { phrase, days } = renewalUrgency(iso, today);
  const base = `${date}, ${count} renewal${count === 1 ? "" : "s"}`;
  if (phrase === "") return base;
  const verb = days < 0 ? "renewed" : "due";
  return `${base}, ${verb} ${phrase}`;
}

/**
 * Side panel listing the subscriptions renewing on the selected date (Req 10.2),
 * with an empty state for dates that have no renewals and a prompt when nothing
 * is selected yet.
 */
function DayDetailPanel({
  selectedDate,
  subs,
  today,
}: {
  selectedDate: string | null;
  subs: SubscriptionV2[];
  today: string;
}): JSX.Element {
  // All rows in the panel share the selected date, so one urgency phrase
  // ("renews today" / "renews in 3 days" / "renewed 2 days ago") describes the
  // whole day. Text carries the urgency — color is never the sole signal.
  // `phrase === ""` means a malformed date; omit the line rather than render
  // an empty "Renewing".
  const urgency =
    selectedDate !== null && subs.length > 0
      ? renewalUrgency(selectedDate, today)
      : null;
  const showUrgency = urgency !== null && urgency.phrase !== "";
  return (
    <aside
      aria-label="Selected day renewals"
      className="rounded-lg border border-border bg-card p-4"
    >
      {selectedDate === null ? (
        <p className="text-sm text-muted-foreground">
          Select a date to see the subscriptions renewing that day.
        </p>
      ) : (
        <>
          <h3 className="text-sm font-semibold">{formatLongDate(selectedDate)}</h3>
          {showUrgency && (
            <p className="mt-1 text-xs text-muted-foreground">
              {urgency!.days < 0 ? "Renewed" : "Renewing"} {urgency!.phrase}
            </p>
          )}
          {subs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No renewals on this date.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-border">
              {subs.map((s) => (
                <li key={s.id} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{s.name}</span>
                    <span className="shrink-0 text-sm font-medium">
                      {formatCurrency(s.amountMinor, s.currency)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{s.billingCycle}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

/**
 * Calendar view (Req 10). Default export so the shell can `React.lazy`-import it.
 */
export default function CalendarView(): JSX.Element {
  const subscriptions = useStoreData(subscriptionsStore);

  // Visible month (Req 10.3) and the selected date (Req 10.2) are local state.
  const [view, setView] = useState<YearMonth>(() => currentYearMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const today = todayISO();

  // Renewal index keyed by `YYYY-MM-DD`; rebuilt only when the data changes.
  const renewalsByDate = useMemo(
    () => indexByRenewalDate(subscriptions),
    [subscriptions],
  );

  // Month grid; recomputed when navigating to a different month (Req 10.3).
  const weeks = useMemo(() => buildMonthGrid(view.year, view.month), [view]);

  // Subscriptions for the currently selected date (Req 10.2).
  const selectedSubs = useMemo(
    () => (selectedDate ? (renewalsByDate.get(selectedDate) ?? []) : []),
    [selectedDate, renewalsByDate],
  );

  function goToMonth(delta: number): void {
    setView((prev) => addMonths(prev, delta));
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CalendarDays className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          Calendar
        </h2>
        <p className="text-muted-foreground">
          Monthly view of your subscription renewals.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Calendar grid + month navigation. */}
        <section className="rounded-lg border border-border bg-card p-4">
          {/* Month navigation (Req 10.3). */}
          <div className="mb-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => goToMonth(-1)}
              aria-label="Previous month"
              className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-md border border-input hover:bg-secondary/60",
                focusRing,
              )}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <h3
              aria-live="polite"
              className="text-base font-semibold tracking-tight"
            >
              {monthLabel(view)}
            </h3>
            <button
              type="button"
              onClick={() => goToMonth(1)}
              aria-label="Next month"
              className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-md border border-input hover:bg-secondary/60",
                focusRing,
              )}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {/* Month grid (Req 10.1). */}
          <div role="grid" aria-label={`${monthLabel(view)} renewals`}>
            {/* Weekday headers. */}
            <div role="row" className="grid grid-cols-7">
              {WEEKDAY_LABELS.map((label) => (
                <div
                  key={label}
                  role="columnheader"
                  className="px-1 py-2 text-center text-xs font-medium text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>

            {/* Week rows. */}
            {weeks.map((week, weekIdx) => (
              <div role="row" key={weekIdx} className="grid grid-cols-7">
                {week.map((cell, cellIdx) => {
                  if (cell.date === null || cell.day === null) {
                    // Blank alignment cell (leading/trailing).
                    return (
                      <div
                        role="gridcell"
                        key={`blank-${weekIdx}-${cellIdx}`}
                        aria-hidden="true"
                        className="m-0.5 aspect-square"
                      />
                    );
                  }

                  const cellSubs = renewalsByDate.get(cell.date) ?? [];
                  const count = cellSubs.length;
                  const isToday = cell.date === today;
                  const isSelected = cell.date === selectedDate;

                  return (
                    <div role="gridcell" key={cell.date} className="m-0.5">
                      <button
                        type="button"
                        onClick={() => setSelectedDate(cell.date)}
                        aria-label={dayAriaLabel(cell.date, count, today)}
                        aria-pressed={isSelected}
                        aria-current={isToday ? "date" : undefined}
                        className={cn(
                          "flex aspect-square w-full flex-col items-center justify-start gap-1 rounded-md border p-1 text-sm transition-colors",
                          focusRing,
                          isSelected
                            ? "border-accent bg-accent/10"
                            : "border-border hover:bg-secondary/60",
                          isToday && !isSelected && "border-accent",
                        )}
                      >
                        <span
                          className={cn(
                            "leading-none",
                            isToday && "font-semibold text-foreground",
                          )}
                        >
                          {cell.day}
                        </span>
                        {count > 0 && (
                          <span
                            className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] font-semibold leading-4 text-accent-foreground"
                            aria-hidden="true"
                          >
                            {count}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>

        {/* Selected-day side panel (Req 10.2). */}
        <DayDetailPanel selectedDate={selectedDate} subs={selectedSubs} today={today} />
      </div>
    </div>
  );
}
