/**
 * Pure v1 -> v2 migrators (AD-15 / FR-29).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's
 * `fs`, and reads no wall-clock or filesystem (AD-1). Every function here takes
 * an already-parsed v1 object and returns a plain v2 object; the caller (Story
 * 1.4) owns the reading, the pre-migration backup, and the atomic write-back.
 *
 * The v1 -> v2 transform enumerates **every** field change (AD-15):
 *   - `amount` (float major)        -> `amountMinor` (integer minor units, via
 *                                      `core/money.ts`, round-half-up — see below)
 *   - per-sub `currency`            -> kept as-is (now the Native Currency)
 *   - `isActive` (boolean)          -> `state` ("Active" | "Paused")
 *   - `settings.defaultCurrency`    -> `homeCurrency`
 *   - new fields initialized to safe empties:
 *       `trial` absent, `priceHistory: []`, `tags: []`,
 *       `settings.online: { liveLogoFetch: false, fxRefresh: false }`
 * All other fields carry over unchanged.
 *
 * Money rounding rule (stated and deterministic):
 *   A v1 float `amount` is **rounded half-up** to the Native Currency's
 *   minor-unit exponent, then stored as integer minor units. The decision uses
 *   the number's TRUE IEEE-754 value (its full dropped-digit suffix), never a
 *   pre-rounded guard digit, so there is no double-rounding. So:
 *     9.999  USD (exp 2) -> 1000     (first dropped digit 9 -> up)
 *     1000   JPY (exp 0) -> 1000
 *     1.2355 KWD (exp 3) -> 1236     (a true >=-tie as a double -> up)
 *     1.2345 KWD (exp 3) -> 1234     (the double is 1.23449999…, below the tie)
 *     0.0048 USD (exp 2) -> 0        (first dropped digit 4 -> down)
 *   Rounding lives HERE, not in `money.ts`: `minorUnits` deliberately rejects
 *   over-precision (a user-entered over-precise amount is an error at entry),
 *   but a *migration* of pre-existing v1 float data must be total and
 *   lossless-as-possible, so it rounds half-up to the exponent first and only
 *   then converts. We never loosen `money.ts`.
 */

import { exponentOf, minorUnits, InvalidAmountError, AmountOverflowError } from "core/money";
import { subscriptionsFileV2Schema, settingsFileV2Schema } from "core/models/schema";
import type { Subscription, SubscriptionsFile, SubscriptionV2, SubscriptionsFileV2 } from "core/models/subscription";
import type { Settings, SettingsFile, SettingsV2, SettingsFileV2 } from "core/models/settings";

/**
 * Thrown when a v1 record cannot be transformed into a schema-valid v2 record.
 * The migrator is total: it either returns a valid v2 object or throws — it
 * never emits a partially-migrated record (Story 1.4 relies on validate-then-
 * write-back). The wrapped `cause` carries the underlying zod/money error.
 */
export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/**
 * Guard fractional digits rendered BEYOND the exponent so the full dropped
 * suffix (not just a single pre-rounded digit) decides the round. A double's
 * fixed-decimal expansion past the exponent reveals both the true first-dropped
 * digit and whether anything after it is non-zero, which is exactly what a
 * correct half-up decision needs. 30 is far more than enough to distinguish a
 * genuine `...5000` tie from a `...479999` near-miss at any realistic exponent,
 * while `exponent + 30` stays well under `toFixed`'s 100-digit cap.
 */
const ROUND_GUARD_DIGITS = 30;

/**
 * Round a non-negative v1 float major `amount` **half-up** to `exponent`
 * fractional digits, returning the result as an exact decimal **string** (so it
 * can be handed to `minorUnits` with no over-precision).
 *
 * The decision is made on the number's FULL dropped suffix, never on a single
 * pre-rounded guard digit — rounding on `toFixed(exponent + 1)` would
 * double-round (`toFixed` itself rounds the one guard digit, inflating e.g.
 * `0.0048` to the `0.005` tie and then rounding it up). Instead we render many
 * guard digits and apply the half-up rule ourselves: round up only when the
 * first dropped digit is `> 5`, OR it is `== 5` with any non-zero digit after
 * it, OR it is exactly `5` followed by only zeros (a true tie). All arithmetic
 * is exact base-10 BigInt — no floating-point multiply/divide.
 */
export function roundHalfUpToExponent(amount: number, exponent: number): string {
  if (!Number.isFinite(amount)) {
    throw new InvalidAmountError(`amount must be a finite number, got ${amount}`);
  }
  if (amount < 0) {
    throw new InvalidAmountError(`amount must be non-negative, got ${amount}`);
  }

  // Fixed-decimal expansion with a generous dropped suffix. `toFixed` returns
  // exponential notation (e.g. "1e+21") for very large magnitudes, which is not
  // base-10 digits we can round — surface that as a typed overflow error up
  // front so a direct caller never sees a raw BigInt SyntaxError.
  const text = amount.toFixed(exponent + ROUND_GUARD_DIGITS);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new AmountOverflowError(
      `amount (${amount}) is too large to round in fixed-decimal form (got ${JSON.stringify(text)})`,
    );
  }
  const [intPart, fracPart = ""] = text.split(".");

  // Digits kept vs. dropped. Under round-half-UP, the decision depends only on
  // the true first dropped digit: `>= 5` rounds up (a bare `5` tie rounds up,
  // and anything above a `5` tie rounds up too), `< 5` rounds down — regardless
  // of the digits after it. Reading the first dropped digit from the full
  // expansion (not a pre-rounded guard digit) is what fixes the double-round:
  // `0.0048` expands to `0.00479999…`, whose first dropped digit at exponent 2
  // is `4`, so it correctly rounds DOWN.
  const kept = fracPart.slice(0, exponent);
  const dropped = fracPart.slice(exponent);
  const firstDropped = dropped.length > 0 ? dropped.charCodeAt(0) - 48 : 0;
  const roundUp = firstDropped >= 5;

  // Combine int + kept fractional digits into one base-10 integer, then apply
  // the (already-decided) half-up carry. Exact BigInt arithmetic throughout.
  const combined = BigInt(`${intPart}${kept}`);
  const roundedCombined = roundUp ? combined + 1n : combined;

  if (exponent === 0) {
    return roundedCombined.toString();
  }
  const combinedText = roundedCombined.toString().padStart(exponent + 1, "0");
  const newInt = combinedText.slice(0, combinedText.length - exponent).replace(/^0+(?=\d)/, "");
  const newFrac = combinedText.slice(combinedText.length - exponent);
  return `${newInt}.${newFrac}`;
}

/**
 * Convert a v1 float major `amount` in `currency` to integer minor units,
 * rounding half-up to the currency's exponent first (the stated migration
 * rule). An over-huge amount surfaces `money.ts`'s overflow error unchanged.
 */
export function migrateAmountToMinor(amount: number, currency: string): number {
  const exponent = exponentOf(currency); // throws UnknownCurrencyError on unknown
  const rounded = roundHalfUpToExponent(amount, exponent);
  return minorUnits(rounded, currency);
}

/**
 * Transform a single v1 `Subscription` into a v2 `SubscriptionV2`.
 *
 * - `amount` -> `amountMinor` (round-half-up to the Native Currency exponent)
 * - `currency` kept as-is (Native Currency)
 * - `isActive` -> `state` (`true` -> "Active", `false` -> "Paused")
 * - `trial` absent, `priceHistory: []`, `tags: []`
 * - all other fields carry over unchanged
 *
 * Does **not** validate on its own — whole-file migration validates the result
 * against the v2 zod schema before returning (the file is the unit Story 1.4
 * writes back). Throws on an unknown currency or an un-convertible amount.
 */
export function migrateSubscriptionV1toV2(v1: Subscription): SubscriptionV2 {
  const { amount, isActive, ...rest } = v1;
  const amountMinor = migrateAmountToMinor(amount, v1.currency);
  const state = isActive ? "Active" : "Paused";

  const v2: SubscriptionV2 = {
    id: rest.id,
    name: rest.name,
    provider: rest.provider,
    category: rest.category,
    amountMinor,
    currency: rest.currency,
    billingCycle: rest.billingCycle,
    // `customInterval` carries over only when present (undefined would fail the
    // Custom-cycle refinement anyway, which is the intended behavior).
    ...(rest.customInterval !== undefined ? { customInterval: rest.customInterval } : {}),
    nextRenewal: rest.nextRenewal,
    startDate: rest.startDate,
    paymentMethod: rest.paymentMethod,
    website: rest.website,
    notes: rest.notes,
    color: rest.color,
    icon: rest.icon,
    state,
    // `trial` is deliberately absent (safe empty); initialized here, not later.
    priceHistory: [],
    tags: [],
    autoRenew: rest.autoRenew,
    createdAt: rest.createdAt,
    updatedAt: rest.updatedAt,
  };
  return v2;
}

/**
 * Transform v1 `Settings` into v2 `SettingsV2`:
 *   - `defaultCurrency` -> `homeCurrency`
 *   - adds `online: { liveLogoFetch: false, fxRefresh: false }` (all-false)
 *   - adds `lastBackupAt: null` (Story 7.3 — a migrated user has no routine
 *     backup history yet; mirrors the all-false `online` addition)
 *   - all other fields carry over unchanged
 */
export function migrateSettingsV1toV2(v1: Settings): SettingsV2 {
  const { defaultCurrency, ...rest } = v1;
  return {
    homeCurrency: defaultCurrency,
    notification: {
      enabled: rest.notification.enabled,
      leadTimes: [...rest.notification.leadTimes],
    },
    backupFrequency: rest.backupFrequency,
    theme: rest.theme,
    accentColor: rest.accentColor,
    trayMode: rest.trayMode,
    dataFolder: rest.dataFolder,
    online: { liveLogoFetch: false, fxRefresh: false },
    lastBackupAt: null,
  };
}

/**
 * Migrate a whole v1 `subscriptions.json` ({version:1, subscriptions:[...]})
 * into a v2 file ({version:2, subscriptions:[...v2]}), **validated** against
 * `subscriptionsFileV2Schema` before returning.
 *
 * Total: a record that cannot transform throws `MigrationError` — the function
 * never returns a partially-migrated file (Story 1.4 writes back only a
 * validated whole file).
 */
export function migrateSubscriptionsFileV1toV2(file: SubscriptionsFile): SubscriptionsFileV2 {
  let migrated: unknown[];
  try {
    migrated = file.subscriptions.map((sub) => migrateSubscriptionV1toV2(sub));
  } catch (cause) {
    throw new MigrationError("failed to migrate a subscription from v1 to v2", { cause });
  }

  const candidate = { version: 2 as const, subscriptions: migrated };
  const result = subscriptionsFileV2Schema.safeParse(candidate);
  if (!result.success) {
    throw new MigrationError(
      `migrated subscriptions file is not valid v2: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Migrate a whole v1 `settings.json` (Settings + {version:1}) into a v2 file,
 * **validated** against `settingsFileV2Schema` before returning. Throws
 * `MigrationError` on an invalid result.
 */
export function migrateSettingsFileV1toV2(file: SettingsFile): SettingsFileV2 {
  const { version: _v1Version, ...settingsV1 } = file;
  const migratedSettings = migrateSettingsV1toV2(settingsV1);
  const candidate = { ...migratedSettings, version: 2 as const };

  const result = settingsFileV2Schema.safeParse(candidate);
  if (!result.success) {
    throw new MigrationError(
      `migrated settings file is not valid v2: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}
