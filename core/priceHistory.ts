/**
 * Append-only price-history core (Story 5.3; AD-21).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`, and reads NO wall clock (AD-1) — an entry's `date` is supplied by the
 * caller (the renderer's local today), never read here. Every function is PURE:
 * it never mutates its inputs in place and it never reads the clock. Mirrors the
 * purity/docstring posture of `core/billing.ts` and `core/trial.ts`.
 *
 * Price history is the embedded, append-only timeline of the prices a
 * subscription has had (AD-21): `priceHistory: PriceEntryV2[]` lives directly on
 * the `SubscriptionV2` in `subscriptions.json` and is persisted through the
 * existing `subs:update` patch — there is no new IPC channel and no network
 * path. Two pure helpers:
 *   - {@link appendPriceEntry} answers "what does the history look like after
 *     recording this price?" — a new array with `entry` appended, append-only,
 *     order-preserving, de-duplicating an identical consecutive entry.
 *   - {@link priceChanged} answers "did the current amount actually change?" — a
 *     plain integer-minor-units equality check that gates whether a record is
 *     even offered at edit time.
 *
 * Ordering (the single documented convention the view relies on): the history is
 * a FORWARD log, oldest → newest. `appendPriceEntry` appends to the END, so the
 * LAST entry is the most recent price. Choosing the new amount dated today as
 * each entry (see the modal) makes "latest entry == current price" an invariant.
 * The read-only view REVERSES this for display (newest-first) — see
 * `src/components/PriceHistoryList.tsx`.
 */

import type { PriceEntryV2 } from "./models/subscription";

/**
 * Did the amount actually change? A pure integer-minor-units equality check
 * (AD-10: amounts at rest are integer minor units). Returns `true` IFF
 * `oldMinor !== newMinor`.
 *
 * This gates the opt-in record offer at edit time: a record is OFFERED only when
 * this returns `true`, and is NEVER made for an unchanged amount. Currency is not
 * considered here — the modal records in the sub's current currency, and a
 * same-amount edit is a no-op regardless.
 */
export function priceChanged(oldMinor: number, newMinor: number): boolean {
  return oldMinor !== newMinor;
}

/**
 * Return a NEW array with `entry` appended to `history` (append-only, AD-21).
 *
 * Append-only and non-mutating: the input `history` is never edited or
 * reordered; existing entries are preserved verbatim in their original order and
 * `entry` is added at the END (the forward-log convention — the last entry is the
 * most recent price). The input array is never mutated.
 *
 * De-dup of an identical CONSECUTIVE entry: if the last existing entry has the
 * SAME `amountMinor`, `currency`, AND `date` as `entry`, the history is returned
 * unchanged (a fresh copy) rather than carrying a duplicate — recording the exact
 * same price on the exact same day twice adds nothing. Only the immediately
 * preceding entry is compared; a later re-occurrence of an older price IS a
 * legitimate new entry (the price moved and came back) and is appended.
 */
export function appendPriceEntry(
  history: PriceEntryV2[],
  entry: PriceEntryV2,
): PriceEntryV2[] {
  const last = history[history.length - 1];
  if (
    last !== undefined &&
    last.amountMinor === entry.amountMinor &&
    last.currency === entry.currency &&
    last.date === entry.date
  ) {
    // Identical consecutive entry — no duplicate. Return a fresh copy so the
    // caller never shares a reference with the input (append-only + no-mutation).
    return [...history];
  }
  return [...history, entry];
}
