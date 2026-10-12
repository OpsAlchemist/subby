/**
 * Pure Home-currency, convert-before-sum totals over v2 subscriptions
 * (FR-11, AD-10, AD-11, SM-6).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`, and reads no wall-clock or filesystem (AD-1). Every function here is
 * PURE: it never mutates its inputs and never reads the clock.
 *
 * This is the Story 2.2 behavior that turns a mixed-currency set into ONE
 * honest Home-currency total:
 *   - the Home Currency comes from `settings.homeCurrency` — the single source,
 *     so changing it recomputes every total and the output exponent follows it;
 *   - each subscription's billing cycle is normalized to an EXACT monthly (or
 *     yearly) minor-unit contribution with no pre-round — the fractional cycle
 *     share (e.g. a yearly amount ÷ 12) is carried into the single precise
 *     total, never rounded per row and re-summed (that Σ-of-rounded error is
 *     exactly what AD-10 forbids);
 *   - the convert-before-sum itself is delegated to the ONE total function,
 *     `homeTotal` in `core/money.ts` (AD-11) — this module never re-implements
 *     convert-and-sum; and
 *   - the result carries the rate snapshot's `asOf` date verbatim so a surface
 *     can render "rates as of {asOf}" (never a wall-clock read here).
 *
 * Scope (Story 2.2): the pure totals layer and its property suite only. No
 * renderer/IPC/storage work, no bundled FX snapshot reader (Story 2.3), no
 * stale-rate guard (Story 2.4). The v1 `core/billing.ts` raw-amount summing is
 * left untouched; the v1→v2 cutover is Epic 3.
 */

import { homeTotal, AmountOverflowError, InvalidAmountError, type MoneyLine, type RateSnapshot } from "core/money";
import type { BillingCycle, CustomInterval, SubscriptionV2 } from "core/models/subscription";
import type { SettingsV2 } from "core/models/settings";

/** The period a total is computed over. */
export type TotalPeriod = "monthly" | "yearly";

/**
 * A convert-before-sum total in integer Home minor units, carrying the rate
 * snapshot's `asOf` date and the resolved Home Currency so a surface can render
 * both the figure (via `toMajor(totalMinor, homeCurrency)`) and "rates as of
 * {asOf}".
 */
export interface HomeTotal {
  totalMinor: number; // integer Home minor units (the output exponent is Home's)
  asOf: string; // the snapshot's asOf date, echoed verbatim
  homeCurrency: string; // the Home Currency the total converted to
}

/**
 * The Home Currency source may be the full `SettingsV2` (preferred — the single
 * source of truth is `settings.homeCurrency`) or a bare currency string, so
 * callers that only have the currency need not synthesize a settings object.
 */
export type HomeCurrencySource = SettingsV2 | string;

function resolveHomeCurrency(source: HomeCurrencySource): string {
  return typeof source === "string" ? source : source.homeCurrency;
}

/**
 * One subscription's MONTHLY contribution expressed as an EXACT rational
 * `amountMinor × numer / denom` in the sub's Native minor units — never a
 * pre-rounded figure. Keeping the division as a rational (not a float, not a
 * rounded integer) is what lets the single end-round in {@link totalFor} stay
 * honest. The returned numer/denom are the cycle factors only (they do not yet
 * include `amountMinor`).
 *
 * Monthly contribution per cycle (mirrors v1 `core/billing.ts`'s float factors,
 * in exact integer arithmetic):
 *   Monthly     -> × 1
 *   Yearly      -> ÷ 12
 *   Half-Yearly -> ÷ 6
 *   Quarterly   -> ÷ 3
 *   Weekly      -> × 52 / 12   (i.e. 13 / 3)
 *   Custom      -> ÷ monthsInCustomInterval, where that itself is a rational:
 *       day   -> count / 30   => monthly × 30 / count
 *       week  -> count × 7 / 30 => monthly × 30 / (7 × count)
 *       month -> count        => monthly ÷ count
 *       year  -> count × 12    => monthly ÷ (12 × count)
 */
function monthlyCycleFactor(
  billingCycle: BillingCycle,
  customInterval: CustomInterval | undefined,
): { numer: bigint; denom: bigint } {
  switch (billingCycle) {
    case "Monthly":
      return { numer: 1n, denom: 1n };
    case "Yearly":
      return { numer: 1n, denom: 12n };
    case "Half-Yearly":
      return { numer: 1n, denom: 6n };
    case "Quarterly":
      return { numer: 1n, denom: 3n };
    case "Weekly":
      // 52 weeks / 12 months, i.e. a week's amount contributes 52/12 of itself
      // per month.
      return { numer: 52n, denom: 12n };
    case "Custom": {
      if (!customInterval) {
        throw new InvalidCycleError("Custom billing cycle requires a customInterval");
      }
      const count = BigInt(customInterval.count);
      if (count <= 0n) {
        throw new InvalidCycleError(
          `customInterval.count must be a positive integer, got ${customInterval.count}`,
        );
      }
      switch (customInterval.unit) {
        case "day":
          // monthsInCustomInterval = count / 30  => monthly = 30 / count
          return { numer: 30n, denom: count };
        case "week":
          // monthsInCustomInterval = count × 7 / 30 => monthly = 30 / (7 × count)
          return { numer: 30n, denom: 7n * count };
        case "month":
          // monthsInCustomInterval = count => monthly = 1 / count
          return { numer: 1n, denom: count };
        case "year":
          // monthsInCustomInterval = count × 12 => monthly = 1 / (12 × count)
          return { numer: 1n, denom: 12n * count };
      }
    }
  }
}

/**
 * Thrown when a subscription's billing cycle cannot be normalized (a `Custom`
 * cycle missing its interval, or a non-positive custom count). Loud, never a
 * silent zero/skip.
 */
export class InvalidCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCycleError";
  }
}

/**
 * Fixed sub-minor scaling factor the cycle normalization carries into the
 * single `homeTotal` so a fractional monthly/yearly share is NOT pre-rounded to
 * native minor units before summing.
 *
 * Each sub's exact period share `amountMinor × numer / denom` is expressed as
 * the scaled line amount `round(amountMinor × numer × SCALE / denom)` — an
 * integer in `SCALE`-ths of a native minor unit, with any sub-`1/SCALE`
 * remainder the only thing dropped (10^-6 native minor is far finer than any
 * Home minor unit). `homeTotal` then converts and sums those scaled lines in
 * ONE precise pass (never Σ-of-rounded rows), and the result is divided back by
 * `SCALE` with a single Home-minor round. Six digits are plenty: the dropped
 * sub-`1/SCALE` native remainder can never move a Home-minor figure, and the
 * scale stays well inside the safe-integer range for realistic portfolios. An
 * extreme synthetic input whose scaled line exceeds the safe-integer range is
 * surfaced loudly as {@link AmountOverflowError} here (in `numberFromBig`,
 * before `homeTotal` is reached), never silently.
 */
const CYCLE_SCALE = 1_000_000n;

/**
 * Compute the convert-before-sum total over `subs` for `period`, in integer
 * Home minor units, carrying the snapshot's `asOf` date and the resolved Home
 * Currency.
 *
 * Honest cycle normalization (never Σ-of-rounded, AD-10/AD-11):
 *   1. Each sub's period contribution is the EXACT rational
 *      `amountMinor × numer / denom` in its Native minor units (monthly factor
 *      from {@link monthlyCycleFactor}, ×12 for yearly), carried as integer
 *      numer/denom — never a pre-rounded per-row minor-unit figure.
 *   2. That share is expressed as a {@link CYCLE_SCALE}-scaled integer line
 *      `round(amountMinor × numer × SCALE / denom)` — the fractional monthly
 *      share is preserved to 10^-6 of a native minor unit, so the ÷12 (etc.) is
 *      NOT rounded to whole minor units per row (which is the Σ-of-rounded error
 *      AD-10 forbids). The only thing dropped is a sub-`1/SCALE` native
 *      remainder, finer than any Home minor unit.
 *   3. Those scaled lines go through the single `homeTotal` (AD-11 — the
 *      convert-and-sum is never re-implemented here): every line converts
 *      Native→Home and enters ONE precise guard-digit sum, rounded once to
 *      `SCALE × Home-minor-units`.
 *   4. One final `round(scaledTotal / SCALE)` normalizes the scaling back to
 *      Home minor units — the cycle round, at Home-minor granularity.
 *
 * (Because the convert-sum is rounded to `SCALE×`Home-minor before the `/SCALE`
 * cycle round, the result can differ by at most one minor unit from an abstract
 * single-rational round, and only for an input whose true total lands within a
 * sub-`1/SCALE` sliver of a half-minor-unit tie — a measure-zero display
 * boundary, not a mixed-currency summation error. The convert-before-sum itself
 * (SM-6) is exact and no per-row figure is rounded then re-summed.)
 *
 * An empty set totals to `0` (and still echoes `asOf`). The Home Currency comes
 * from `settings.homeCurrency` (or a bare currency string) — the single source;
 * the output exponent follows the Home Currency.
 *
 * Throws {@link InvalidCycleError} for an unnormalizable cycle; throws
 * {@link InvalidAmountError} for a non-integer or negative `amountMinor` and
 * {@link AmountOverflowError} when a scaled line exceeds the safe-integer range
 * (both raised here, before `homeTotal`); and propagates
 * {@link UnknownCurrencyError} / {@link MissingRateError} / {@link InvalidRateError}
 * / {@link InvalidAmountError} / {@link AmountOverflowError} from `homeTotal`
 * (unknown currency, missing rate, Home-rate≠1, zero/negative rate, out-of-range
 * total) — every failure is loud, never a silent raw sum.
 */
export function totalFor(
  subs: readonly SubscriptionV2[],
  snapshot: RateSnapshot,
  home: HomeCurrencySource,
  period: TotalPeriod,
): HomeTotal {
  const homeCurrency = resolveHomeCurrency(home);

  // Yearly is the monthly contribution × 12; fold the 12 into the numerator so
  // the rational stays exact.
  const periodMultiplier = period === "yearly" ? 12n : 1n;

  // Build one SCALE-scaled, exact-integer MoneyLine per sub: the sub's exact
  // period share expressed in SCALE-ths of a native minor unit.
  const scaledLines: MoneyLine[] = subs.map((sub) => {
    // Validate the amount up front with the SAME error type `homeTotal` uses
    // for these conditions, so a bad amount reads identically regardless of
    // which layer catches it (we must check before the BigInt scaling, which
    // would otherwise mangle a non-integer/negative value).
    if (!Number.isInteger(sub.amountMinor)) {
      throw new InvalidAmountError(`subscription amountMinor must be an integer, got ${sub.amountMinor}`);
    }
    if (sub.amountMinor < 0) {
      throw new InvalidAmountError(`subscription amountMinor must be non-negative, got ${sub.amountMinor}`);
    }
    const { numer, denom } = monthlyCycleFactor(sub.billingCycle, sub.customInterval);
    const scaledAmount = roundDivBig(BigInt(sub.amountMinor) * numer * periodMultiplier * CYCLE_SCALE, denom);
    return {
      currency: sub.currency,
      amountMinor: numberFromBig(scaledAmount, "cycle-normalized line amount"),
    };
  });

  // Delegate the convert-before-sum to the ONE total function. The result is in
  // SCALE × Home-minor-units (at homeTotal's guard precision); dividing by SCALE
  // and rounding once yields the Home-minor-unit total.
  const scaledTotal = homeTotal(scaledLines, snapshot.rates, homeCurrency);
  const totalMinor = roundDivNumber(BigInt(scaledTotal), CYCLE_SCALE);

  return { totalMinor, asOf: snapshot.asOf, homeCurrency };
}

/** Monthly convert-before-sum total (FR-11), Home Currency from the single source. */
export function homeMonthlyTotal(
  subs: readonly SubscriptionV2[],
  snapshot: RateSnapshot,
  home: HomeCurrencySource,
): HomeTotal {
  return totalFor(subs, snapshot, home, "monthly");
}

/** Yearly convert-before-sum total (= monthly × 12 per sub, round once at the end). */
export function homeYearlyTotal(
  subs: readonly SubscriptionV2[],
  snapshot: RateSnapshot,
  home: HomeCurrencySource,
): HomeTotal {
  return totalFor(subs, snapshot, home, "yearly");
}

// --- Local BigInt → number helpers (safe-integer guarded) --------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Narrow a BigInt to a `number`, throwing {@link AmountOverflowError} if it is
 * outside the safe range. (A scaled cycle-normalized line amount that exceeds
 * the safe range would lose precision as a `number`; surface that loudly rather
 * than silently rounding — the same loud domain error `homeTotal` raises for an
 * out-of-range result, so the overflow reads identically whichever layer hits
 * it first.)
 */
function numberFromBig(value: bigint, what: string): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new AmountOverflowError(`${what} (${value}) exceeds the safe integer range`);
  }
  return Number(value);
}

/** Round the BigInt quotient `num / den` to the nearest integer (half-up on ties). */
function roundDivBig(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** Round `num / den` to the nearest integer (half-up on ties) and narrow to number. */
function roundDivNumber(num: bigint, den: bigint): number {
  return numberFromBig(roundDivBig(num, den), "home total minor units");
}
