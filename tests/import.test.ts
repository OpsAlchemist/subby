import { describe, it, expect } from "vitest";

import {
  exportJson,
  exportCsv,
  EXPORT_VERSION,
  type ExportSubscription,
} from "core/export";
import { fromExportSubscription, planImport } from "core/import";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SubscriptionV2 } from "core/models/subscription";

/**
 * Example tests for Story 7.2 — the importer READS the v3 major-decimal export
 * shape (Story 7.1) and reconstructs integer minor units value-exact via
 * `core/money.minorUnits` BEFORE the strict v2 schema (transform-before-validate):
 *
 *   - `fromExportSubscription` reconstructs the top-level amount, the nested
 *     `trial.postAmount` (both trial forms), and each `priceHistory[].amount`
 *     (mixed currencies) across USD (exp 2) / JPY (exp 0) / BHD (exp 3).
 *   - a bad decimal, too-many-fractional-digits, and an unknown currency each
 *     become a rejection-with-reason (never a silent coercion).
 *   - the JSON path version-gating: v3 → transformed, a bare array / pre-v3
 *     versioned object → legacy raw-minor, a `version` > 3 → a clear whole-file
 *     reason rather than opaque per-record schema errors.
 *
 * The end-to-end value-exact round-trip across every supported currency lives in
 * the Property 19b property test (`importexport.property.test.ts`).
 */

/** A complete, schema-valid v2 subscription with overridable fields. */
function makeSub(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMinor: 999,
    currency: "USD",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#E50914",
    icon: "netflix",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build the single export record for one v2 subscription (its v3 export shape). */
function soleExportRecord(sub: SubscriptionV2): ExportSubscription {
  const file = JSON.parse(exportJson([sub], DEFAULT_SETTINGS_V2)) as {
    subscriptions: ExportSubscription[];
  };
  return file.subscriptions[0];
}

/** Reshape one export record and assert it reconstructed successfully. */
function reshapeOk(rec: unknown): Record<string, unknown> {
  const result = fromExportSubscription(rec);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

/**
 * Tokenize one CSV line into RFC-4180 cells (handles quoted cells containing
 * commas and doubled quotes — the `trial`/`priceHistory` JSON cells are quoted).
 * A `split(",")` would break those cells apart.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
      i += 1;
    } else {
      cell += ch;
      i += 1;
    }
  }
  cells.push(cell);
  return cells;
}

/** Re-escape one CSV cell per RFC 4180 (quote when it contains ,"\r\n). */
function escapeCsvCell(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Join header + one data row (each an array of raw cells) into CSV text. */
function toCsv(header: string[], row: string[]): string {
  return [
    header.map(escapeCsvCell).join(","),
    row.map(escapeCsvCell).join(","),
  ].join("\r\n");
}

describe("Story 7.2: fromExportSubscription reconstructs integer minor units from the v3 major shape", () => {
  describe("per-currency exponent (minorUnits seam, never *100)", () => {
    it('USD (exponent 2): "9.99" → amountMinor 999', () => {
      const rec = soleExportRecord(makeSub({ amountMinor: 999, currency: "USD" }));
      expect(rec.amount).toBe("9.99");
      expect(reshapeOk(rec).amountMinor).toBe(999);
    });

    it('JPY (exponent 0): "1000" → amountMinor 1000 (not 100000)', () => {
      const rec = soleExportRecord(makeSub({ amountMinor: 1000, currency: "JPY" }));
      expect(rec.amount).toBe("1000");
      expect(reshapeOk(rec).amountMinor).toBe(1000);
    });

    it('BHD (exponent 3): "1.234" → amountMinor 1234', () => {
      const rec = soleExportRecord(makeSub({ amountMinor: 1234, currency: "BHD" }));
      expect(rec.amount).toBe("1.234");
      expect(reshapeOk(rec).amountMinor).toBe(1234);
    });
  });

  describe("the reconstructed record drops the major keys and carries the v2 integer keys", () => {
    it("has amountMinor and no top-level `amount`", () => {
      const v2 = reshapeOk(soleExportRecord(makeSub({ amountMinor: 999, currency: "USD" })));
      expect(v2.amountMinor).toBe(999);
      expect(v2).not.toHaveProperty("amount");
      // Non-money fields carry over verbatim for the schema to validate.
      expect(v2.currency).toBe("USD");
      expect(v2.name).toBe("Netflix");
    });
  });

  describe("nested trial post amount (both trial forms) reconstructs in the sub currency", () => {
    it("start+days trial: postAmount 20.00 USD → postAmountMinor 2000", () => {
      const sub = makeSub({
        currency: "USD",
        state: "Trial",
        trial: { startDate: "2025-01-01", lengthDays: 30, postAmountMinor: 2000 },
      });
      const v2 = reshapeOk(soleExportRecord(sub));
      const trial = v2.trial as Record<string, unknown>;
      expect(trial.postAmountMinor).toBe(2000);
      expect(trial).not.toHaveProperty("postAmount");
      // The discriminator keys carry over verbatim.
      expect(trial.startDate).toBe("2025-01-01");
      expect(trial.lengthDays).toBe(30);
      // The whole reshaped record validates and round-trips through planImport.
      const outcome = planImport([], exportJson([sub], DEFAULT_SETTINGS_V2), "json", "Replace");
      expect(outcome.rejected).toEqual([]);
      expect(outcome.applied[0]).toEqual(sub);
    });

    it("endDate trial: postAmount 15.00 USD → postAmountMinor 1500", () => {
      const sub = makeSub({
        currency: "USD",
        state: "Trial",
        trial: { endDate: "2025-02-01", startDate: "2025-01-01", postAmountMinor: 1500 },
      });
      const v2 = reshapeOk(soleExportRecord(sub));
      const trial = v2.trial as Record<string, unknown>;
      expect(trial.postAmountMinor).toBe(1500);
      expect(trial).not.toHaveProperty("postAmount");
      expect(trial.endDate).toBe("2025-02-01");
      expect(trial.startDate).toBe("2025-01-01");
      const outcome = planImport([], exportJson([sub], DEFAULT_SETTINGS_V2), "json", "Replace");
      expect(outcome.rejected).toEqual([]);
      expect(outcome.applied[0]).toEqual(sub);
    });
  });

  describe("nested price history reconstructs each entry in its OWN currency", () => {
    it("mixed-currency history: each amount scales by its entry currency", () => {
      const sub = makeSub({
        currency: "USD",
        amountMinor: 1500,
        priceHistory: [
          { amountMinor: 1500, currency: "USD", date: "2024-06-01" },
          { amountMinor: 1000, currency: "JPY", date: "2024-01-01" },
          { amountMinor: 1234, currency: "BHD", date: "2023-01-01" },
        ],
      });
      const v2 = reshapeOk(soleExportRecord(sub));
      expect(v2.priceHistory).toEqual([
        { amountMinor: 1500, currency: "USD", date: "2024-06-01" },
        { amountMinor: 1000, currency: "JPY", date: "2024-01-01" },
        { amountMinor: 1234, currency: "BHD", date: "2023-01-01" },
      ]);
    });
  });

  describe("a bad / unknown amount is rejected-with-reason (never silently coerced)", () => {
    it("too many fractional digits for the currency → reason mentions the field", () => {
      // 9.999 has 3 fraction digits; USD supports only 2.
      const rec = { ...soleExportRecord(makeSub({ currency: "USD" })), amount: "9.999" };
      const result = fromExportSubscription(rec);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("amount");
        expect(result.reason).toContain("fractional");
      }
    });

    it("a non-numeric decimal → reason", () => {
      const rec = { ...soleExportRecord(makeSub({ currency: "USD" })), amount: "not-a-number" };
      const result = fromExportSubscription(rec);
      expect(result.ok).toBe(false);
    });

    it("an unknown currency → reason (minorUnits throws, caught per record)", () => {
      const rec = { ...soleExportRecord(makeSub({ currency: "USD" })), currency: "XYZ" };
      const result = fromExportSubscription(rec);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("XYZ");
    });

    it("a bad nested price-history amount → reason naming the entry index", () => {
      const base = soleExportRecord(makeSub({ currency: "USD" }));
      const rec = {
        ...base,
        priceHistory: [{ amount: "1.999", currency: "USD", date: "2024-01-01" }],
      };
      const result = fromExportSubscription(rec);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("priceHistory[0]");
    });
  });
});

describe("Story 7.2: planImport version-gating of the JSON path", () => {
  it("a v3 versioned export imports value-exact (the amount is read as major)", () => {
    const sub = makeSub({ amountMinor: 999, currency: "USD" });
    const outcome = planImport([], exportJson([sub], DEFAULT_SETTINGS_V2), "json", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    expect(outcome.applied[0]).toEqual(sub);
  });

  it("a bad-amount v3 record is rejected-with-reason while the good ones import; existing preserved", () => {
    const good = makeSub({ id: "good", name: "Good", provider: "p-good", amountMinor: 999, currency: "USD" });
    const bad = makeSub({ id: "bad", name: "Bad", provider: "p-bad", amountMinor: 100, currency: "USD" });
    const prior = makeSub({ id: "prior", name: "Prior", provider: "p-prior", amountMinor: 500, currency: "USD" });

    // Hand-build the v3 file so one record carries a too-precise amount.
    const file = JSON.parse(exportJson([good, bad], DEFAULT_SETTINGS_V2)) as {
      version: number;
      subscriptions: ExportSubscription[];
    };
    const badIdx = file.subscriptions.findIndex((r) => r.id === "bad");
    file.subscriptions[badIdx] = { ...file.subscriptions[badIdx], amount: "9.999" };

    const outcome = planImport([prior], JSON.stringify(file), "json", "Replace");

    // The bad record is rejected by its row index with a specific reason.
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].row).toBe(badIdx);
    expect(outcome.rejected[0].reason).toContain("amount");

    // The good record imported; the prior data is preserved intact.
    const byId = new Map(outcome.applied.map((s) => [s.id, s]));
    expect(byId.get("good")).toEqual(good);
    expect(byId.get("prior")).toEqual(prior);
    expect(byId.has("bad")).toBe(false);
  });

  it("an unknown-currency v3 record is rejected-with-reason", () => {
    const good = makeSub({ id: "good", amountMinor: 999, currency: "USD" });
    const file = JSON.parse(exportJson([good], DEFAULT_SETTINGS_V2)) as {
      version: number;
      subscriptions: ExportSubscription[];
    };
    file.subscriptions[0] = { ...file.subscriptions[0], currency: "XYZ" };
    const outcome = planImport([], JSON.stringify(file), "json", "Replace");
    expect(outcome.imported).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].reason).toContain("XYZ");
  });

  it("a newer version than supported gives one CLEAR whole-file reason (not per-record schema errors)", () => {
    const file = {
      version: EXPORT_VERSION + 1,
      subscriptions: [{ anything: true }, { more: 1 }],
      settings: DEFAULT_SETTINGS_V2,
    };
    const outcome = planImport([], JSON.stringify(file), "json", "Replace");
    // A single whole-file rejection at row 0, not one-per-record.
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].row).toBe(0);
    expect(outcome.rejected[0].reason.toLowerCase()).toContain("unsupported export version");
    expect(outcome.imported).toBe(0);
    expect(outcome.applied).toEqual([]);
  });

  it('a STRING version ("3") is NOT treated as legacy — one clear whole-file reason', () => {
    // A string version matches neither `=== 3` nor the numeric `> 3` guard; it
    // must not fall through to legacy and read the major `amount` as a minor int.
    const file = {
      version: "3",
      subscriptions: [{ ...makeSub({ amountMinor: 999, currency: "USD" }), amount: "9.99" }],
      settings: DEFAULT_SETTINGS_V2,
    };
    const outcome = planImport([], JSON.stringify(file), "json", "Replace");
    expect(outcome.imported).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].row).toBe(0);
    expect(outcome.rejected[0].reason.toLowerCase()).toContain("invalid export version");
  });

  it("a FRACTIONAL version (2.5) is NOT treated as legacy — one clear whole-file reason", () => {
    const file = { version: 2.5, subscriptions: [makeSub()] };
    const outcome = planImport([], JSON.stringify(file), "json", "Replace");
    expect(outcome.imported).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].row).toBe(0);
    expect(outcome.rejected[0].reason.toLowerCase()).toContain("invalid export version");
  });

  it("a legacy record (version 2) with a nested trial AND non-empty priceHistory imports unchanged", () => {
    // Pre-v3 raw-minor shape: trial.postAmountMinor + priceHistory[].amountMinor
    // are already integers; the importer must pass them through untouched.
    const legacy = makeSub({
      amountMinor: 2500,
      currency: "USD",
      state: "Trial",
      trial: { startDate: "2025-01-01", lengthDays: 30, postAmountMinor: 1999 },
      priceHistory: [
        { amountMinor: 2500, currency: "USD", date: "2024-06-01" },
        { amountMinor: 1000, currency: "JPY", date: "2024-01-01" },
      ],
    });
    const file = { version: 2, subscriptions: [legacy] };
    const outcome = planImport([], JSON.stringify(file), "json", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    expect(outcome.applied[0]).toEqual(legacy);
  });

  it("a bare-array legacy record with a nested trial AND non-empty priceHistory imports unchanged", () => {
    const legacy = makeSub({
      amountMinor: 3000,
      currency: "USD",
      state: "Trial",
      trial: { endDate: "2025-02-01", postAmountMinor: 2999 },
      priceHistory: [{ amountMinor: 3000, currency: "USD", date: "2024-01-01" }],
    });
    const outcome = planImport([], JSON.stringify([legacy]), "json", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    expect(outcome.applied[0]).toEqual(legacy);
  });

  it('amount "0" with an unknown currency still rejects (minorUnits checks the currency first)', () => {
    // A zero amount must not sneak past the unknown-currency guard — minorUnits
    // resolves the exponent (and throws UnknownCurrencyError) before parsing "0".
    const rec = { ...soleExportRecord(makeSub({ currency: "USD" })), amount: "0", currency: "XYZ" };
    const result = fromExportSubscription(rec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("XYZ");
  });

  it("a bare array is accepted as legacy raw-minor v2 (amountMinor read as an integer, not major)", () => {
    const legacy = makeSub({ amountMinor: 999, currency: "USD" });
    // A bare SubscriptionV2[] with the raw integer amountMinor (pre-v3 shape).
    const outcome = planImport([], JSON.stringify([legacy]), "json", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    // The raw 999 is NOT reinterpreted as a major "999" → kept as the minor int.
    expect(outcome.applied[0]).toEqual(legacy);
  });

  it("a pre-v3 versioned object is accepted as legacy raw-minor v2", () => {
    const legacy = makeSub({ amountMinor: 2500, currency: "USD" });
    const file = { version: 2, subscriptions: [legacy] };
    const outcome = planImport([], JSON.stringify(file), "json", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    expect(outcome.applied[0]).toEqual(legacy);
  });
});

describe("Story 7.2: CSV path reads the amount + currency columns (reordered header still works)", () => {
  it("a reordered CSV header still reconstructs amountMinor value-exact (column-by-name)", () => {
    const sub = makeSub({ amountMinor: 999, currency: "USD" });
    const [headerLine, dataLine] = exportCsv([sub]).split("\r\n");
    const headers = splitCsvLine(headerLine);
    const values = splitCsvLine(dataLine);

    // Reverse every column so the header order no longer matches CSV_COLUMNS.
    const pairs = headers.map((h, i) => [h, values[i]] as const).reverse();
    const reordered = toCsv(pairs.map((p) => p[0]), pairs.map((p) => p[1]));

    const outcome = planImport([], reordered, "csv", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    expect(outcome.applied[0]).toEqual(sub);
  });

  it("a too-precise CSV amount is rejected-with-reason", () => {
    const sub = makeSub({ amountMinor: 999, currency: "USD" });
    const [headerLine, dataLine] = exportCsv([sub]).split("\r\n");
    const headers = splitCsvLine(headerLine);
    const values = splitCsvLine(dataLine);
    values[headers.indexOf("amount")] = "9.999";

    const outcome = planImport([], toCsv(headers, values), "csv", "Replace");
    expect(outcome.imported).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].row).toBe(0);
    expect(outcome.rejected[0].reason).toContain("amount");
  });

  it("a CSV row with a nested trial JSON cell round-trips value-exact", () => {
    const sub = makeSub({
      currency: "USD",
      state: "Trial",
      trial: { startDate: "2025-01-01", lengthDays: 30, postAmountMinor: 2000 },
    });
    const outcome = planImport([], exportCsv([sub]), "csv", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(1);
    expect(outcome.applied[0]).toEqual(sub);
  });

  it("a CSV row with a too-precise nested trial postAmount is rejected-with-reason", () => {
    const sub = makeSub({
      currency: "USD",
      state: "Trial",
      trial: { startDate: "2025-01-01", lengthDays: 30, postAmountMinor: 2000 },
    });
    const [headerLine, dataLine] = exportCsv([sub]).split("\r\n");
    const headers = splitCsvLine(headerLine);
    const values = splitCsvLine(dataLine);
    // Corrupt the trial cell's major postAmount to 3 fraction digits (USD = 2).
    const trialCol = headers.indexOf("trial");
    const trial = JSON.parse(values[trialCol]) as Record<string, unknown>;
    trial.postAmount = "20.001";
    values[trialCol] = JSON.stringify(trial);

    const outcome = planImport([], toCsv(headers, values), "csv", "Replace");
    expect(outcome.imported).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].reason).toContain("trial.postAmount");
  });

  it("a CSV row with an amount but an empty currency column gives a clear missing-currency reason", () => {
    const sub = makeSub({ amountMinor: 999, currency: "USD" });
    const [headerLine, dataLine] = exportCsv([sub]).split("\r\n");
    const headers = splitCsvLine(headerLine);
    const values = splitCsvLine(dataLine);
    values[headers.indexOf("currency")] = ""; // amount present, currency blank

    const outcome = planImport([], toCsv(headers, values), "csv", "Replace");
    expect(outcome.imported).toBe(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].reason).toContain("missing its currency");
    // Not the opaque Unknown currency "" message.
    expect(outcome.rejected[0].reason).not.toContain('""');
  });

  it("a duplicate CSV header column rejects the WHOLE file with a clear reason", () => {
    const sub = makeSub({ amountMinor: 999, currency: "USD" });
    const [headerLine, dataLine] = exportCsv([sub]).split("\r\n");
    const headers = splitCsvLine(headerLine);
    const values = splitCsvLine(dataLine);
    // Append a second `amount` header + a stray cell → an ambiguous column.
    headers.push("amount");
    values.push("1.23");

    const outcome = planImport([], toCsv(headers, values), "csv", "Replace");
    expect(outcome.imported).toBe(0);
    // A single whole-file rejection at row 0, not a per-row rejection.
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].row).toBe(0);
    expect(outcome.rejected[0].reason.toLowerCase()).toContain("duplicate csv column");
    expect(outcome.rejected[0].reason).toContain("amount");
  });

  it("an empty CSV and a header-only CSV both round-trip to {imported:0, rejected:[]}", () => {
    for (const raw of ["", exportCsv([]) /* header row only, no data rows */]) {
      const outcome = planImport([], raw, "csv", "Replace");
      expect(outcome.imported).toBe(0);
      expect(outcome.skipped).toBe(0);
      expect(outcome.rejected).toEqual([]);
      expect(outcome.applied).toEqual([]);
    }
  });
});
