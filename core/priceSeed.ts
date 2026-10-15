/**
 * Pure bundled suggested-price-seed validation and normalized lookup (FR-13;
 * Story 5.4).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`/`node:*`, and reads no wall-clock or filesystem (AD-1). Every function
 * here is PURE: it never mutates its inputs and never reads the clock — the
 * `today` used by {@link isSeedStale} is an injected `YYYY-MM-DD` parameter.
 *
 * This module mirrors `core/fxSnapshot.ts` — the proven precedent for a
 * bundled, read-only, loudly-validated resource. The bundled
 * `resources/price-seed.json` is a tiny offline table of approximate typical
 * prices keyed by a NORMALIZED (trim + lowercase) service name, carrying its
 * own `asOf` date, an integer `schemaVersion`, and an "approximate, always
 * verify" `disclaimer`:
 *
 *   - {@link parsePriceSeed} validates a raw (`unknown`) object into a typed
 *     {@link PriceSeed}, failing LOUDLY on a bad shape, an unknown/missing
 *     schema version, a malformed/absent `asOf`/`disclaimer`, or a malformed
 *     `services` map — a corrupt bundle is a {@link PriceSeedError}, never a
 *     silent empty table that would become a silently-missing suggestion. Each
 *     service entry's `amountMinor` (integer ≥ 0), `currency` (non-empty), and
 *     `billingCycle` (a valid {@link BillingCycle}) are validated.
 *   - {@link lookupSuggestion} normalizes the queried name (trim + lowercase),
 *     does an EXACT normalized-key match (no fuzzy — a wrong confident number is
 *     worse than none), and returns the matching entry's
 *     `{amountMinor, currency, billingCycle}` plus the seed's `asOf`, or `null`
 *     on no match.
 *   - {@link isSeedStale} is a pure date comparison: a seed more than
 *     `maxAgeDays` (≈ 365, ~1 year) older than `today` is stale, so the renderer
 *     can suppress the auto pre-fill from an aged seed.
 *
 * The suggestion is a convenience, never load-bearing: the main process reads
 * the seed once through the asar-aware resource reader and degrades the whole
 * feature OFF on any error (missing/corrupt), so Add always works.
 */

import { billingCycleSchema } from "core/models/schema";
import type { BillingCycle } from "core/models/subscription";

/**
 * The single supported price-seed schema version. A seed whose `schemaVersion`
 * is not exactly this integer is rejected loudly by {@link parsePriceSeed}: an
 * unknown schema version means the file was written by an incompatible build and
 * MUST NOT be guessed at.
 */
export const PRICE_SEED_SCHEMA_VERSION = 1 as const;

/** `YYYY-MM-DD` with a real-looking (not fully validated) calendar shape. */
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The valid {@link BillingCycle} values, derived from the single zod source of
 * truth ({@link billingCycleSchema}) so this module can never drift from the
 * schema's enum. Used to validate each seed entry's `billingCycle`.
 */
const VALID_BILLING_CYCLES: ReadonlySet<string> = new Set(billingCycleSchema.options);

/**
 * One validated service entry in a {@link PriceSeed}. Amounts are integer minor
 * units in the entry's own `currency` (AD-10); the `billingCycle` is a valid
 * {@link BillingCycle}. This is exactly the shape used to pre-fill the Add
 * modal's amount/currency/cycle.
 */
export interface PriceSeedEntry {
  amountMinor: number;
  currency: string;
  billingCycle: BillingCycle;
}

/**
 * A validated, typed suggested-price seed.
 *
 *   - `schemaVersion` — the integer schema version (=== {@link PRICE_SEED_SCHEMA_VERSION}).
 *   - `asOf`          — the date the prices are typical as of (`YYYY-MM-DD`).
 *   - `disclaimer`    — the "approximate, always verify" disclaimer string.
 *   - `services`      — a map of NORMALIZED (trim + lowercase) service name →
 *                       {@link PriceSeedEntry}.
 */
export interface PriceSeed {
  schemaVersion: number;
  asOf: string;
  disclaimer: string;
  services: Readonly<Record<string, PriceSeedEntry>>;
}

/**
 * A suggestion for the Add modal: the matched entry's figures plus the seed's
 * `asOf` date (so the UI can show "typical as of {asOf}, please confirm"). The
 * `asOf` rides the suggestion so the renderer can apply {@link isSeedStale} with
 * its own `today` (a UTC day).
 */
export interface PriceSuggestion {
  amountMinor: number;
  currency: string;
  billingCycle: BillingCycle;
  asOf: string;
}

/**
 * Thrown when a raw price seed fails validation: a bad shape, an unknown/missing
 * `schemaVersion`, a malformed/absent `asOf`/`disclaimer`, a malformed
 * `services` map, or a malformed service entry (non-integer/negative
 * `amountMinor`, empty `currency`, or an invalid `billingCycle`). This is the
 * loud-error contract — a corrupt bundle is a {@link PriceSeedError}, never a
 * silent empty table (mirrors `core/fxSnapshot.FxSnapshotError`).
 */
export class PriceSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceSeedError";
  }
}

/**
 * Normalize a raw service name for lookup/keying: trim surrounding whitespace
 * and lowercase. This is the single normalization rule, applied BOTH to the
 * query and (as a defensive re-key) to the seed's keys, so a match is an exact
 * normalized-key comparison with no fuzzy logic.
 */
function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Validate one raw service entry into a typed {@link PriceSeedEntry}, loud on any defect. */
function parseEntry(name: string, raw: unknown): PriceSeedEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PriceSeedError(
      `service ${JSON.stringify(name)} must be an object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const { amountMinor } = obj;
  if (
    typeof amountMinor !== "number" ||
    !Number.isInteger(amountMinor) ||
    amountMinor < 0
  ) {
    throw new PriceSeedError(
      `service ${JSON.stringify(name)} amountMinor must be a non-negative integer, got ${JSON.stringify(amountMinor)}`,
    );
  }

  const { currency } = obj;
  if (typeof currency !== "string" || currency.trim() === "") {
    throw new PriceSeedError(
      `service ${JSON.stringify(name)} currency must be a non-empty string, got ${JSON.stringify(currency)}`,
    );
  }

  const { billingCycle } = obj;
  if (typeof billingCycle !== "string" || !VALID_BILLING_CYCLES.has(billingCycle)) {
    throw new PriceSeedError(
      `service ${JSON.stringify(name)} billingCycle must be a valid BillingCycle, got ${JSON.stringify(billingCycle)}`,
    );
  }

  return {
    amountMinor,
    currency,
    // Validated against the BillingCycle enum above, so the cast is sound.
    billingCycle: billingCycle as BillingCycle,
  };
}

/**
 * Validate a raw (`unknown`) object into a typed {@link PriceSeed}, failing
 * LOUDLY on any defect so a corrupt bundle is never a silent empty table.
 *
 * Checks, in order:
 *   1. The value is a non-null, non-array object.
 *   2. `schemaVersion` is exactly {@link PRICE_SEED_SCHEMA_VERSION} (integer).
 *   3. `asOf` is a `YYYY-MM-DD` string AND a real calendar date (not just the
 *      right shape) — a shape-valid-but-impossible date throws here.
 *   4. `disclaimer` is a non-empty string.
 *   5. `services` is an object; every entry is a valid {@link PriceSeedEntry}
 *      (integer ≥ 0 `amountMinor`, non-empty `currency`, valid `billingCycle`).
 *      Keys are re-normalized (trim + lowercase) so lookup is a stable exact
 *      match regardless of how the asset was authored.
 *
 * @throws PriceSeedError on any bad shape / schema / asOf / disclaimer / entry.
 */
export function parsePriceSeed(raw: unknown): PriceSeed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PriceSeedError(
      `price seed must be an object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const { schemaVersion } = obj;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new PriceSeedError(`schemaVersion must be an integer, got ${JSON.stringify(schemaVersion)}`);
  }
  if (schemaVersion !== PRICE_SEED_SCHEMA_VERSION) {
    throw new PriceSeedError(
      `unsupported schemaVersion ${schemaVersion}; this build supports ${PRICE_SEED_SCHEMA_VERSION}`,
    );
  }

  const { asOf } = obj;
  if (typeof asOf !== "string" || !AS_OF_RE.test(asOf)) {
    throw new PriceSeedError(`asOf must be a YYYY-MM-DD date string, got ${JSON.stringify(asOf)}`);
  }
  // Reject a shape-valid-but-impossible calendar date (e.g. "2026-13-99") LOUDLY
  // at parse time, so a corrupt seed fails HERE in the main process (degrading
  // the feature off) and never reaches the renderer — where `isSeedStale`'s
  // strict date math would otherwise throw outside the modal's try/catch.
  parseISODateStrict(asOf);

  const { disclaimer } = obj;
  if (typeof disclaimer !== "string" || disclaimer.trim() === "") {
    throw new PriceSeedError(`disclaimer must be a non-empty string, got ${JSON.stringify(disclaimer)}`);
  }

  const { services } = obj;
  if (typeof services !== "object" || services === null || Array.isArray(services)) {
    throw new PriceSeedError(`services must be an object, got ${services === null ? "null" : typeof services}`);
  }

  const validatedServices: Record<string, PriceSeedEntry> = {};
  for (const [name, value] of Object.entries(services as Record<string, unknown>)) {
    // Re-key by the normalized name so a lookup is a stable exact match even if
    // the asset carried mixed case / stray whitespace in a key.
    validatedServices[normalizeName(name)] = parseEntry(name, value);
  }

  return {
    schemaVersion,
    asOf,
    disclaimer,
    services: validatedServices,
  };
}

/**
 * Look up a suggestion for `rawName` in a validated {@link PriceSeed}.
 *
 * The query is normalized (trim + lowercase) and matched EXACTLY against the
 * seed's normalized keys — there is NO fuzzy matching (the PRD rejected
 * auto-detection; a wrong confident price is worse than none). On a match, the
 * entry's figures are returned alongside the seed's `asOf` (so the UI can show
 * the dated note and the renderer can apply {@link isSeedStale}); on no match
 * (including an empty/whitespace query), returns `null`. Pure: the seed is never
 * mutated.
 */
export function lookupSuggestion(seed: PriceSeed, rawName: string): PriceSuggestion | null {
  const key = normalizeName(rawName);
  if (key === "") return null;
  const entry = seed.services[key];
  if (entry === undefined) return null;
  return {
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    billingCycle: entry.billingCycle,
    asOf: seed.asOf,
  };
}

/**
 * Whether a seed is stale: `true` IFF `asOf` is strictly MORE than `maxAgeDays`
 * days older than `today`; otherwise `false`.
 *
 * Boundary: exactly `maxAgeDays` days old is NOT stale (strictly greater is
 * stale). A future-dated or same-day seed (age ≤ 0) is never stale. Day age is
 * exact UTC epoch-day arithmetic (same `Date.UTC(...)` convention as
 * `core/renewal.ts` / `core/money.ts`), so DST / timezones never shift the
 * verdict.
 *
 * Pure (AD-1): both dates are injected `YYYY-MM-DD` strings; no wall-clock. The
 * renderer passes a `today` derived from `new Date().toISOString()` (UTC), so
 * staleness is a UTC day comparison, keeping core deterministic. A ±1-day
 * near-midnight edge on a ~365-day guard is immaterial, so no local-date
 * formatter is used.
 *
 * @param asOf       the seed's `asOf` date (`YYYY-MM-DD`).
 * @param today      the caller's today (`YYYY-MM-DD`, UTC day).
 * @param maxAgeDays the staleness threshold in whole days (≈ 365 for the ~1yr guard).
 * @throws PriceSeedError if `asOf` or `today` is not a valid `YYYY-MM-DD` date
 *                        (never a silent "fresh").
 */
export function isSeedStale(asOf: string, today: string, maxAgeDays: number): boolean {
  const ageDays = daysBetweenUTC(asOf, today);
  return ageDays > maxAgeDays;
}

// --- Local date helpers (UTC epoch-day arithmetic; mirrors core/money.ts) ----

/** Parse a strict `YYYY-MM-DD` string into UTC parts, loud on a bad/non-real date. */
function parseISODateStrict(iso: string): { year: number; month: number; day: number } {
  if (typeof iso !== "string" || !AS_OF_RE.test(iso)) {
    throw new PriceSeedError(`date must be a YYYY-MM-DD string, got ${JSON.stringify(iso)}`);
  }
  const [year, month, day] = iso.split("-").map((part) => Number.parseInt(part, 10));
  const utcMs = Date.UTC(year, month - 1, day);
  const d = new Date(utcMs);
  // Reject non-real dates: `Date.UTC` silently normalizes (month 13 -> next
  // year, day 32 -> next month), so a valid date must round-trip to itself.
  if (
    !Number.isFinite(utcMs) ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    throw new PriceSeedError(`date is not a valid calendar date: ${JSON.stringify(iso)}`);
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
