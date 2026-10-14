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

import type { SubscriptionV2 } from "./models/subscription";
import type { SettingsV2 } from "./models/settings";

/**
 * Schema/format version embedded in JSON exports. Matches the on-disk
 * `subscriptions.json` file version (now 2, Story 3.3) so the importer can
 * validate the same way with the v2 schema.
 */
export const EXPORT_VERSION = 2;

/**
 * Shape of a JSON export.
 *
 * This is the {@link SubscriptionsFileV2} shape (`version` + `subscriptions`)
 * augmented with a `settings` object so a single export file carries all of
 * the user's data (Req 17.1). The Import_Service reads the `subscriptions`
 * array from this object; the extra `settings` field is additive and ignored by
 * subscription validation.
 *
 * Importer contract:
 *   {
 *     "version": 2,
 *     "subscriptions": SubscriptionV2[], // validated per-record by the importer
 *     "settings": SettingsV2             // full v2 Settings object (Req 17.1)
 *   }
 */
export interface ExportFile {
  version: number;
  subscriptions: SubscriptionV2[];
  settings: SettingsV2;
}

/**
 * Serialize subscriptions and settings to a pretty-printed JSON string in the
 * importer-compatible {@link ExportFile} shape (Req 17.1, 17.2, 17.3).
 *
 * Feeding this output back into the importer reproduces the subscription set,
 * guaranteeing the export -> import round-trip (Req 17.3).
 */
export function exportJson(subs: SubscriptionV2[], settings: SettingsV2): string {
  const file: ExportFile = {
    version: EXPORT_VERSION,
    subscriptions: subs,
    settings,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Ordered CSV columns — one per editable/system {@link SubscriptionV2} field, in
 * the same order as the interface. Object/array fields (`customInterval`,
 * `trial`, `priceHistory`, `tags`) are serialized into a single JSON cell (see
 * {@link serializeCell}) so CSV import can reconstruct them consistently
 * (Req 17.3). `amount`→`amountMinor` (integer minor units) and
 * `isActive`→`state` (the three-way enum) are the v2 shape changes.
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
 *   - `customInterval` / `trial` (object | undefined) -> JSON cell, or "" absent.
 *   - `priceHistory` / `tags` (array)                 -> JSON cell (`[]` when empty).
 *   - `state` (enum string)                           -> as-is.
 *   - booleans -> "true" / "false".
 *   - numbers (`amountMinor`) -> their string form.
 *   - strings  -> as-is.
 *
 * The JSON cells let CSV import reconstruct the object/array fields via
 * `JSON.parse` (Req 17.3), reusing the `customInterval` JSON-cell pattern.
 */
function serializeCell(column: keyof SubscriptionV2, sub: SubscriptionV2): string {
  // Optional object fields: emit a JSON cell, or "" when absent.
  if (column === "customInterval" || column === "trial") {
    const value = sub[column];
    return value === undefined ? "" : JSON.stringify(value);
  }
  // Array fields always present on a v2 record: emit a JSON cell (`[]` empty).
  if (column === "priceHistory" || column === "tags") {
    return JSON.stringify(sub[column]);
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
export function exportCsv(subs: SubscriptionV2[]): string {
  const header = CSV_COLUMNS.map((c) => escapeCsv(c)).join(",");
  const rows = subs.map((sub) =>
    CSV_COLUMNS.map((c) => escapeCsv(serializeCell(c, sub))).join(","),
  );
  return [header, ...rows].join("\r\n");
}
