/**
 * Export serialization (Req 17.1, 17.2, 17.3 / FR-17).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * Serializes subscriptions (+ settings) to JSON or CSV. Every monetary value is
 * emitted as a MAJOR-UNIT DECIMAL string produced by {@link toMajor} using that
 * amount's OWN currency (the single `core/money` exponent seam) — never the raw
 * integer `amountMinor` and never a hand-rolled `/100`. So a user opening the
 * file sees "9.99" (USD), "1000" (JPY, exponent 0), "1.234" (BHD, exponent 3),
 * and the value round-trips back to the exact integer minor units on import via
 * `core/money.minorUnits` (Story 7.2). Each exported record carries each amount's
 * own `currency` so a mixed-currency file is self-describing — there is no single
 * assumed exponent.
 *
 * The main process writes the returned string to the user-chosen path and reports
 * `{path, bytes}` (Req 17.1, 17.2) — that plumbing is unchanged; the content here
 * is produced purely.
 */

import type { SubscriptionV2, TrialV2, PriceEntryV2 } from "./models/subscription";
import type { SettingsV2 } from "./models/settings";
import { toMajor } from "./money";

/**
 * Schema/format version embedded in JSON exports.
 *
 * Version 3 (Story 7.1 / FR-17) identifies the MAJOR-DECIMAL money representation:
 * monetary fields are serialized as major-unit decimal strings (the top-level
 * `amount`, the nested `trial.postAmount`, and each `priceHistory[].amount`), each
 * with its own `currency`, rather than the raw integer minor units used by the
 * earlier `version: 2` on-disk/export shape. The importer (Story 7.2) keys on this
 * version to parse the major decimals back to integer minor units value-exact via
 * `core/money.minorUnits`.
 */
export const EXPORT_VERSION = 3;

/**
 * Export-shape of a {@link TrialV2}: identical to the stored trial except the
 * integer minor `postAmountMinor` is replaced by a major-unit decimal `postAmount`
 * string (formatted in the subscription's own currency via {@link toMajor}).
 */
export type ExportTrial =
  | {
      endDate: string;
      startDate?: string;
      postAmount: string; // major-unit decimal (was postAmountMinor)
    }
  | {
      startDate: string;
      lengthDays: number;
      postAmount: string; // major-unit decimal (was postAmountMinor)
    };

/**
 * Export-shape of a {@link PriceEntryV2}: the integer minor `amountMinor` becomes
 * a major-unit decimal `amount` string formatted in the entry's OWN `currency`.
 */
export interface ExportPriceEntry {
  amount: string; // major-unit decimal (was amountMinor)
  currency: string;
  date: string;
}

/**
 * Export-shape of a {@link SubscriptionV2}: the top-level integer minor
 * `amountMinor` becomes a major-unit decimal `amount` string (formatted in the
 * subscription's own `currency`), and the nested trial/price-history amounts are
 * majored too. All other fields carry over verbatim. The `currency` field is
 * retained so each major amount is unambiguous in a mixed-currency file.
 */
export interface ExportSubscription {
  id: string;
  name: string;
  provider: string;
  category: string;
  amount: string; // major-unit decimal (was amountMinor)
  currency: string;
  billingCycle: SubscriptionV2["billingCycle"];
  customInterval?: SubscriptionV2["customInterval"];
  nextRenewal: string;
  startDate: string;
  paymentMethod: string;
  website: string;
  notes: string;
  color: string;
  icon: string;
  state: SubscriptionV2["state"];
  trial?: ExportTrial;
  priceHistory: ExportPriceEntry[];
  tags: string[];
  autoRenew: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shape of a JSON export.
 *
 * `{version, subscriptions, settings}`: the `version` identifies the money
 * representation (see {@link EXPORT_VERSION}), `subscriptions` carries the
 * major-decimal {@link ExportSubscription} records, and `settings` carries the
 * full v2 Settings object so a single export file holds all of the user's data
 * (Req 17.1).
 */
export interface ExportFile {
  version: number;
  subscriptions: ExportSubscription[];
  settings: SettingsV2;
}

/**
 * Convert a stored {@link TrialV2} to its export shape, majoring `postAmountMinor`
 * through the `currency` seam. The trial amount is in the subscription's Native
 * Currency, so the owning subscription's `currency` is used.
 */
function toExportTrial(trial: TrialV2, currency: string): ExportTrial {
  const postAmount = toMajor(trial.postAmountMinor, currency);
  // Discriminate on the field that is STRUCTURALLY PRESENT in each variant:
  // the start+days variant has a numeric `lengthDays`; everything else is the
  // explicit-end-date variant. This can't silently emit {startDate:undefined,
  // lengthDays:undefined} for a malformed trial the way an `endDate`-presence
  // check could (the union marks the other variant's `endDate`/`lengthDays` as
  // `never`, so a built object may carry the key as `undefined`).
  if (typeof trial.lengthDays === "number") {
    return { startDate: trial.startDate, lengthDays: trial.lengthDays, postAmount };
  }
  const { startDate } = trial;
  return startDate === undefined
    ? { endDate: trial.endDate, postAmount }
    : { endDate: trial.endDate, startDate, postAmount };
}

/**
 * Convert a stored {@link PriceEntryV2} to its export shape, majoring
 * `amountMinor` through the entry's OWN `currency` (a historical entry may be in
 * a different currency than the current subscription amount).
 */
function toExportPriceEntry(entry: PriceEntryV2): ExportPriceEntry {
  return {
    amount: toMajor(entry.amountMinor, entry.currency),
    currency: entry.currency,
    date: entry.date,
  };
}

/**
 * Convert a stored {@link SubscriptionV2} to its export shape (major-decimal
 * money). Every monetary value — the top-level amount, the nested trial post
 * amount, and each price-history entry — is routed through {@link toMajor} using
 * that amount's own currency. This is the single "to-export-shape" transform both
 * {@link exportJson} and {@link exportCsv} use, so the two formats never diverge
 * on money.
 *
 * An unknown currency makes {@link toMajor} throw ({@link
 * import("./money").UnknownCurrencyError}), so a mis-table'd amount fails the
 * export loudly rather than emitting a silently wrong scale.
 */
export function toExportSubscription(sub: SubscriptionV2): ExportSubscription {
  return {
    id: sub.id,
    name: sub.name,
    provider: sub.provider,
    category: sub.category,
    amount: toMajor(sub.amountMinor, sub.currency),
    currency: sub.currency,
    billingCycle: sub.billingCycle,
    ...(sub.customInterval !== undefined ? { customInterval: sub.customInterval } : {}),
    nextRenewal: sub.nextRenewal,
    startDate: sub.startDate,
    paymentMethod: sub.paymentMethod,
    website: sub.website,
    notes: sub.notes,
    color: sub.color,
    icon: sub.icon,
    state: sub.state,
    ...(sub.trial !== undefined ? { trial: toExportTrial(sub.trial, sub.currency) } : {}),
    priceHistory: sub.priceHistory.map(toExportPriceEntry),
    tags: [...sub.tags],
    autoRenew: sub.autoRenew,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
  };
}

/**
 * Serialize subscriptions and settings to a pretty-printed JSON string in the
 * {@link ExportFile} shape (Req 17.1, 17.2, 17.3 / FR-17).
 *
 * Each subscription record carries its major-unit decimal `amount` + its own
 * `currency` (and the major nested trial/price amounts), so a mixed-currency file
 * is self-describing and the importer (Story 7.2) parses each amount back to the
 * exact integer minor units via `core/money.minorUnits`.
 */
export function exportJson(subs: SubscriptionV2[], settings: SettingsV2): string {
  const file: ExportFile = {
    version: EXPORT_VERSION,
    subscriptions: subs.map(toExportSubscription),
    settings,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Ordered CSV field keys — one per editable/system {@link SubscriptionV2} field,
 * in the same order as the interface. This is the authoritative COLUMN SET + ORDER
 * (capability parity: no column dropped, reordered, or renamed-away). The header
 * NAME each key is written under is given by {@link csvHeaderLabel} — only the
 * money column's header differs from its stored key (`amountMinor` → the human
 * `amount`, same position), because its serialized value is now a major decimal.
 *
 * Object/array fields (`customInterval`, `trial`, `priceHistory`, `tags`) are
 * serialized into a single JSON cell (see {@link serializeCell}); the `trial` and
 * `priceHistory` cells carry their money sub-fields as major decimals.
 */
export const CSV_COLUMNS: readonly (keyof SubscriptionV2)[] = [
  "id",
  "name",
  "provider",
  "category",
  "amountMinor",
  "currency",
  "billingCycle",
  "customInterval",
  "nextRenewal",
  "startDate",
  "paymentMethod",
  "website",
  "notes",
  "color",
  "icon",
  "state",
  "trial",
  "priceHistory",
  "tags",
  "autoRenew",
  "createdAt",
  "updatedAt",
];

/**
 * Human CSV header name for a column key. All keys map to themselves EXCEPT the
 * money column, whose header is renamed in place from the stored key `amountMinor`
 * to the human `amount` — the column keeps its SET position (capability parity);
 * only its header name and value representation change, because the value is now a
 * major-unit decimal rather than raw minor units.
 */
export function csvHeaderLabel(column: keyof SubscriptionV2): string {
  return column === "amountMinor" ? "amount" : column;
}

/** The CSV header row names, in column order (money column renamed in place). */
export const CSV_HEADERS: readonly string[] = CSV_COLUMNS.map(csvHeaderLabel);

/**
 * Quote a single CSV field per RFC 4180 when it contains a comma, double
 * quote, carriage return, or line feed. Embedded double quotes are escaped by
 * doubling them. Fields without special characters are returned unchanged.
 */
function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Convert a {@link SubscriptionV2} field value to its raw (pre-escape) CSV cell
 * string.
 *
 *   - `amountMinor` -> MAJOR-unit decimal via {@link toMajor} (the human `amount`
 *     column), formatted in the subscription's own `currency`.
 *   - `customInterval` (object | undefined) -> JSON cell, or "" absent.
 *   - `trial` (object | undefined) -> JSON cell in {@link ExportTrial} shape
 *     (major `postAmount`), or "" absent.
 *   - `priceHistory` (array) -> JSON cell of {@link ExportPriceEntry} (major
 *     `amount` per entry); `tags` (array) -> JSON cell (`[]` when empty).
 *   - `state` (enum string) -> as-is.
 *   - booleans -> "true" / "false".
 *   - other strings -> as-is.
 *
 * The JSON cells let CSV import reconstruct the object/array fields via
 * `JSON.parse` (Req 17.3), with their money sub-fields now major decimals.
 */
function serializeCell(column: keyof SubscriptionV2, sub: SubscriptionV2): string {
  // Money column: the top-level amount as a major-unit decimal in the sub's own
  // currency (never the raw minor int, never a hand-rolled /100).
  if (column === "amountMinor") {
    return toMajor(sub.amountMinor, sub.currency);
  }
  // Optional object field: emit a JSON cell, or "" when absent.
  if (column === "customInterval") {
    const value = sub.customInterval;
    return value === undefined ? "" : JSON.stringify(value);
  }
  // Trial: a major-money JSON cell, or "" when absent.
  if (column === "trial") {
    return sub.trial === undefined
      ? ""
      : JSON.stringify(toExportTrial(sub.trial, sub.currency));
  }
  // Price history: a JSON cell of major-money entries.
  if (column === "priceHistory") {
    return JSON.stringify(sub.priceHistory.map(toExportPriceEntry));
  }
  // Tags: a JSON cell (`[]` when empty).
  if (column === "tags") {
    return JSON.stringify(sub.tags);
  }
  const value = sub[column];
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value as string;
}

/**
 * Serialize subscriptions to a CSV string with a header row and one row per
 * subscription (Req 17.1, 17.2). All Subscription columns are included
 * (see {@link CSV_COLUMNS}); the money column's header is the human `amount` and
 * its value is a major-unit decimal. Every cell is escaped for
 * commas/quotes/newlines.
 *
 * Rows are joined with CRLF per RFC 4180. The output has no trailing newline.
 */
export function exportCsv(subs: SubscriptionV2[]): string {
  const header = CSV_HEADERS.map((c) => escapeCsv(c)).join(",");
  const rows = subs.map((sub) =>
    CSV_COLUMNS.map((c) => escapeCsv(serializeCell(c, sub))).join(","),
  );
  return [header, ...rows].join("\r\n");
}
