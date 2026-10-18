/**
 * Pure bundled-FX-snapshot validation and EUR→Home rebasing (FR-12, AD-23,
 * AD-24; Story 2.3).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`/`node:*`, and reads no wall-clock or filesystem (AD-1). Every function
 * here is PURE: it never mutates its inputs and never reads the clock. The
 * rebasing is exact decimal-string (BigInt) arithmetic — never JS float.
 *
 * This module is the bridge between the dataset Subby ships and the money core:
 *   - The bundled `resources/fx-snapshot.json` is an EUR-based ECB daily-
 *     reference-rate table (`eurRate[X]` = units of X per €1) carrying its own
 *     `asOf` date and an integer `schemaVersion`. {@link parseBundledSnapshot}
 *     validates a raw (`unknown`) object into a typed {@link BundledFxSnapshot},
 *     failing LOUDLY on a bad shape, an unknown/missing schema version, a
 *     malformed/absent `asOf`/`base`, an unknown currency, or a non-positive
 *     rate — a corrupt bundle is never a silent wrong total.
 *   - `homeTotal` (`core/money.ts`) needs a *Home-based* `RateTable`
 *     (`rates[cur]` = Home major units per 1 unit of `cur`, Home → "1").
 *     {@link ratesForHome} rebases the EUR-based table into that Home-based one
 *     via `rates[cur] = eurRate[home] / eurRate[cur]`, as exact decimal strings,
 *     and returns a {@link RateSnapshot} (so a surface can show "rates as of
 *     {asOf}"). The output feeds `homeTotal`/`totalsV2` UNCHANGED — this module
 *     never re-implements convert-and-sum.
 *
 * The opt-in FX *refresh* that writes a Data-Folder override and the two-layer
 * "newest-as-of-wins" resolution is Epic 8, NOT this module.
 */

import { exponentOf, type RateSnapshot } from "core/money";

/**
 * The single supported bundled-snapshot schema version. A snapshot whose
 * `schemaVersion` is not exactly this integer is rejected loudly by
 * {@link parseBundledSnapshot}: an unknown schema version means the file was
 * written by an incompatible build and MUST NOT be guessed at (a silently
 * misread rate is a silently wrong total).
 */
export const FX_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * A validated, typed bundled FX snapshot. `rates` is EUR-based: `rates[X]` is
 * how many units of X one euro buys (ECB's euro reference-rate convention),
 * with `rates[base] === "1"`. All rate values are positive decimal strings.
 *
 *   - `schemaVersion` — the integer schema version (=== {@link FX_SNAPSHOT_SCHEMA_VERSION}).
 *   - `asOf`          — the date the rates are valid as of (`YYYY-MM-DD`).
 *   - `base`          — the base currency the rates are expressed against (EUR).
 *   - `attribution`   — the human-readable ECB data-source attribution string.
 *   - `rates`         — the EUR-based rate table (`base` → "1").
 */
export interface BundledFxSnapshot {
  schemaVersion: number;
  asOf: string;
  base: string;
  attribution: string;
  rates: Readonly<Record<string, string>>;
}

/**
 * The opt-in FX *refresh* override written to the Data Folder (Epic 8, Story
 * 8.6; AD-23). It is the SAME validated {@link BundledFxSnapshot} shape — so the
 * money core, `ratesForHome`, and the newest-"as of" resolution treat a refreshed
 * table identically to the bundle — PLUS a `fetchedAt` ISO-8601 instant.
 *
 * `asOf` and `fetchedAt` are two DIFFERENT clocks (Design Notes):
 *   - `asOf`      — the ECB rate date (`YYYY-MM-DD`, daily granularity). Drives
 *                   BOTH {@link resolveEffectiveSnapshot} (newest wins) AND the
 *                   stale-rate guard. Can lag over a weekend with no publication.
 *   - `fetchedAt` — the wall-clock instant Subby last SUCCESSFULLY fetched. Drives
 *                   ONLY the EnrichmentService's ≤24h network cap, never totals.
 *
 * Keeping them separate means a weekend with no new ECB publication does not
 * re-fetch every launch (the ≤24h gate holds on `fetchedAt`), and a fresher
 * post-release bundle still wins on `asOf`.
 */
export interface FxOverride extends BundledFxSnapshot {
  /** The wall-clock instant of the last successful fetch (ISO-8601). */
  fetchedAt: string;
}

/**
 * Thrown when a raw bundled snapshot fails validation: a bad shape, an
 * unknown/missing `schemaVersion`, a malformed/absent `asOf`, a missing/empty
 * `rates`, a missing `base`, or a base whose own rate is not exactly 1. This is
 * the loud-error contract — a corrupt bundle is a {@link FxSnapshotError}, never
 * a silent wrong total. A zero / non-positive / malformed rate also throws a
 * {@link FxSnapshotError} (via this module's own `parsePositiveRate`, which
 * mirrors the money core's positive-rate rule). An unknown currency is the one
 * case that reuses the money core's `UnknownCurrencyError` verbatim (through
 * `exponentOf`).
 */
export class FxSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxSnapshotError";
  }
}

/**
 * The fixed number of fractional digits the rebased Home-based rates are
 * computed to. Twelve digits comfortably exceeds any realistic FX precision, so
 * the per-line precision loss is far finer than any Home minor unit and is
 * rounded away once inside `homeTotal`'s guard-digit intermediate (there is no
 * float drift — the division is exact BigInt arithmetic to this scale).
 */
const REBASE_DECIMALS = 12;

/** `YYYY-MM-DD` with a real-looking (not fully validated) calendar shape. */
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A positive decimal rate string: digits, optional single fractional part. */
const RATE_RE = /^(\d+)(?:\.(\d+))?$/;

/** Parse a positive decimal rate string into `(scaled, fracDigits)`, loud on bad/zero. */
function parsePositiveRate(currency: string, raw: string): { scaled: bigint; fracDigits: number } {
  const text = raw.trim();
  const match = RATE_RE.exec(text);
  if (!match) {
    throw new FxSnapshotError(
      `rate for ${JSON.stringify(currency)} is not a valid positive decimal: ${JSON.stringify(raw)}`,
    );
  }
  const [, intPart, fracPart = ""] = match;
  const scaled = BigInt(`${intPart}${fracPart}` || "0");
  if (scaled === 0n) {
    // A zero/non-positive rate would silently zero a currency's contribution —
    // reject it the same loud way the money core's parseRate does.
    throw new FxSnapshotError(`rate for ${JSON.stringify(currency)} must be positive, got ${JSON.stringify(raw)}`);
  }
  return { scaled, fracDigits: fracPart.length };
}

/**
 * Validate a raw (`unknown`) object into a typed {@link BundledFxSnapshot},
 * failing LOUDLY on any defect so a corrupt bundle is never a silent wrong
 * total.
 *
 * Checks, in order:
 *   1. The value is a non-null object.
 *   2. `schemaVersion` is exactly {@link FX_SNAPSHOT_SCHEMA_VERSION} (integer).
 *   3. `asOf` is a `YYYY-MM-DD` string.
 *   4. `base` and `attribution` are non-empty strings.
 *   5. `rates` is a non-empty object of currency → positive-decimal-string.
 *   6. Every rate key AND `base` is a known currency (`core/money` exponent
 *      table) — else the money core's {@link UnknownCurrencyError}.
 *   7. Every rate value parses as a strictly positive decimal — else a loud
 *      {@link FxSnapshotError}.
 *   8. `base` is present in `rates` and maps to exactly 1 (one base unit buys
 *      one base unit).
 *
 * @throws FxSnapshotError      on a bad shape / schema / asOf / base / rates.
 * @throws UnknownCurrencyError on a rate key or `base` absent from the exponent
 *                              table (reused from `core/money`).
 */
export function parseBundledSnapshot(raw: unknown): BundledFxSnapshot {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FxSnapshotError(`bundled FX snapshot must be an object, got ${raw === null ? "null" : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;

  const { schemaVersion } = obj;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new FxSnapshotError(`schemaVersion must be an integer, got ${JSON.stringify(schemaVersion)}`);
  }
  if (schemaVersion !== FX_SNAPSHOT_SCHEMA_VERSION) {
    throw new FxSnapshotError(
      `unsupported schemaVersion ${schemaVersion}; this build supports ${FX_SNAPSHOT_SCHEMA_VERSION}`,
    );
  }

  const { asOf } = obj;
  if (typeof asOf !== "string" || !AS_OF_RE.test(asOf)) {
    throw new FxSnapshotError(`asOf must be a YYYY-MM-DD date string, got ${JSON.stringify(asOf)}`);
  }

  const { base } = obj;
  if (typeof base !== "string" || base.trim() === "") {
    throw new FxSnapshotError(`base must be a non-empty currency string, got ${JSON.stringify(base)}`);
  }

  const { attribution } = obj;
  if (typeof attribution !== "string" || attribution.trim() === "") {
    throw new FxSnapshotError(`attribution must be a non-empty string, got ${JSON.stringify(attribution)}`);
  }

  const { rates } = obj;
  if (typeof rates !== "object" || rates === null || Array.isArray(rates)) {
    throw new FxSnapshotError(`rates must be an object, got ${rates === null ? "null" : typeof rates}`);
  }
  const rateEntries = Object.entries(rates as Record<string, unknown>);
  if (rateEntries.length === 0) {
    throw new FxSnapshotError("rates must be a non-empty object");
  }

  const validatedRates: Record<string, string> = {};
  for (const [currency, value] of rateEntries) {
    // Unknown currency → the money core's loud UnknownCurrencyError (reused).
    exponentOf(currency);
    if (typeof value !== "string") {
      throw new FxSnapshotError(
        `rate for ${JSON.stringify(currency)} must be a decimal string, got ${typeof value}`,
      );
    }
    // Positive-rate contract (loud on 0 / negative / malformed).
    parsePositiveRate(currency, value);
    validatedRates[currency] = value.trim();
  }

  // `base` must be a known currency and must be present in the rates, mapping to 1.
  exponentOf(base);
  const baseRate = validatedRates[base];
  if (baseRate === undefined) {
    throw new FxSnapshotError(`base currency ${JSON.stringify(base)} is absent from rates`);
  }
  const { scaled: baseScaled, fracDigits: baseFrac } = parsePositiveRate(base, baseRate);
  if (baseScaled !== pow10(baseFrac)) {
    // "1" scaled by its own fractional digits is exactly 10^fracDigits ("1" ->
    // 1/1, "1.000" -> 1000/1000). Anything else means the table is not actually
    // anchored to its declared base.
    throw new FxSnapshotError(`base currency ${JSON.stringify(base)} must map to rate 1, got ${JSON.stringify(baseRate)}`);
  }

  return {
    schemaVersion,
    asOf,
    base,
    attribution,
    rates: validatedRates,
  };
}

/**
 * Rebase a validated EUR-based (base-based) {@link BundledFxSnapshot} into a
 * Home-based {@link RateSnapshot} that `homeTotal`/`totalsV2` consume directly.
 *
 * The output `rates` table is Home-based: `rates[home] === "1"` and every other
 * currency maps to `eurRate[home] / eurRate[cur]` — "how many Home major units
 * one unit of `cur` is worth" — computed as an EXACT decimal string to
 * {@link REBASE_DECIMALS} fractional digits via BigInt division (no JS float).
 * Rebasing to the snapshot's own `base` is the identity on that base (`"1"`).
 *
 * The result carries the snapshot's `asOf` verbatim so a surface can render
 * "rates as of {asOf}". Pure: the input snapshot is never mutated.
 *
 * @throws UnknownCurrencyError if `homeCurrency` is absent from the exponent
 *                              table (reused from `core/money`).
 * @throws FxSnapshotError      if `homeCurrency` has no rate in the snapshot.
 */
export function ratesForHome(snapshot: BundledFxSnapshot, homeCurrency: string): RateSnapshot {
  // Unknown Home currency → the money core's loud UnknownCurrencyError.
  exponentOf(homeCurrency);

  const homeRateRaw = snapshot.rates[homeCurrency];
  if (homeRateRaw === undefined) {
    throw new FxSnapshotError(
      `home currency ${JSON.stringify(homeCurrency)} has no rate in the snapshot (asOf ${snapshot.asOf})`,
    );
  }
  const { scaled: homeScaled, fracDigits: homeFrac } = parsePositiveRate(homeCurrency, homeRateRaw);

  const scale = pow10(REBASE_DECIMALS);
  const rebased: Record<string, string> = {};
  for (const [currency, rateRaw] of Object.entries(snapshot.rates)) {
    if (currency === homeCurrency) {
      // eurRate[home] / eurRate[home] = exactly 1 — the Home anchor the money
      // core's rate-table contract requires.
      rebased[currency] = "1";
      continue;
    }
    const { scaled: curScaled, fracDigits: curFrac } = parsePositiveRate(currency, rateRaw);
    // rates[cur] = eurRate[home] / eurRate[cur]
    //            = (homeScaled / 10^homeFrac) / (curScaled / 10^curFrac)
    //            = (homeScaled * 10^curFrac) / (curScaled * 10^homeFrac)
    // Multiply the numerator by 10^REBASE_DECIMALS first so the integer
    // quotient already carries REBASE_DECIMALS fractional digits (round nearest).
    const numerator = homeScaled * pow10(curFrac) * scale;
    const denominator = curScaled * pow10(homeFrac);
    const quotient = divideRoundNearest(numerator, denominator);
    rebased[currency] = formatScaled(quotient, REBASE_DECIMALS);
  }

  return { asOf: snapshot.asOf, rates: rebased };
}

// --- Opt-in FX refresh override (Epic 8, Story 8.6; AD-23) -------------------

/** `YYYY-MM-DD(THH:MM[:SS[.mmm]]Z…)` sanity shape for the `fetchedAt` instant. */
const FETCHED_AT_RE = /^\d{4}-\d{2}-\d{2}T.+/;

/**
 * Validate a raw (`unknown`) object into a typed {@link FxOverride}, failing
 * LOUDLY on any defect (a wrong rate is a wrong total — reuse the bundle's
 * positive-rate discipline via {@link parseBundledSnapshot}).
 *
 * It first runs the FULL {@link parseBundledSnapshot} validation (shape, schema
 * version, `asOf`, `base`, `attribution`, every rate strictly positive, base ↦ 1,
 * known currencies) and then additionally requires a non-empty `fetchedAt`
 * ISO-8601-ish instant string. A `fetchedAt` with a bad shape, or any defect the
 * bundle parser rejects, THROWS — so the EnrichmentService never writes a
 * malformed override, and a corrupt override read degrades to `null` (the caller
 * catches this throw), never a crash and never a silent wrong number.
 *
 * @throws FxSnapshotError      on a bad shape / schema / asOf / base / rates /
 *                              fetchedAt.
 * @throws UnknownCurrencyError on an unknown currency (reused from `core/money`).
 */
export function parseFxOverride(raw: unknown): FxOverride {
  // Reuse the full loud bundle validation (positive rates, base ↦ 1, etc.).
  const snapshot = parseBundledSnapshot(raw);

  // `fetchedAt` is the one field the bundle shape does not carry. It must be a
  // non-empty ISO-8601 instant string (the wall-clock cadence clock).
  const { fetchedAt } = raw as Record<string, unknown>;
  if (typeof fetchedAt !== "string" || !FETCHED_AT_RE.test(fetchedAt.trim())) {
    throw new FxSnapshotError(
      `fetchedAt must be an ISO-8601 instant string, got ${JSON.stringify(fetchedAt)}`,
    );
  }

  return { ...snapshot, fetchedAt: fetchedAt.trim() };
}

/**
 * Resolve the EFFECTIVE snapshot from the two layers {bundle, override}: whichever
 * has the newer `asOf` wins (AD-23). This is the SINGLE resolution point a
 * conversion batch calls ONCE, so a stale override never shadows a fresher
 * post-release bundle and there is no mid-total re-read race.
 *
 * Null-safe and churn-stable:
 *   - both `null`            → `null` (no rates at all; caller degrades off).
 *   - one `null`             → the other (the only layer present wins).
 *   - override `asOf` NEWER  → the override (a fresh refresh wins).
 *   - bundle `asOf` NEWER    → the bundle (a release bump wins; the stale
 *                              override does NOT shadow it).
 *   - EQUAL `asOf`           → the BUNDLE, deliberately: a same-date override
 *                              carries no newer rate information, so preferring
 *                              the bundle avoids needless churn and keeps the
 *                              resolution deterministic.
 *
 * Comparison is lexicographic over the `YYYY-MM-DD` strings, which is also
 * chronological for that fixed-width format — no `Date` parsing, no clock, pure
 * (AD-1). The returned value is one of the inputs by reference (never mutated);
 * the override's extra `fetchedAt` is irrelevant to totals and simply rides along
 * when the override wins (it is a superset of {@link BundledFxSnapshot}).
 */
export function resolveEffectiveSnapshot(
  bundle: BundledFxSnapshot | null,
  override: FxOverride | null,
): BundledFxSnapshot | null {
  if (bundle === null) return override;
  if (override === null) return bundle;
  // An equal-or-older override defers wholesale to the bundle (equal → bundle,
  // avoiding churn; older → the fresher bundle is never shadowed).
  if (override.asOf <= bundle.asOf) return bundle;

  // Strictly-newer override wins — but it is LAYERED over the bundle, not swapped
  // in wholesale. The ECB/Frankfurter refresh publishes only ECB's set, which
  // OMITS currencies the bundle ships (e.g. AED, SAR). Replacing the whole table
  // would drop those: a Home Currency of AED/SAR would then have no rate (totals
  // read "unavailable"), and AED/SAR subscriptions would lose conversion under any
  // Home. So the fresher override rate wins per-currency and the bundle fills any
  // gap. Layering is only sound when both tables share a base (both ECB → EUR); if
  // the bases ever differ, fall back to the override alone rather than mix bases.
  if (override.base !== bundle.base) return override;
  return {
    schemaVersion: override.schemaVersion,
    asOf: override.asOf,
    base: override.base,
    attribution: override.attribution,
    // Bundle first, override second → override values win, bundle-only keys (AED,
    // SAR, …) survive. `base ↦ "1"` is identical in both, so the merge is safe.
    rates: { ...bundle.rates, ...override.rates },
  };
}

// --- Local exact-decimal helpers (BigInt only) -------------------------------

/** 10n ** n as a BigInt. */
function pow10(n: number): bigint {
  let f = 1n;
  for (let i = 0; i < n; i++) f *= 10n;
  return f;
}

/** Round the non-negative BigInt quotient `num / den` to nearest (half-up). */
function divideRoundNearest(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  return r * 2n >= den ? q + 1n : q;
}

/**
 * Render a non-negative integer scaled by `10^decimals` back to a decimal
 * string with exactly `decimals` fractional digits (e.g. (1950000000000, 12)
 * -> "1.950000000000").
 */
function formatScaled(scaledValue: bigint, decimals: number): string {
  if (decimals === 0) return scaledValue.toString();
  const factor = pow10(decimals);
  const whole = scaledValue / factor;
  const frac = (scaledValue % factor).toString().padStart(decimals, "0");
  return `${whole.toString()}.${frac}`;
}
