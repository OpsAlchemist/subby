/**
 * Import parsing, validation, and conflict resolution (Req 16.1, 16.2, 16.3, 16.5).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`,
 * and reads no wall-clock (AD-1).
 *
 * `planImport` is PURE: it takes the current subscription set plus raw file
 * bytes (already read by the platform layer) and produces an {@link ImportOutcome}
 * describing the full new set to persist, how many records were imported or
 * skipped, and which records were rejected. The main-process handler is
 * responsible for the backup-before-apply sequence (Req 16.4) and for actually
 * writing `applied` to disk; this module performs no I/O.
 *
 * Round-trip contract (Req 17.3 / FR-17 — value-exact money): the files produced
 * by `core/export.ts` are the v3 MAJOR-DECIMAL shape (Story 7.1). Every monetary
 * value is written as a major-unit decimal string with its own `currency`: the
 * top-level `amount` (was `amountMinor`), the nested `trial.postAmount` (was
 * `postAmountMinor`), and each `priceHistory[].amount` (was `amountMinor`). This
 * importer READS that shape and reconstructs the integer minor units value-exact
 * via `core/money.minorUnits(major, currency)` — using each amount's OWN currency,
 * never a hand-rolled `*100` — in a pure {@link fromExportSubscription} transform
 * that runs BEFORE {@link subscriptionV2Schema} validation
 * (transform-before-validate: the v2 schema REQUIRES integer `amountMinor` /
 * `postAmountMinor` and the export carries a major `amount` string with no
 * `*Minor` keys. The schema would strip the extra `amount` key and then reject on
 * the MISSING required `amountMinor`, so the record must be reshaped export→v2
 * first). A record whose amount cannot be parsed (bad decimal,
 * too many fractional digits, unknown currency) is REJECTED with a specific reason
 * — never silently coerced — while existing valid data and the other records are
 * preserved.
 *
 * The JSON path keys on the export `version` ({@link ExportFile}): a `version`
 * equal to {@link EXPORT_VERSION} (3) runs each record through the major→minor
 * transform; a bare `SubscriptionV2[]` or a pre-v3 versioned object is accepted as
 * LEGACY (raw integer `amountMinor`, validated directly); a `version` newer than
 * supported gives a single CLEAR "unsupported export version" reason rather than
 * opaque per-record schema errors. The CSV shape produced by `exportCsv` (header
 * via {@link CSV_HEADERS}, money column renamed `amountMinor`→`amount` in place,
 * RFC 4180 escaping, `customInterval`/`trial`/`priceHistory`/`tags` as JSON cells
 * whose money sub-fields are major, booleans as `true`/`false`, `state` as the
 * enum string) is read column-by-NAME (a reordered header still works) and the
 * `amount` column + `currency` column (and the nested JSON cells) are converted
 * the same major→minor way.
 */

import type { SubscriptionV2 } from "./models/subscription";
import { subscriptionV2Schema } from "./models/schema";
import { CSV_COLUMNS, csvHeaderLabel, EXPORT_VERSION } from "./export";
import { minorUnits } from "./money";
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

// --- Export-shape → v2-shape money transform ---------------------------------

/** Outcome of reshaping one export record into a v2-shaped candidate. */
type FromExportResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Reconstruct integer minor units from a v3 export major-unit decimal `amount`
 * for `currency`, routing through `core/money.minorUnits` (the single money seam
 * — never a hand-rolled `*100`). A `minorUnits` throw (invalid decimal, too many
 * fractional digits for the currency, or an unknown currency) is caught and
 * returned as a reason string so the offending record is rejected with a clear
 * message instead of either silently coercing or surfacing an opaque schema error.
 *
 * `label` names the field in the reason (`amount` / `trial.postAmount` /
 * `priceHistory[i].amount`).
 */
function toMinorUnits(
  amount: unknown,
  currency: unknown,
  label: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof amount !== "string") {
    return {
      ok: false,
      reason: `${label} must be a major-unit decimal string, got ${JSON.stringify(amount)}`,
    };
  }
  if (typeof currency !== "string" || currency === "") {
    return {
      ok: false,
      reason: `${label} is missing its currency (got ${JSON.stringify(currency)})`,
    };
  }
  try {
    return { ok: true, value: minorUnits(amount, currency) };
  } catch (err) {
    return { ok: false, reason: `${label}: ${errorMessage(err)}` };
  }
}

/**
 * Reshape ONE nested trial from its export shape ({@link ExportTrial}, major
 * `postAmount`) to the stored v2 shape (integer `postAmountMinor`) using the
 * SUBSCRIPTION's `currency` (the trial amount is in the subscription's Native
 * Currency — the mirror of 7.1's `toExportTrial`). All other trial keys (the
 * `endDate`/`startDate`/`lengthDays` discriminator) carry over verbatim for the
 * strict `trialSchema` to validate; the major `postAmount` is dropped.
 */
function fromExportTrial(
  trial: unknown,
  currency: unknown,
): FromExportResult {
  if (!isRecord(trial)) {
    return { ok: false, reason: `trial must be an object, got ${JSON.stringify(trial)}` };
  }
  const { postAmount, ...rest } = trial as Record<string, unknown>;
  const minor = toMinorUnits(postAmount, currency, "trial.postAmount");
  if (!minor.ok) return minor;
  return { ok: true, value: { ...rest, postAmountMinor: minor.value } };
}

/**
 * Reshape ONE price-history entry from its export shape ({@link ExportPriceEntry},
 * major `amount` + its own `currency`) to the stored v2 shape (integer
 * `amountMinor`) using THAT entry's own `currency` (a historical entry may be in a
 * different currency than the current subscription — the mirror of 7.1's
 * `toExportPriceEntry`). `currency` and `date` carry over verbatim; the major
 * `amount` becomes `amountMinor`.
 */
function fromExportPriceEntry(entry: unknown, index: number): FromExportResult {
  if (!isRecord(entry)) {
    return {
      ok: false,
      reason: `priceHistory[${index}] must be an object, got ${JSON.stringify(entry)}`,
    };
  }
  const { amount, ...rest } = entry as Record<string, unknown>;
  const minor = toMinorUnits(amount, entry.currency, `priceHistory[${index}].amount`);
  if (!minor.ok) return minor;
  return { ok: true, value: { ...rest, amountMinor: minor.value } };
}

/**
 * Reshape a whole price-history ARRAY from its export shape to v2 (each entry's
 * major `amount`+`currency` → integer `amountMinor` in its own currency). The one
 * place both the JSON ({@link fromExportSubscription}) and CSV ({@link
 * coerceCsvRow}) paths reconstruct price history, so the "must be an array" reason
 * and the per-entry conversion are not duplicated. A non-array value or a bad
 * entry amount is returned as `{ok:false, reason}`.
 */
function fromExportPriceHistory(
  priceHistory: unknown,
): { ok: true; value: Record<string, unknown>[] } | { ok: false; reason: string } {
  if (!Array.isArray(priceHistory)) {
    return {
      ok: false,
      reason: `priceHistory must be an array, got ${JSON.stringify(priceHistory)}`,
    };
  }
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < priceHistory.length; i++) {
    const e = fromExportPriceEntry(priceHistory[i], i);
    if (!e.ok) return e;
    entries.push(e.value);
  }
  return { ok: true, value: entries };
}

/**
 * Pure "from-export-shape" transform (the read-side mirror of 7.1's one
 * `toExportSubscription`): map a v3 {@link ExportSubscription} record back to a
 * v2-shaped object with integer minor units, dropping the major keys, so the
 * unchanged {@link subscriptionV2Schema} can validate it (the schema REQUIRES an
 * integer `amountMinor`, which the major-only export record lacks).
 *
 *   - top-level `amount` (string) + `currency`  → `amountMinor` (integer)
 *   - nested `trial.postAmount`                 → `trial.postAmountMinor`
 *                                                 (SUBSCRIPTION currency)
 *   - each `priceHistory[].amount` + `.currency`→ `.amountMinor` (ENTRY currency)
 *
 * Every amount is reconstructed via `core/money.minorUnits` using that amount's
 * OWN currency — never a hand-rolled `*100`, never a single assumed exponent. A
 * `minorUnits` throw (bad decimal / too many fractional digits / unknown
 * currency) is caught and returned as `{ok:false, reason}` so the record is
 * rejected with a specific reason while valid records still import. The transform
 * is value-exact — `minorUnits(toMajor(m, c), c) === m` for every supported
 * currency — so an export→import round-trip through `planImport` preserves money
 * exactly.
 *
 * Only money keys are reshaped; every other field (and any extra key) is passed
 * through so the v2 schema does the full structural validation. This is the
 * ONLY place the import side reconstructs money.
 */
export function fromExportSubscription(raw: unknown): FromExportResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: `record must be an object, got ${JSON.stringify(raw)}` };
  }

  // Strip the major money keys; everything else (including the record's
  // `currency`, used to scale the top-level amount and the trial) carries over.
  const { amount, trial, priceHistory, ...rest } = raw as Record<string, unknown>;
  const currency = raw.currency;

  const out: Record<string, unknown> = { ...rest };

  // Top-level amount → amountMinor, scaled by the record's own currency.
  const topMinor = toMinorUnits(amount, currency, "amount");
  if (!topMinor.ok) return topMinor;
  out.amountMinor = topMinor.value;

  // Nested trial post amount (optional) → postAmountMinor, in the sub's currency.
  if (trial !== undefined) {
    const t = fromExportTrial(trial, currency);
    if (!t.ok) return t;
    out.trial = t.value;
  }

  // Price history (array) → each entry's amountMinor in its OWN currency.
  if (priceHistory !== undefined) {
    const ph = fromExportPriceHistory(priceHistory);
    if (!ph.ok) return ph;
    out.priceHistory = ph.value;
  }

  return { ok: true, value: out };
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
 * Parse a JSON import, keyed on the export `version` ({@link ExportFile}).
 *
 * Shape / version handling:
 *   - A versioned object with `version === EXPORT_VERSION` (3) → each record in
 *     `subscriptions` is reshaped export→v2 via {@link fromExportSubscription}
 *     (major decimals → integer minor units) BEFORE schema validation. A record
 *     whose amount can't be reconstructed becomes a per-row rejection with its
 *     specific reason.
 *   - A versioned object with a `version` GREATER than {@link EXPORT_VERSION} →
 *     a single CLEAR whole-file rejection ("unsupported export version") rather
 *     than opaque per-record schema failures.
 *   - A versioned object whose `version` is PRESENT but not a non-negative
 *     integer (a string `"3"`, a fractional `2.5`, `NaN`, a negative number, …)
 *     → a single CLEAR whole-file "unsupported or invalid export version"
 *     rejection. It is NOT treated as legacy, so a major `amount` string is never
 *     silently read as a raw minor int.
 *   - A versioned object with an integer `version` LESS than {@link
 *     EXPORT_VERSION}, OR a bare `SubscriptionV2[]` array → LEGACY: records are
 *     passed through as raw integer-`amountMinor` v2 records for the schema to
 *     validate directly (back-compat for anything exported before the v3
 *     major-decimal shape). Never reinterpreted as major — a raw minor int is
 *     handed to the schema as-is, so a legacy file is validated, not mis-scaled.
 *
 * Each element is otherwise left for the v2 schema to validate per record.
 */
function parseJsonRecords(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `Failed to parse JSON: ${errorMessage(err)}` };
  }

  // Bare array form: legacy raw-minor v2 records (no version envelope).
  if (Array.isArray(data)) {
    return { ok: true, records: data.map((value) => ({ ok: true, value })) };
  }

  if (!isRecord(data) || !("subscriptions" in data)) {
    return {
      ok: false,
      reason:
        "Expected a JSON object with a 'subscriptions' array or a bare array of subscriptions",
    };
  }

  const list = (data as { subscriptions: unknown }).subscriptions;
  if (!Array.isArray(list)) {
    return { ok: false, reason: "'subscriptions' must be an array" };
  }

  // A versioned export object: gate on the embedded money-representation version.
  const version = (data as { version?: unknown }).version;

  // A `version` that is PRESENT but not a non-negative integer (a string like
  // "3", a fractional 2.5, NaN, negative, …) is neither a clean match nor a
  // legitimate legacy version. Falling through to legacy would then read a major
  // `amount` string as a raw minor int and surface opaque per-record schema
  // errors, defeating the clear-version-message goal — so reject the whole file
  // with one clear reason instead of silently treating it as legacy.
  if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 0)) {
    return {
      ok: false,
      reason: `Unsupported or invalid export version: ${JSON.stringify(version)}. This build reads export version ${EXPORT_VERSION} or earlier.`,
    };
  }

  if (typeof version === "number" && version > EXPORT_VERSION) {
    // Newer than this build understands: fail the whole file with a clear reason
    // (not opaque per-record schema errors) so the user knows to update the app.
    return {
      ok: false,
      reason: `Unsupported export version ${version}: this build reads export version ${EXPORT_VERSION} or earlier. Update the app to import this file.`,
    };
  }

  if (version === EXPORT_VERSION) {
    // v3 major-decimal: reconstruct integer minor units per record BEFORE the
    // schema (transform-before-validate). A bad amount → a per-row reason.
    return {
      ok: true,
      records: list.map((value) => fromExportSubscription(value)),
    };
  }

  // A pre-v3 versioned object (raw-minor legacy): validate the records directly.
  return { ok: true, records: list.map((value) => ({ ok: true, value })) };
}

// --- CSV parsing -------------------------------------------------------------

/**
 * Parse a CSV import produced by `exportCsv` (the v3 major-decimal shape).
 * Honors RFC 4180 quoting (fields wrapped in double quotes may contain commas,
 * CR, LF, and doubled quotes) and both CRLF and LF line endings. The first row
 * is the header; columns are mapped by NAME ({@link CSV_HEADERS}) so a reordered
 * header still works. Cell conventions mirror the exporter: the money column is
 * the human `amount` header (major-unit decimal, not the stored `amountMinor`),
 * `customInterval`/`trial`/`priceHistory`/`tags` are JSON cells (the `trial` and
 * `priceHistory` cells carry their money sub-fields as major decimals), and
 * booleans are `true`/`false`. Each row is reshaped export→v2 (major → integer
 * minor units via `core/money.minorUnits`) BEFORE the v2 schema validates it;
 * a bad/unknown money amount makes the row a per-row rejection with its reason.
 */
function parseCsvRecords(raw: string): ParseResult {
  const rows = tokenizeCsv(raw);
  if (rows.length === 0) {
    return { ok: true, records: [] }; // empty file → nothing to import
  }

  // Map each header NAME to its column index. A duplicate header name is
  // ambiguous (a last-wins map would silently read the wrong cell), so reject the
  // whole file with a clear reason rather than mis-reading a column.
  const header = rows[0];
  const columnPos = new Map<string, number>();
  for (const [idx, name] of header.entries()) {
    if (columnPos.has(name)) {
      return { ok: false, reason: `Duplicate CSV column: ${JSON.stringify(name)}` };
    }
    columnPos.set(name, idx);
  }

  const records: CandidateResult[] = rows.slice(1).map((cells) =>
    coerceCsvRow(cells, columnPos),
  );

  return { ok: true, records };
}

/**
 * Build a v2-shaped candidate record from one CSV data row, applying the
 * exporter's cell conventions and reconstructing integer minor units from the
 * row's major-decimal money (the mirror of `exportCsv`/`serializeCell`).
 *
 * Columns are read by their HEADER NAME ({@link csvHeaderLabel}) so a reordered
 * header still maps correctly; the money column's header is the human `amount`
 * (renamed in place from the stored `amountMinor`). Values whose target type
 * cannot be produced are left as their raw string so the schema validation
 * reports a clear error (Req 16.2) rather than this function guessing.
 *
 * Cell conventions:
 *   - `amount` (major decimal) + `currency` → integer `amountMinor` via
 *     `core/money.minorUnits` (empty/invalid → a per-row rejection reason).
 *   - `trial` (JSON cell, major `postAmount`) → `trial.postAmountMinor` in the
 *     row's currency; absent when "".
 *   - `priceHistory` (JSON cell, major `amount` per entry) → each `.amountMinor`
 *     in that entry's own currency; a "" cell defaults to `[]`.
 *   - `customInterval` → optional object JSON cell, or absent when "".
 *   - `tags` → array JSON cell; a "" cell defaults to `[]`.
 *   - `state` → the enum string, left as-is (no boolean coercion).
 *   - `autoRenew` → boolean.
 *
 * Returns a {@link CandidateResult}: `{ok:false, reason}` on a malformed JSON
 * cell or an unreconstructable money amount, so the row is rejected with its
 * reason while valid rows still import.
 */
function coerceCsvRow(
  cells: string[],
  columnPos: Map<string, number>,
): CandidateResult {
  // Read a column by its header NAME (money column header is `amount`).
  const cellOf = (headerName: string): string => {
    const pos = columnPos.get(headerName);
    return pos === undefined ? "" : cells[pos] ?? "";
  };

  const record: Record<string, unknown> = {};
  const currency = cellOf("currency");

  try {
    for (const column of CSV_COLUMNS) {
      const headerName = csvHeaderLabel(column);
      const cell = cellOf(headerName);

      switch (column) {
        case "amountMinor": {
          // Major-decimal `amount` column → integer minor units via the money
          // seam, using the row's `currency`. Empty stays a string so the schema
          // rejects it; an invalid/unknown amount is caught below as a rejection.
          if (cell === "") {
            record.amountMinor = cell;
          } else if (currency === "") {
            // There IS an amount but no currency to scale it — name the missing
            // column explicitly rather than letting minorUnits throw the opaque
            // Unknown currency "" message.
            return {
              ok: false,
              reason: "amount is missing its currency (currency column empty/absent)",
            };
          } else {
            record.amountMinor = minorUnits(cell, currency);
          }
          break;
        }
        case "autoRenew":
          record[column] =
            cell === "true" ? true : cell === "false" ? false : cell;
          break;
        case "customInterval":
          // Optional object JSON cell, or absent when "".
          if (cell !== "") record[column] = JSON.parse(cell);
          break;
        case "trial": {
          // Optional major-money JSON cell → v2 trial (postAmountMinor); absent
          // when "". Converted in the row's currency (its Native Currency).
          if (cell !== "") {
            const t = fromExportTrial(JSON.parse(cell), currency);
            if (!t.ok) return t;
            record[column] = t.value;
          }
          break;
        }
        case "priceHistory": {
          // Required major-money JSON cell → v2 entries (amountMinor per entry in
          // its OWN currency); a "" cell defaults to []. Reconstruction + the
          // "must be an array" reason are shared with the JSON path.
          if (cell === "") {
            record[column] = [];
          } else {
            const ph = fromExportPriceHistory(JSON.parse(cell));
            if (!ph.ok) return ph;
            record[column] = ph.value;
          }
          break;
        }
        case "tags":
          // Required array JSON cell; default an empty cell to [].
          record[column] = cell === "" ? [] : JSON.parse(cell);
          break;
        default:
          record[column] = cell;
      }
    }
  } catch (err) {
    return { ok: false, reason: `Invalid CSV row: ${errorMessage(err)}` };
  }

  return { ok: true, value: record };
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
