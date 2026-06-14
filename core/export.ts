/**
 * Export serialization (Req 17.1, 17.2, 17.3).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * Serializes subscriptions (+ settings) to JSON or CSV. The JSON output uses
 * EXACTLY the shape the Import_Service validates, so an export can be fed
 * straight back into import for a faithful round-trip (Req 17.3). The main
 * process writes the returned string to the user-chosen path (Req 17.1, 17.2).
 */

import type { Subscription } from "./models/subscription";
import type { Settings } from "./models/settings";

/**
 * Schema/format version embedded in JSON exports. Matches the on-disk
 * `subscriptions.json` file version so the importer can validate the same way.
 */
export const EXPORT_VERSION = 1;

/**
 * Shape of a JSON export.
 *
 * This is the {@link SubscriptionsFile} shape (`version` + `subscriptions`)
 * augmented with a `settings` object so a single export file carries all of
 * the user's data (Req 17.1). The Import_Service (task 7.2) reads the
 * `subscriptions` array from this object; the extra `settings` field is
 * additive and ignored by subscription validation.
 *
 * Importer contract (so task 7.2 can match this exactly):
 *   {
 *     "version": 1,
 *     "subscriptions": Subscription[],   // validated per-record by the importer
 *     "settings": Settings               // full Settings object (Req 17.1)
 *   }
 */
export interface ExportFile {
  version: number;
  subscriptions: Subscription[];
  settings: Settings;
}

/**
 * Serialize subscriptions and settings to a pretty-printed JSON string in the
 * importer-compatible {@link ExportFile} shape (Req 17.1, 17.2, 17.3).
 *
 * Feeding this output back into the importer reproduces the subscription set,
 * guaranteeing the export -> import round-trip (Req 17.3).
 */
export function exportJson(subs: Subscription[], settings: Settings): string {
  const file: ExportFile = {
    version: EXPORT_VERSION,
    subscriptions: subs,
    settings,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Ordered CSV columns — one per editable/system Subscription field, in the
 * same order as the {@link Subscription} interface. `customInterval` is
 * serialized into a single cell (see {@link serializeCell}) so CSV import can
 * reconstruct it consistently (Req 17.3).
 */
export const CSV_COLUMNS: readonly (keyof Subscription)[] = [
  "id",
  "name",
  "provider",
  "category",
  "amount",
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
  "isActive",
  "autoRenew",
  "createdAt",
  "updatedAt",
];

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
 * Convert a Subscription field value to its raw (pre-escape) CSV cell string.
 *
 *   - `customInterval` (object | undefined) -> JSON cell, or "" when absent.
 *   - booleans -> "true" / "false".
 *   - numbers  -> their string form.
 *   - strings  -> as-is.
 *
 * The JSON cell for `customInterval` lets CSV import reconstruct the object via
 * `JSON.parse` for the Custom billing cycle (Req 17.3).
 */
function serializeCell(column: keyof Subscription, sub: Subscription): string {
  if (column === "customInterval") {
    return sub.customInterval === undefined
      ? ""
      : JSON.stringify(sub.customInterval);
  }
  const value = sub[column];
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value as string;
}

/**
 * Serialize subscriptions to a CSV string with a header row and one row per
 * subscription (Req 17.1, 17.2). All Subscription columns are included
 * (see {@link CSV_COLUMNS}); every cell is escaped for commas/quotes/newlines.
 *
 * Rows are joined with CRLF per RFC 4180. The output has no trailing newline.
 */
export function exportCsv(subs: Subscription[]): string {
  const header = CSV_COLUMNS.map((c) => escapeCsv(c)).join(",");
  const rows = subs.map((sub) =>
    CSV_COLUMNS.map((c) => escapeCsv(serializeCell(c, sub))).join(","),
  );
  return [header, ...rows].join("\r\n");
}
