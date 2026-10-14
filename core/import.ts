/**
 * Import parsing, validation, and conflict resolution (Req 16.1, 16.2, 16.3, 16.5).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * `planImport` is PURE: it takes the current subscription set plus raw file
 * bytes (already read by the platform layer) and produces an {@link ImportOutcome}
 * describing the full new set to persist, how many records were imported or
 * skipped, and which records were rejected. The main-process handler is
 * responsible for the backup-before-apply sequence (Req 16.4) and for actually
 * writing `applied` to disk; this module performs no I/O.
 *
 * Round-trip contract (Req 17.3): the JSON shape produced by `core/export.ts`
 * ({@link ExportFile}) is consumed faithfully here — the importer reads the
 * `subscriptions` array (and also tolerates a bare `SubscriptionV2[]`). The CSV
 * shape produced by `exportCsv` (header = {@link CSV_COLUMNS}, RFC 4180
 * escaping, `customInterval`/`trial`/`priceHistory`/`tags` as JSON cells,
 * booleans as `true`/`false`, `amountMinor` as an integer, `state` as the enum
 * string) is parsed back with the same conventions.
 */

import type { SubscriptionV2 } from "./models/subscription";
import { subscriptionV2Schema } from "./models/schema";
import { CSV_COLUMNS } from "./export";
import type { ConflictMode } from "shared/types";

/**
 * Result of planning an import.
 *
 * `applied` is the FULL new subscription set to persist — it starts from the
 * existing set and is grown/updated per the conflict mode, so existing valid
 * data is never discarded even when some incoming records are rejected
 * (Req 16.5). `rejected.row` is the 0-based index of the offending record
 * within the incoming data (the `subscriptions` array for JSON, the data rows
 * for CSV); a file-level parse failure is reported as row `0`.
 */
export interface ImportOutcome {
  /** The new full set to persist (existing + resolved incoming records). */
  applied: SubscriptionV2[];
  /** Count of incoming records added or applied (new, Replace, or Merge). */
  imported: number;
  /** Count of incoming duplicates left unchanged (Skip mode). */
  skipped: number;
  /** Records that failed parsing/validation, with their row index and reason. */
  rejected: { row: number; reason: string }[];
}

/**
 * Parse, validate, and conflict-resolve an import against the existing set
 * (Req 16.1, 16.2, 16.3, 16.5).
 *
 * Pipeline:
 *   1. Parse by `format` (JSON or CSV). A whole-file parse failure is reported
 *      as a single rejected record (row 0) and leaves `existing` untouched.
 *   2. Validate each record against the Subscription schema; failures are
 *      collected with their row index and reason (Req 16.1, 16.2).
 *   3. Detect duplicates against the working set by `id`, or by `name + provider`
 *      when there is no `id` match (Req 16.3).
 *   4. Resolve duplicates via `mode`: Replace overwrites, Merge fills only the
 *      missing/empty fields of the existing record (preserving its identity and
 *      existing values), Skip keeps the existing record.
 *
 * The function never mutates its inputs and never reads the clock or the
 * filesystem.
 */
export function planImport(
  existing: SubscriptionV2[],
  incomingRaw: string,
  format: "json" | "csv",
  mode: ConflictMode,
): ImportOutcome {
  const rejected: { row: number; reason: string }[] = [];

  // 1. Parse raw bytes into a list of candidate records (one per row).
  const parsed =
    format === "json"
      ? parseJsonRecords(incomingRaw)
      : parseCsvRecords(incomingRaw);

  if (!parsed.ok) {
    // Whole-file parse failure: preserve existing data, report the failure.
    return {
      applied: existing.slice(),
      imported: 0,
      skipped: 0,
      rejected: [{ row: 0, reason: parsed.reason }],
    };
  }

  // The applied set begins as a copy of the existing data so partial failures
  // never discard valid records already on disk (Req 16.5).
  const applied: SubscriptionV2[] = existing.slice();
  let imported = 0;
  let skipped = 0;

  parsed.records.forEach((candidate, row) => {
    if (!candidate.ok) {
      rejected.push({ row, reason: candidate.reason });
      return;
    }

    // 2. Per-record schema validation (Req 16.1, 16.2).
    const result = subscriptionV2Schema.safeParse(candidate.value);
    if (!result.success) {
      rejected.push({ row, reason: formatZodError(result.error) });
      return;
    }
    const record = result.data as SubscriptionV2;

    // 3. Duplicate detection: by id first, then by name + provider (Req 16.3).
    const dupIndex = findDuplicateIndex(applied, record);

    if (dupIndex === -1) {
      // New record — always added regardless of conflict mode.
      applied.push(record);
      imported += 1;
      return;
    }

    // 4. Resolve the duplicate per the chosen conflict mode (Req 16.3).
    switch (mode) {
      case "Replace":
        applied[dupIndex] = record;
        imported += 1;
        break;
      case "Merge":
        applied[dupIndex] = mergeSubscription(applied[dupIndex], record);
        imported += 1;
        break;
      case "Skip":
        skipped += 1;
        break;
    }
  });

  return { applied, imported, skipped, rejected };
}

// --- Duplicate resolution ----------------------------------------------------

/**
 * Index of a duplicate of `record` within `set`: an `id` match wins; otherwise
 * a `name + provider` match is used (Req 16.3). Returns -1 when none match.
 */
function findDuplicateIndex(set: SubscriptionV2[], record: SubscriptionV2): number {
  const byId = set.findIndex((s) => s.id === record.id);
  if (byId !== -1) return byId;
  return set.findIndex(
    (s) => s.name === record.name && s.provider === record.provider,
  );
}

/**
 * Merge `incoming` into `existing`, filling only the fields of `existing` that
 * are missing or empty (`undefined`, `null`, or `""`) while preserving every
 * existing non-empty value. The existing record's identity (`id`) is always
 * kept so references remain stable. Numbers and booleans are never treated as
 * empty.
 */
function mergeSubscription(
  existing: SubscriptionV2,
  incoming: SubscriptionV2,
): SubscriptionV2 {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    if (current === undefined || current === null || current === "") {
      merged[key] = value;
    }
  }
  merged.id = existing.id; // preserve identity on a name+provider match
  return merged as unknown as SubscriptionV2;
}

// --- JSON parsing ------------------------------------------------------------

/** A single candidate record (pre-validation) or a per-row parse failure. */
type CandidateResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/** Outcome of parsing a whole file into candidate records. */
type ParseResult =
  | { ok: true; records: CandidateResult[] }
  | { ok: false; reason: string };

/**
 * Parse a JSON import. Reads the `subscriptions` array from the export shape
 * ({@link ExportFile}) and also tolerates a bare `SubscriptionV2[]`. Each element
 * is left as `unknown` for the schema to validate per record.
 */
function parseJsonRecords(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `Failed to parse JSON: ${errorMessage(err)}` };
  }

  let list: unknown;
  if (Array.isArray(data)) {
    list = data; // bare array form
  } else if (isRecord(data) && "subscriptions" in data) {
    list = (data as { subscriptions: unknown }).subscriptions; // export shape
  } else {
    return {
      ok: false,
      reason:
        "Expected a JSON object with a 'subscriptions' array or a bare array of subscriptions",
    };
  }

  if (!Array.isArray(list)) {
    return { ok: false, reason: "'subscriptions' must be an array" };
  }

  return { ok: true, records: list.map((value) => ({ ok: true, value })) };
}

// --- CSV parsing -------------------------------------------------------------

/**
 * Parse a CSV import produced by `exportCsv`. Honors RFC 4180 quoting (fields
 * wrapped in double quotes may contain commas, CR, LF, and doubled quotes) and
 * both CRLF and LF line endings. The first row is the header; columns are
 * mapped by name so a reordered header still works. Cell conventions mirror the
 * exporter: `customInterval` is a JSON cell (or `""` when absent), booleans are
 * `true`/`false`, and `amount` is a numeric string.
 */
function parseCsvRecords(raw: string): ParseResult {
  const rows = tokenizeCsv(raw);
  if (rows.length === 0) {
    return { ok: true, records: [] }; // empty file → nothing to import
  }

  const header = rows[0];
  const columnPos = new Map<string, number>();
  header.forEach((name, idx) => columnPos.set(name, idx));

  const records: CandidateResult[] = rows.slice(1).map((cells) => {
    try {
      return { ok: true, value: coerceCsvRow(cells, columnPos) };
    } catch (err) {
      return { ok: false, reason: `Invalid CSV row: ${errorMessage(err)}` };
    }
  });

  return { ok: true, records };
}

/**
 * Build a raw {@link SubscriptionV2}-shaped object from one CSV data row,
 * applying the exporter's cell conventions. Values whose target type cannot be
 * produced are left as their raw string so the schema validation reports a clear
 * error (Req 16.2) rather than this function guessing.
 *
 * v2 cell conventions:
 *   - `amountMinor`  → integer (empty stays a string so validation rejects it).
 *   - `state`        → the enum string, left as-is (no boolean coercion).
 *   - `autoRenew`    → boolean.
 *   - `customInterval` / `trial` → JSON cell, or absent/undefined when "".
 *   - `priceHistory` / `tags`    → JSON cell; a "" cell defaults to `[]` so a
 *     v2 record always carries these arrays (they are required by the schema).
 */
function coerceCsvRow(
  cells: string[],
  columnPos: Map<string, number>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const column of CSV_COLUMNS) {
    const pos = columnPos.get(column);
    const cell = pos === undefined ? "" : cells[pos] ?? "";

    switch (column) {
      case "amountMinor":
        // Empty stays a string so validation rejects it; otherwise an integer.
        record[column] = cell === "" ? cell : Number(cell);
        break;
      case "autoRenew":
        record[column] =
          cell === "true" ? true : cell === "false" ? false : cell;
        break;
      case "customInterval":
      case "trial":
        // Optional object JSON cell, or absent when "" (stays optional/undefined).
        if (cell !== "") record[column] = JSON.parse(cell);
        break;
      case "priceHistory":
      case "tags":
        // Required array JSON cell; default an empty cell to [] so the v2 record
        // always carries the array the schema requires.
        record[column] = cell === "" ? [] : JSON.parse(cell);
        break;
      default:
        record[column] = cell;
    }
  }
  return record;
}

/**
 * Tokenize CSV text into rows of string fields per RFC 4180. Handles quoted
 * fields containing commas, line breaks, and doubled quotes, and treats CRLF,
 * CR, and LF as record separators. Blank lines (a single empty field, e.g. a
 * trailing newline) are dropped so they do not become spurious rejected rows.
 */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      endField();
      i += 1;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1; // consume CRLF pair
      endRow();
      i += 1;
    } else if (ch === "\n") {
      endRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  // Flush the final field/row (files without a trailing newline).
  endRow();

  // Drop blank rows (a lone empty field), e.g. from a trailing line break.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// --- Helpers -----------------------------------------------------------------

/** Type guard for a plain object (non-null, non-array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render a thrown value's message safely. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Flatten a zod error into a single field-aware, user-readable string (Req 16.2). */
function formatZodError(error: {
  issues: { path: (string | number)[]; message: string }[];
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
