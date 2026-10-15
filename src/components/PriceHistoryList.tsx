/**
 * PriceHistoryList — read-only per-subscription price history view
 * (Story 5.3; AD-21).
 *
 * Renders a subscription's append-only `priceHistory` (AD-21) as a labelled,
 * READ-ONLY list: each entry's date + money (money-formatted via the money seam
 * / an `Intl` currency formatter, tabular-nums). There are deliberately NO
 * edit/delete controls — the history is append-only and is never edited or
 * removed from the UI (deleting the subscription removes its history with it).
 *
 * Ordering: the stored `priceHistory` is a FORWARD log, oldest → newest (see
 * `core/priceHistory.ts`). This view reverses it for display so the most recent
 * price is at the TOP (newest-first), which reads as "here is the latest price,
 * and here is what it was before".
 *
 * Empty state: a sub with no recorded price changes shows a sensible, muted
 * empty line ("No price changes recorded") rather than a bare empty list.
 *
 * Accessibility: a labelled region with an `<ol>` whose accessible name names the
 * list; each row is plain text (no interactive control), so the whole surface is
 * keyboard-inert and axe-clean. Money uses `tabular-nums` so figures align.
 */

import { toMajor } from "core/money";
import type { PriceEntryV2 } from "core/models/subscription";

export interface PriceHistoryListProps {
  /** The subscription's append-only price history (forward log, oldest → newest). */
  history: PriceEntryV2[];
}

/**
 * Format an entry's native amount (integer minor units) in its own currency,
 * mirroring the List view's `formatCurrency`: render minor units to a major
 * string via the money seam, then format with `Intl.NumberFormat`, falling back
 * to a plain `CUR major` string when the currency is unknown to `Intl` so a
 * read never crashes.
 */
function formatEntryMoney(amountMinor: number, currency: string): string {
  let major: string;
  try {
    major = toMajor(amountMinor, currency);
  } catch {
    // Unknown-to-the-money-seam currency: render the raw integer so the view
    // still shows something rather than throwing (defensive; create/migrate
    // only persist money-seam-known currencies).
    major = String(amountMinor);
  }
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

/** Read-only price-history list. See the module docstring. */
export default function PriceHistoryList({
  history,
}: PriceHistoryListProps): JSX.Element {
  // Newest-first for display (the stored log is oldest → newest).
  const rows = [...history].reverse();

  return (
    <section aria-label="Price history" className="space-y-1.5">
      <h3 className="text-sm font-medium text-foreground">Price history</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No price changes recorded.
        </p>
      ) : (
        <ol
          aria-label="Recorded price changes, newest first"
          className="divide-y divide-border rounded-md border border-border"
        >
          {rows.map((entry, index) => (
            <li
              // The stored history is append-only, so an entry's position in the
              // oldest→newest log is a stable key for this read-only render.
              key={`${history.length - 1 - index}-${entry.date}-${entry.amountMinor}`}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <span className="text-muted-foreground tabular-nums">
                {entry.date}
              </span>
              <span className="font-medium text-foreground tabular-nums">
                {formatEntryMoney(entry.amountMinor, entry.currency)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
