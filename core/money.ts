/**
 * Pure money core (AD-10 / AD-11).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`,
 * and reads no wall-clock or filesystem (AD-1). This is the single place money
 * arithmetic lives.
 *
 * Money model:
 *   - Stored amounts are integer **minor units** in a subscription's Native
 *     Currency (e.g. 1000 = ¥1000 for JPY, 1000 = $10.00 for USD).
 *   - The currency -> minor-unit-exponent table below is the mechanism AD-10
 *     mandates over a decimal library: the exponent is the number of fractional
 *     digits the currency uses (USD=2, JPY=0, BHD/KWD=3, ...).
 *   - `minorUnits(major, currency)` parses a decimal major amount into integer
 *     minor units; `toMajor(minor, currency)` renders minor units back to a
 *     display string. Neither uses JS floating point for the significant
 *     arithmetic, so there is no float drift and no wrong-exponent corruption.
 *   - `homeTotal(lines, rates)` is the single convert-before-sum total function
 *     (AD-11). It carries one precise integer intermediate (Home minor units
 *     scaled with guard digits), converts every line before summing, and rounds
 *     exactly once at the end. Rounded, displayed rows are never re-summed.
 *
 * No external money/decimal dependency is used (AD-10): the exponent table plus
 * BigInt arithmetic are the whole mechanism.
 */

/**
 * Currency -> minor-unit exponent (number of fractional digits).
 *
 * The ~30-currency ship list is now FINALIZED (PRD Q1, resolved in Story 2.3):
 * the 8 current options plus the common world majors — 31 currencies the
 * bundled FX snapshot ships rates for. This table is the single exponent seam
 * every one of them must be known at (JPY/KRW = 0 decimals; everything else in
 * the ship list = 2 decimals). The 3-decimal entries (BHD/KWD/OMR) remain as a
 * harmless superset: they are exponent-known but are not in the shipped rate
 * set. The lookup throws on anything absent, so a missing currency is a loud
 * error, never a silent wrong-exponent default.
 */
export const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  // 2-decimal majors (the common case).
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  CNY: 2,
  HKD: 2,
  SGD: 2,
  NZD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  ZAR: 2,
  MXN: 2,
  BRL: 2,
  // Common world majors added for the finalized ship list (all 2-decimal).
  PLN: 2,
  CZK: 2,
  HUF: 2,
  RON: 2,
  TRY: 2,
  ILS: 2,
  AED: 2,
  SAR: 2,
  THB: 2,
  MYR: 2,
  IDR: 2,
  PHP: 2,
  // 0-decimal currencies (minor unit == major unit).
  JPY: 0,
  KRW: 0,
  // 3-decimal currencies (exponent-known superset; not in the shipped rate set).
  BHD: 3,
  KWD: 3,
  OMR: 3,
});

/**
 * Thrown when a currency is not present in {@link MINOR_UNIT_EXPONENT}.
 *
 * Lookups never default to exponent 2 — defaulting would silently corrupt
 * JPY (0) and KWD (3), so an unknown currency is always an explicit error.
 */
export class UnknownCurrencyError extends Error {
  constructor(public readonly currency: string) {
    super(`Unknown currency: ${JSON.stringify(currency)} is not in the exponent table`);
    this.name = "UnknownCurrencyError";
  }
}

/** Thrown when a major amount cannot be parsed into minor units. */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/**
 * Thrown when a minor-unit result exceeds JS's safe-integer range, where a
 * `Number` cast would silently lose precision. The caller gets a loud error
 * instead of a quietly wrong total.
 */
export class AmountOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountOverflowError";
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** Narrow a BigInt to a `number`, throwing if it is outside the safe range. */
function toSafeNumber(value: bigint, what: string): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new AmountOverflowError(`${what} (${value}) exceeds the safe integer range`);
  }
  return Number(value);
}

/**
 * Return the minor-unit exponent for `currency`, throwing on an unknown one.
 * The single lookup seam — every caller routes through here, so no path can
 * silently assume exponent 2.
 */
export function exponentOf(currency: string): number {
  const exponent = MINOR_UNIT_EXPONENT[currency];
  if (exponent === undefined) {
    throw new UnknownCurrencyError(currency);
  }
  return exponent;
}

/**
 * Non-throwing predicate: `true` iff `currency` is in Subby's modeled set (the
 * same table `exponentOf` consults). Lets a caller SKIP an unmodeled currency up
 * front rather than reaching the loud `exponentOf`/`parseBundledSnapshot` throw —
 * used by the FX refresh provider to drop a currency ECB might publish that Subby
 * does not model, so one unmodeled rate never rejects an entire refresh.
 */
export function knownCurrency(currency: string): boolean {
  return MINOR_UNIT_EXPONENT[currency] !== undefined;
}

/** 10n ** exponent, as a BigInt scaling factor. */
function scaleFactor(exponent: number): bigint {
  let factor = 1n;
  for (let i = 0; i < exponent; i++) factor *= 10n;
  return factor;
}

/**
 * Parse a decimal major amount (string or number) into integer **minor units**
 * for `currency`.
 *
 * Examples (exponent-correct, not wrong by a factor of ten):
 *   minorUnits("10.00", "USD") === 1000
 *   minorUnits("1000",  "JPY") === 1000   (not 100000)
 *   minorUnits("1.500", "KWD") === 1500
 *
 * A `number` input is accepted for ergonomics but is formatted through a
 * fixed-decimal string first so there is no binary-float rounding surprise.
 *
 * Throws {@link InvalidAmountError} on NaN / infinite / negative / malformed
 * input or on more fractional digits than the currency supports, and
 * {@link UnknownCurrencyError} on an unknown currency. The amount is validated
 * here so an invalid value never reaches storage.
 */
export function minorUnits(major: string | number, currency: string): number {
  const exponent = exponentOf(currency);

  let text: string;
  if (typeof major === "number") {
    if (!Number.isFinite(major)) {
      throw new InvalidAmountError(`amount must be a finite number, got ${major}`);
    }
    // Format with enough fractional digits for this currency, exactly.
    text = major.toFixed(exponent);
  } else {
    text = major.trim();
  }

  // Accept an optional sign, digits, and an optional fractional part.
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new InvalidAmountError(`amount is not a valid decimal number: ${JSON.stringify(major)}`);
  }
  const [, sign, intPart, fracPartRaw = ""] = match;
  if (sign === "-") {
    // A negative amount is non-zero only if any digit is non-zero.
    if (/[1-9]/.test(intPart + fracPartRaw)) {
      throw new InvalidAmountError(`amount must be non-negative, got ${JSON.stringify(major)}`);
    }
  }
  if (fracPartRaw.length > exponent) {
    throw new InvalidAmountError(
      `amount has more fractional digits (${fracPartRaw.length}) than ${currency} supports (${exponent})`,
    );
  }

  // Right-pad the fractional part to the exponent, then concatenate: this is an
  // exact base-10 shift, with no floating-point step.
  const fracPart = fracPartRaw.padEnd(exponent, "0");
  const combined = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "");
  return toSafeNumber(BigInt(combined), "minor units");
}

/**
 * Render integer minor units back to a major-unit **display string** for
 * `currency` (display only — never fed back into arithmetic).
 *
 * Examples:
 *   toMajor(1000, "JPY") === "1000"
 *   toMajor(1000, "USD") === "10.00"
 *   toMajor(1500, "KWD") === "1.500"
 *
 * Throws {@link UnknownCurrencyError} on an unknown currency and
 * {@link InvalidAmountError} on a non-integer minor-unit value.
 */
export function toMajor(minor: number, currency: string): string {
  const exponent = exponentOf(currency);
  if (!Number.isInteger(minor)) {
    throw new InvalidAmountError(`minor units must be an integer, got ${minor}`);
  }

  const negative = minor < 0;
  const abs = BigInt(Math.abs(minor));
  if (exponent === 0) {
    return `${negative ? "-" : ""}${abs.toString()}`;
  }
  const factor = scaleFactor(exponent);
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(exponent, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/**
 * A single line entering a Home-currency total. Amounts are integer minor units
 * in the line's own (Native) `currency`; conversion to Home happens inside
 * {@link homeTotal} via the rate table, never by the caller.
 */
export interface MoneyLine {
  amountMinor: number;
  currency: string;
}

/**
 * Exchange-rate table: `rates[currency]` is how many **Home-currency major
 * units** one major unit of `currency` is worth (e.g. for Home=USD,
 * `rates.EUR = 1.08` means €1 = $1.08). The Home currency itself must map to 1.
 *
 * A rate is a decimal string to stay exact through the conversion; a `number`
 * is accepted for ergonomics and formatted on the way in.
 */
export type RateTable = Readonly<Record<string, string | number>>;

/** Thrown when a line's currency has no rate in the table (never raw-sum). */
export class MissingRateError extends Error {
  constructor(public readonly currency: string) {
    super(`No exchange rate for ${JSON.stringify(currency)} — cannot convert before summing`);
    this.name = "MissingRateError";
  }
}

/**
 * Thrown when the rate table violates the Home-currency contract: the Home
 * currency must map to a rate of exactly `1` (one Home major unit is worth one
 * Home major unit). A Home rate other than 1 would silently scale every Home
 * line, so it is a loud error here, never a silent rescaling.
 */
export class InvalidRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRateError";
  }
}

/**
 * A dated exchange-rate snapshot: the rate table plus the `asOf` date the rates
 * were valid as of. This is the dated-rate input contract — Story 2.3 will
 * populate it from the bundled FX snapshot; here it is the typed seam a total
 * carries so a surface can render "rates as of {asOf}".
 */
export interface RateSnapshot {
  asOf: string; // ISO date (YYYY-MM-DD) the rates are valid as of
  rates: RateTable;
}

/**
 * Guard digits carried by the precise intermediate beyond the Home exponent.
 * The intermediate is Home minor units scaled by 10^GUARD_DIGITS, kept as an
 * exact BigInt, so per-line conversion keeps sub-minor-unit precision and only
 * the final figure is rounded. 6 guard digits comfortably covers realistic
 * rate precision without overflow at the ~500-subscription scale.
 */
const GUARD_DIGITS = 6;

/**
 * Split a decimal rate string into (scaledInteger, fractionalDigitCount).
 *
 * A rate must be strictly **positive**: a `0` (or non-positive) rate is rejected
 * the same loud way a negative is, because a zero rate is an unfetched / bad
 * rate that would silently zero out a whole currency's contribution — never a
 * legitimate conversion. (`0` is `rate must be positive`, settling the Epic-1
 * deferral that `parseRate` previously rejected only negatives.)
 */
function parseRate(rate: string | number): { scaled: bigint; fracDigits: number } {
  let text: string;
  if (typeof rate === "number") {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new InvalidAmountError(`rate must be a finite positive number, got ${rate}`);
    }
    text = rate.toString();
  } else {
    text = rate.trim();
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || match[1] === "-") {
    throw new InvalidAmountError(`rate is not a valid positive decimal: ${JSON.stringify(rate)}`);
  }
  const [, , intPart, fracPart = ""] = match;
  const scaled = BigInt(`${intPart}${fracPart}` || "0");
  if (scaled === 0n) {
    // A zero rate (e.g. "0", "0.000", an unfetched placeholder) would silently
    // zero a currency's converted amount — reject it loudly, never convert at 0.
    throw new InvalidAmountError(`rate must be positive, got ${JSON.stringify(rate)}`);
  }
  return { scaled, fracDigits: fracPart.length };
}

/** Round a BigInt quotient `num / den` to the nearest integer (half-up on ties). */
function divideRoundNearest(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/**
 * Convert every line Native -> Home via `rates` and sum, returning the total in
 * integer Home minor units (AD-11). This is the one place totals are produced.
 *
 * The precise intermediate is Home minor units scaled by 10^GUARD_DIGITS,
 * accumulated as an exact BigInt; each line is converted and added at full
 * precision, and the result is rounded to Home minor units exactly **once** at
 * the end. The caller never re-sums rounded per-row figures — doing so is what
 * produces `Σ round(xᵢ) ≠ round(Σxᵢ)`, which this function exists to prevent.
 *
 * @param lines       the lines to total; `[]` totals to 0
 * @param rates       Native-major -> Home-major rate table (Home maps to 1)
 * @param homeCurrency the Home currency (determines the output exponent)
 *
 * Throws {@link MissingRateError} for any line whose currency has no rate, and
 * {@link UnknownCurrencyError} for an unknown currency.
 */
export function homeTotal(lines: readonly MoneyLine[], rates: RateTable, homeCurrency: string): number {
  const homeExponent = exponentOf(homeCurrency);
  const homeFactor = scaleFactor(homeExponent);
  const guard = scaleFactor(GUARD_DIGITS);

  // Rate-table contract: the Home currency, if present in the table, MUST map
  // to exactly 1 (one Home major unit is worth one Home major unit). A Home
  // rate other than 1 would silently scale every Home line, so reject it
  // loudly here. This guard only constrains a *present* Home rate; an absent
  // Home rate is not special-cased here — a Home-currency line whose rate is
  // absent still throws MissingRateError in the per-line loop below, so callers
  // that total Home lines must include `homeCurrency: 1` in the table.
  const homeRateRaw = (rates as Record<string, string | number>)[homeCurrency];
  if (homeRateRaw !== undefined) {
    const { scaled: homeScaled, fracDigits: homeFrac } = parseRate(homeRateRaw);
    // `1` as a scaled integer is exactly 10^fracDigits (e.g. "1" -> 1/1,
    // "1.000" -> 1000/1000). Any other value is a contract violation.
    if (homeScaled !== scaleFactor(homeFrac)) {
      throw new InvalidRateError(
        `Home currency ${JSON.stringify(homeCurrency)} must map to rate 1, got ${JSON.stringify(homeRateRaw)}`,
      );
    }
  }

  // Accumulate in Home minor units * 10^GUARD_DIGITS as an exact integer.
  let acc = 0n;
  for (const line of lines) {
    const nativeExponent = exponentOf(line.currency);
    if (!Number.isInteger(line.amountMinor)) {
      throw new InvalidAmountError(`line amountMinor must be an integer, got ${line.amountMinor}`);
    }
    if (line.amountMinor < 0) {
      throw new InvalidAmountError(`line amountMinor must be non-negative, got ${line.amountMinor}`);
    }
    const rateRaw = (rates as Record<string, string | number>)[line.currency];
    if (rateRaw === undefined) {
      throw new MissingRateError(line.currency);
    }
    const { scaled: rateScaled, fracDigits: rateFrac } = parseRate(rateRaw);

    // amountMinor is Native minor units = Native major * 10^nativeExponent.
    // Home major = Native major * rate.
    // Home minor (scaled by guard) =
    //   amountMinor / 10^nativeExponent  (-> Native major)
    //   * rateScaled / 10^rateFrac       (-> Home major)
    //   * 10^homeExponent                (-> Home minor)
    //   * 10^GUARD_DIGITS                 (-> scaled intermediate)
    const numerator = BigInt(line.amountMinor) * rateScaled * homeFactor * guard;
    const denominator = scaleFactor(nativeExponent) * scaleFactor(rateFrac);
    acc += divideRoundNearest(numerator, denominator);
  }

  // Round the single precise intermediate down to Home minor units, exactly once.
  const totalMinor = divideRoundNearest(acc, guard);
  return toSafeNumber(totalMinor, "home total minor units");
}

// --- Stale-rate guard (AD-12) ------------------------------------------------
//
// The single staleness authority (AD-12, ARCHITECTURE-SPINE.md L113-116). When
// the bundled FX snapshot is older than FX_STALE_DAYS AND the opt-in FX refresh
// is off, Subby must NOT present a confident single converted total — a
// years-stale rate shown as a current figure is the exact silent breakage this
// product exists to prevent (FR-12). The verdict lives here, in exactly one
// place, so no surface hard-codes its own threshold and the two can disagree.
//
// Purity (AD-1): `today` and `snapshotAsOf` are injected `YYYY-MM-DD` strings —
// there is NO wall-clock read anywhere in this block. Day-age math is exact UTC
// epoch-day arithmetic (same `Date.UTC(...)` convention as `core/renewal.ts`),
// so DST / timezones never shift a verdict and the result is deterministic for
// fixed inputs. Re-evaluation is a property of purity, not state: a new `today`,
// a flipped `fxRefreshOn`, or a different `snapshotAsOf` yields the newly-correct
// verdict on the next call (same inputs -> same output).

/**
 * The one staleness threshold every surface shares (AD-12): a snapshot more than
 * this many days older than `today` is `"stale"` (when FX refresh is off). It is
 * the ONLY numeric staleness threshold in shipped source — no surface duplicates
 * a second 90, so Epic 3/6 must consult {@link rateConfidence} / this constant.
 */
export const FX_STALE_DAYS = 90;

/** The staleness verdict a surface consults before showing a confident total. */
export type RateConfidence = "confident" | "stale";

/**
 * Thrown when a date argument is not a valid `YYYY-MM-DD` string (bad shape or a
 * non-finite / non-real calendar date). A corrupt date is NEVER silently treated
 * as fresh (`"confident"`); it is a loud, named error, mirroring this module's
 * error-class convention ({@link UnknownCurrencyError} / {@link MissingRateError}).
 */
export class InvalidDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateError";
  }
}

/** `YYYY-MM-DD` shape (mirrors `core/fxSnapshot.ts`'s `AS_OF_RE`). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a strict `YYYY-MM-DD` string into UTC year/month/day parts, throwing
 * {@link InvalidDateError} on a bad shape or a value that is not a real calendar
 * date (e.g. month 13 or day 99). The round-trip through `Date.UTC` rejects
 * out-of-range components: a non-real date normalizes to different parts, so we
 * compare them back and reject any mismatch.
 */
function parseISODateStrict(iso: string): { year: number; month: number; day: number } {
  if (typeof iso !== "string" || !ISO_DATE_RE.test(iso)) {
    throw new InvalidDateError(`date must be a YYYY-MM-DD string, got ${JSON.stringify(iso)}`);
  }
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
  const utcMs = Date.UTC(year, month - 1, day);
  const d = new Date(utcMs);
  // Reject non-real dates: `Date.UTC` silently normalizes (e.g. month 13 -> next
  // year, day 32 -> next month), so a valid date must round-trip to itself.
  if (
    !Number.isFinite(utcMs) ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    throw new InvalidDateError(`date is not a valid calendar date: ${JSON.stringify(iso)}`);
  }
  return { year, month, day };
}

/** Whole UTC days from `fromISO` to `toISO` (positive when `toISO` is later). */
function daysBetweenUTC(fromISO: string, toISO: string): number {
  const from = parseISODateStrict(fromISO);
  const to = parseISODateStrict(toISO);
  const MS_PER_DAY = 86_400_000;
  const fromMs = Date.UTC(from.year, from.month - 1, from.day);
  const toMs = Date.UTC(to.year, to.month - 1, to.day);
  // Both are UTC midnights, so the difference is an exact whole-day multiple.
  return (toMs - fromMs) / MS_PER_DAY;
}

/**
 * The AD-12 staleness verdict: `"stale"` IFF the snapshot is strictly MORE than
 * {@link FX_STALE_DAYS} days older than `today` AND `fxRefreshOn === false`;
 * otherwise `"confident"`.
 *
 * Boundary: exactly {@link FX_STALE_DAYS} days old is `"confident"` (strictly
 * greater is stale). A future-dated snapshot (negative age) or a same-day
 * snapshot (age 0) is `"confident"`. FX refresh being on overrides age entirely.
 *
 * Pure (AD-1): both dates are injected `YYYY-MM-DD` strings; no wall-clock. Day
 * age is exact UTC epoch-day arithmetic, so there is no timezone drift.
 *
 * @throws InvalidDateError if `snapshotAsOf` or `today` is not a valid
 *                          `YYYY-MM-DD` date (never a silent `"confident"`).
 */
export function rateConfidence(snapshotAsOf: string, today: string, fxRefreshOn: boolean): RateConfidence {
  const ageDays = daysBetweenUTC(snapshotAsOf, today);
  return ageDays > FX_STALE_DAYS && !fxRefreshOn ? "stale" : "confident";
}

/**
 * Whole completed calendar months `snapshotAsOf` is behind `today`, floored —
 * display support for the "these rates are N months old" affordance copy. It is
 * display-only and NEVER gates the verdict ({@link rateConfidence} is day-based
 * per AD-12). Returns `0` when the snapshot is on/after `today` (newer-or-equal
 * or future-dated).
 *
 * A "completed" month means the day-of-month has been reached: 2026-07-15 ->
 * 2026-10-14 is 2 completed months (the 15th of the third month has not arrived
 * yet), 2026-10-15 is 3.
 *
 * @throws InvalidDateError if either date is not a valid `YYYY-MM-DD` date.
 */
export function monthsStale(snapshotAsOf: string, today: string): number {
  const from = parseISODateStrict(snapshotAsOf);
  const to = parseISODateStrict(today);
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  // If `today`'s day-of-month has not yet reached the snapshot's, the final
  // month is not complete — subtract it. This floors to completed months.
  if (to.day < from.day) months -= 1;
  return months > 0 ? months : 0;
}
