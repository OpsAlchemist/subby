/**
 * Pure v2 subscription construction and per-sub Native-Currency setter
 * (FR-10, AD-10, AD-17, AD-21).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`, and reads no wall-clock or filesystem (AD-1). Every function here is
 * PURE:
 *   - it never mutates its inputs in place (arrays/objects are copied), and
 *   - it never reads the wall clock; callers pass `now` for determinism.
 *
 * This is the Story 2.1 behavior that makes "Native Currency per subscription"
 * real: a subscription keeps its OWN currency so a EUR sub shows and persists
 * in EUR regardless of the user's Home Currency (FR-10). Two operations:
 *   - {@link createSubscriptionV2} applies the "Native Currency defaults to
 *     Home Currency when unspecified" rule and parses the user-entered major
 *     amount into Native-Currency integer minor units.
 *   - {@link setNativeCurrency} sets the Native Currency independently per
 *     subscription, re-expressing the stored amount's major value into the new
 *     currency's minor units.
 *
 * Every currency decision routes through `core/money.ts` (the single money
 * seam): an unknown currency throws {@link UnknownCurrencyError} — never a
 * silent exponent-2 default. As of Story 3.3 this module IS the live write path:
 * `SubscriptionV2` flows through the StoragePort, `appWiring`, and the IPC spine
 * to the renderer, and these mutators back the `subs:*` handlers. The v1-typed
 * `core/subscriptions.ts` is retained only as the mirror reference for these
 * mutators and no longer has any live caller.
 */

import { exponentOf, minorUnits, toMajor } from "core/money";
import { roundHalfUpToExponent } from "core/migrations/v1_to_v2";
import type {
  SubscriptionState,
  SubscriptionV2,
} from "core/models/subscription";

/**
 * Fields a caller supplies when creating a v2 subscription. The user enters a
 * major-unit amount (`amountMajor`, a decimal string or number) which core
 * parses into integer minor units, and MAY supply an explicit Native
 * `currency`; when omitted the created sub defaults to the Home Currency.
 *
 * System-managed fields (`id`, `createdAt`, `updatedAt`) and the derived
 * `amountMinor` are assigned by core and so are omitted here. Defined locally —
 * the v1 IPC `SubscriptionInput` in `shared/types.ts` is a different (v1) shape
 * and is left untouched.
 */
export type SubscriptionInputV2 = Omit<
  SubscriptionV2,
  "id" | "amountMinor" | "createdAt" | "updatedAt" | "currency"
> & {
  amountMajor: string | number; // user-entered major-unit amount
  currency?: string; // optional Native Currency; defaults to Home Currency
};

/**
 * Generate a unique identifier for a new subscription (uuid v4).
 *
 * Uses the `crypto.randomUUID` global so `core/` stays free of a `uuid`
 * dependency and free of platform imports (mirrors v1 `core/subscriptions.ts`).
 */
function newId(): string {
  return crypto.randomUUID();
}

/**
 * Append a new v2 subscription built from `input`, returning a new array (the
 * `existing` array is never mutated) (FR-10, Req 3.1).
 *
 * The Native Currency defaults to `homeCurrency` when `input.currency` is
 * absent, and an explicitly supplied currency is kept verbatim. The entered
 * major amount is parsed into integer minor units in the resolved Native
 * Currency via `minorUnits` — so ¥1000 stores as `1000` (exponent 0), not
 * `100000`. The created subscription gets a fresh id and
 * `createdAt === updatedAt === now`; `priceHistory`/`tags` default to safe
 * empties when the caller omits them.
 *
 * Throws {@link UnknownCurrencyError} on an unknown currency and
 * {@link InvalidAmountError} on an over-precise or otherwise invalid amount —
 * both surfaced by the money seam before the record is constructed, so an
 * invalid value never reaches storage.
 */
export function createSubscriptionV2(
  existing: SubscriptionV2[],
  input: SubscriptionInputV2,
  homeCurrency: string,
  now: string,
): SubscriptionV2[] {
  // Default-to-Home rule: an unspecified Native Currency becomes the Home
  // Currency; an explicit one is kept verbatim (FR-10).
  const currency = input.currency ?? homeCurrency;

  // Route through the money seam: parse the entered major amount into integer
  // minor units for the resolved Native Currency. Throws on an unknown
  // currency (never a silent exponent-2 default) or an over-precise amount.
  const amountMinor = minorUnits(input.amountMajor, currency);

  // Omit `amountMajor` and the optional input `currency` from the carried-over
  // fields; the resolved `currency` and derived `amountMinor` are set below.
  const { amountMajor: _amountMajor, currency: _inputCurrency, ...rest } = input;

  const created: SubscriptionV2 = {
    ...rest,
    id: newId(),
    amountMinor,
    currency,
    // Default new-record collections to safe empties when the caller omits them
    // (mirrors the migrator's `priceHistory: []`, `tags: []`).
    priceHistory: rest.priceHistory ?? [],
    tags: rest.tags ?? [],
    createdAt: now,
    updatedAt: now, // createdAt === updatedAt on creation (Req 3.1)
  };

  return [...existing, created];
}

/**
 * Set the Native `currency` on the subscription with the matching `id` and
 * advance its `updatedAt` to `now`, returning a new array (FR-10). Only the
 * target subscription changes; non-matching subs and the input array are left
 * untouched. If no subscription matches `id`, a new array with identical
 * contents is returned (a no-op).
 *
 * The amount's **major value** is preserved across the currency change — not
 * the raw minor-unit integer. Switching USD→JPY must NOT reinterpret 1000
 * USD-cents ($10.00) as ¥1000; it re-expresses $10.00's major value (10) into
 * the target currency's minor units. The re-expression renders the stored
 * amount back to its major string via `toMajor`, rounds that major value
 * half-up to the TARGET currency's exponent (reusing the migrator's pure,
 * already-tested {@link roundHalfUpToExponent} so a cross-exponent change —
 * e.g. a 3-exponent source to a 0-exponent target — never drops a fractional
 * minor unit silently nor throws a spurious over-precision error), then parses
 * it back through `minorUnits` in the new currency.
 *
 * Throws {@link UnknownCurrencyError} on an unknown target currency (validated
 * via `exponentOf` through the money seam) — the loud guard against an unknown
 * currency.
 */
export function setNativeCurrency(
  existing: SubscriptionV2[],
  id: string,
  currency: string,
  now: string,
): SubscriptionV2[] {
  // Validate the target currency up front so an unknown currency throws loudly
  // regardless of whether any subscription matches `id`.
  const targetExponent = exponentOf(currency);

  return existing.map((s) => {
    if (s.id !== id) return s;

    // Preserve the amount's MAJOR value across the currency change: render the
    // stored minor units back to the source currency's major string, round
    // that major value half-up to the target exponent (so a cross-exponent
    // change never over-precisions), then re-parse into the target currency's
    // minor units through the money seam.
    const sourceMajor = toMajor(s.amountMinor, s.currency);
    const roundedMajor = roundHalfUpToExponent(Number(sourceMajor), targetExponent);
    const amountMinor = minorUnits(roundedMajor, currency);

    return { ...s, currency, amountMinor, updatedAt: now };
  });
}

// --- v2 mutations (live cutover; mirror core/subscriptions.ts) ---------------
// These are the missing live mutators Story 3.3 wires into the IPC spine. Each
// mirrors the pure, no-wall-clock contract of the v1 `core/subscriptions.ts`
// helper it replaces: the input array is never mutated, and `now` is injected.

/**
 * Fields a caller may change on an existing v2 subscription. System-managed
 * fields (`id`, `createdAt`, `updatedAt`) are excluded: `id`/`createdAt` are
 * immutable after creation, and `updatedAt` is advanced by
 * {@link editSubscriptionV2}. `amountMinor` is a derived field at rest, so it is
 * patchable here only by a caller that has already parsed a major amount through
 * the money seam (the modal does this); the eligibility/currency re-expression
 * paths own their own setters.
 */
export type SubscriptionPatchV2 = Partial<
  Omit<SubscriptionV2, "id" | "createdAt" | "updatedAt">
>;

/**
 * Apply `patch` to the subscription with the matching `id` and set its
 * `updatedAt` to `now`, returning a new array (Req 3.2, 9.7). Mirrors v1
 * `editSubscription`.
 *
 * Non-matching subscriptions are returned unchanged, and `id`/`createdAt` are
 * always preserved (the patch type excludes them). If no subscription matches
 * `id`, the list is returned with the same contents (a fresh array).
 */
export function editSubscriptionV2(
  existing: SubscriptionV2[],
  id: string,
  patch: SubscriptionPatchV2,
  now: string,
): SubscriptionV2[] {
  return existing.map((s) =>
    s.id === id ? { ...s, ...patch, updatedAt: now } : s,
  );
}

/**
 * Set the three-way `state` on the subscription with the matching `id` and
 * advance its `updatedAt` to `now`, returning a new array (Req 3.7, AD-17).
 * Replaces v1's boolean `toggleActive`.
 *
 * Only the target subscription changes; non-matching subs and the input array
 * are left untouched. An unknown `id` yields a new array with identical
 * contents (a no-op). This setter is intentionally narrow — it does NOT add or
 * remove the embedded `trial` block; a transition to/from `Trial` with its trial
 * fields flows through {@link editSubscriptionV2} from the modal, which carries
 * the whole v2 patch so the schema invariant (`trial` present iff
 * `state === "Trial"`) is honored at validation time.
 */
export function setSubscriptionState(
  existing: SubscriptionV2[],
  id: string,
  state: SubscriptionState,
  now: string,
): SubscriptionV2[] {
  return existing.map((s) =>
    s.id === id ? { ...s, state, updatedAt: now } : s,
  );
}

/**
 * Remove exactly the subscription with the matching `id`, returning a new array
 * (Req 3.3). Mirrors v1 `deleteSubscription`: other subscriptions are preserved
 * in their original order and the input array is never mutated.
 */
export function deleteSubscriptionV2(
  existing: SubscriptionV2[],
  id: string,
): SubscriptionV2[] {
  return existing.filter((s) => s.id !== id);
}

// --- v2 eligibility predicates and selectors (the single state seam) ---------
// The one place the Active/Trial/Paused rules live (AD-17). "Active count" is
// Active + Trial (both are live); the current monthly total sums Active only;
// Trials surface separately; Paused is excluded from both and never generates a
// reminder. Every surface (analytics, scheduler, list, dashboard) consults these
// rather than hard-coding its own state check.

/** A predicate over a v2 subscription, used to filter lists. */
export type SubscriptionV2Predicate = (s: SubscriptionV2) => boolean;

/**
 * Eligibility for the "Active count": a subscription is counted when it is live,
 * i.e. its state is Active OR Trial (AD-17). Paused is excluded. This is the
 * single predicate the count seam shares with the scheduler's "not Paused"
 * eligibility — a Paused sub is neither counted nor reminded.
 */
export const isEligibleV2: SubscriptionV2Predicate = (s) =>
  s.state === "Active" || s.state === "Trial";

/** Predicate matching subscriptions in the plain Active state (spend-eligible). */
export const isActiveStateV2: SubscriptionV2Predicate = (s) =>
  s.state === "Active";

/** Predicate matching subscriptions in the Trial state (surfaced separately). */
export const isTrialStateV2: SubscriptionV2Predicate = (s) => s.state === "Trial";

/**
 * The live-but-counted subset (state Active + Trial), used for the "Active
 * count" (Req 8.3). Preserves input order; never mutates the input.
 */
export function activeSubscriptionsV2(
  subs: SubscriptionV2[],
): SubscriptionV2[] {
  return subs.filter(isEligibleV2);
}

/**
 * The spend subset: plain Active subscriptions only (Trials excluded, Paused
 * excluded). The current monthly/yearly total sums over THIS subset — a Trial
 * costs $0 until it converts, so it never pollutes current spend (AD-17).
 */
export function activeSpendSubscriptionsV2(
  subs: SubscriptionV2[],
): SubscriptionV2[] {
  return subs.filter(isActiveStateV2);
}

/**
 * The Trial subset, surfaced separately as the "+ when N trials convert" figure
 * (never summed into the current month).
 */
export function trialSubscriptionsV2(
  subs: SubscriptionV2[],
): SubscriptionV2[] {
  return subs.filter(isTrialStateV2);
}
