/**
 * The shared stale-rate affordance (Story 2.4 / AD-12), used by every
 * total-showing surface (Dashboard, Analytics) so they present the SAME honest
 * treatment on stale rates.
 *
 * When the bundled FX snapshot is stale (older than 90 days with FX refresh
 * off — the `core/money.rateConfidence` verdict), a surface must NOT present a
 * confident single converted total. It surfaces THIS note instead: a focusable,
 * text-labelled "these rates are about N months old" element conveying the age
 * in TEXT (not color alone). There is no FX-refresh action until Epic 8, so this
 * is a non-interactive, focusable `role="note"` — NOT a button that does nothing.
 *
 * This component owns only the affordance markup. The caller decides WHEN to
 * render it (i.e. only when `confidence === "stale"` and rates are available)
 * and supplies the already-computed age in whole months plus the snapshot's
 * `asOf` date (formatted by the caller) — this stays a pure presentational
 * component that reads no wall clock.
 */

import { AlertTriangle } from "lucide-react";

export default function StaleRateNote({
  months,
  asOf,
}: {
  /** Whole completed months the snapshot is behind today (`core/money.monthsStale`). */
  months: number;
  /** The snapshot's `asOf` date, ALREADY formatted for display by the caller. */
  asOf: string;
}): JSX.Element {
  // `monthsStale` floors to COMPLETED months while `rateConfidence` is day-based,
  // so a snapshot just past the ~91-day stale boundary can floor to 0 months.
  // Clamp to a minimum of 1 so the note never reads "about 0 months old".
  const display = Math.max(1, months);
  return (
    <div
      role="note"
      tabIndex={0}
      className="flex w-full items-start gap-2 rounded-lg border border-border bg-card p-3 text-left text-sm"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span>
        These exchange rates are about{" "}
        {display === 1 ? "1 month" : `${display} months`} old (as of {asOf}).
        Converted totals may be out of date.
      </span>
    </div>
  );
}
