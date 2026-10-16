import { describe, it, expect } from "vitest";

import {
  exportJson,
  exportCsv,
  toExportSubscription,
  EXPORT_VERSION,
  CSV_COLUMNS,
  CSV_HEADERS,
  csvHeaderLabel,
  type ExportFile,
} from "core/export";
import { UnknownCurrencyError } from "core/money";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SubscriptionV2 } from "core/models/subscription";

/**
 * Example tests for Story 7.1 — export emits MAJOR-unit decimal money through the
 * `core/money.toMajor` seam (FR-17): per-currency exponents (USD=2, JPY=0, BHD=3),
 * the nested trial post amount and each price-history entry, the JSON
 * `{version, subscriptions, settings}` shape + version, CSV column parity (money
 * header renamed `amountMinor`→`amount` IN PLACE), and the unknown-currency loud
 * failure. The value-exact round-trip across all currencies lives in the Property
 * 19 property test (`importexport.property.test.ts`).
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

/** Parse the single data record out of a one-subscription JSON export. */
function soleJsonRecord(sub: SubscriptionV2): ExportFile["subscriptions"][number] {
  const file = JSON.parse(exportJson([sub], DEFAULT_SETTINGS_V2)) as ExportFile;
  return file.subscriptions[0];
}

/**
 * Tokenize one CSV line into RFC-4180 cells (handles quoted cells containing
 * commas and doubled quotes — the `trial`/`priceHistory` JSON cells are quoted).
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

/** Parse the one-subscription CSV export into a header→cell map. */
function soleCsvCells(sub: SubscriptionV2): Map<string, string> {
  const [headerLine, dataLine] = exportCsv([sub]).split("\r\n");
  const headers = splitCsvLine(headerLine);
  const values = splitCsvLine(dataLine);
  const map = new Map<string, string>();
  headers.forEach((h, i) => map.set(h, values[i]));
  return map;
}

describe("Story 7.1: export majors money via the per-currency exponent seam", () => {
  describe("per-currency exponent (toMajor seam, never /100)", () => {
    it("USD (exponent 2): 999 → \"9.99\" in both JSON and CSV", () => {
      const sub = makeSub({ amountMinor: 999, currency: "USD" });
      expect(soleJsonRecord(sub).amount).toBe("9.99");
      expect(soleCsvCells(sub).get("amount")).toBe("9.99");
    });

    it("JPY (exponent 0): 1000 → \"1000\" (no fractional digits)", () => {
      const sub = makeSub({ amountMinor: 1000, currency: "JPY" });
      expect(soleJsonRecord(sub).amount).toBe("1000");
      expect(soleCsvCells(sub).get("amount")).toBe("1000");
    });

    it("BHD (exponent 3): 1234 → \"1.234\" (three fractional digits)", () => {
      const sub = makeSub({ amountMinor: 1234, currency: "BHD" });
      expect(soleJsonRecord(sub).amount).toBe("1.234");
      expect(soleCsvCells(sub).get("amount")).toBe("1.234");
    });
  });

  describe("nested money (trial + price history) majored independently", () => {
    it("trial.postAmountMinor 2000 USD → nested major \"20.00\" in JSON and the CSV trial cell", () => {
      const sub = makeSub({
        currency: "USD",
        state: "Trial",
        trial: { startDate: "2025-01-01", lengthDays: 30, postAmountMinor: 2000 },
      });
      const rec = soleJsonRecord(sub);
      expect(rec.trial).toBeDefined();
      expect(rec.trial?.postAmount).toBe("20.00");
      // The on-record shape carries the major post amount, not the minor field.
      expect(rec.trial as unknown as Record<string, unknown>).not.toHaveProperty("postAmountMinor");

      const trialCell = JSON.parse(soleCsvCells(sub).get("trial") as string) as {
        postAmount: string;
      };
      expect(trialCell.postAmount).toBe("20.00");
    });

    it("endDate-form trial exports its postAmount major and keeps the endDate discriminator", () => {
      const sub = makeSub({
        currency: "USD",
        state: "Trial",
        trial: { endDate: "2025-02-01", startDate: "2025-01-01", postAmountMinor: 1500 },
      });
      const rec = soleJsonRecord(sub);
      expect(rec.trial).toBeDefined();
      const t = rec.trial as Record<string, unknown>;
      // The post amount is majored; the minor key is dropped; the endDate form
      // (not start+days) is preserved verbatim.
      expect(t.postAmount).toBe("15.00");
      expect(t).not.toHaveProperty("postAmountMinor");
      expect(t.endDate).toBe("2025-02-01");
      expect(t.startDate).toBe("2025-01-01");
      expect(t).not.toHaveProperty("lengthDays");

      // Same through the CSV trial JSON cell.
      const trialCell = JSON.parse(soleCsvCells(sub).get("trial") as string) as Record<string, unknown>;
      expect(trialCell.postAmount).toBe("15.00");
      expect(trialCell.endDate).toBe("2025-02-01");
    });

    it("each priceHistory entry majors in its OWN currency (mixed-currency history)", () => {
      const sub = makeSub({
        currency: "USD",
        amountMinor: 1500,
        priceHistory: [
          { amountMinor: 1500, currency: "USD", date: "2024-06-01" },
          { amountMinor: 1000, currency: "JPY", date: "2024-01-01" },
          { amountMinor: 1234, currency: "BHD", date: "2023-01-01" },
        ],
      });
      const rec = soleJsonRecord(sub);
      expect(rec.priceHistory).toEqual([
        { amount: "15.00", currency: "USD", date: "2024-06-01" },
        { amount: "1000", currency: "JPY", date: "2024-01-01" },
        { amount: "1.234", currency: "BHD", date: "2023-01-01" },
      ]);
    });
  });

  describe("mixed-currency top-level amounts each use their own exponent", () => {
    it("a USD + EUR + JPY export majors each amount in its own currency (no single assumed exponent)", () => {
      const subs = [
        makeSub({ id: "u", name: "U", provider: "pu", amountMinor: 999, currency: "USD" }),
        makeSub({ id: "e", name: "E", provider: "pe", amountMinor: 500, currency: "EUR" }),
        makeSub({ id: "j", name: "J", provider: "pj", amountMinor: 1000, currency: "JPY" }),
      ];
      const file = JSON.parse(exportJson(subs, DEFAULT_SETTINGS_V2)) as ExportFile;
      const amountByCurrency = new Map(file.subscriptions.map((r) => [r.currency, r.amount]));
      expect(amountByCurrency.get("USD")).toBe("9.99");
      expect(amountByCurrency.get("EUR")).toBe("5.00");
      expect(amountByCurrency.get("JPY")).toBe("1000");
    });
  });

  describe("JSON export shape + version", () => {
    it("is {version, subscriptions, settings} with a version identifying the money representation", () => {
      const file = JSON.parse(
        exportJson([makeSub()], DEFAULT_SETTINGS_V2),
      ) as ExportFile;
      expect(Object.keys(file).sort()).toEqual(["settings", "subscriptions", "version"]);
      expect(file.version).toBe(EXPORT_VERSION);
      expect(EXPORT_VERSION).toBe(3); // v3 == major-decimal money (Story 7.1)
      expect(file.settings).toEqual(DEFAULT_SETTINGS_V2);
    });

    it("the record carries the major `amount` + its `currency`, not the raw `amountMinor`", () => {
      const rec = soleJsonRecord(makeSub({ amountMinor: 999, currency: "USD" }));
      expect(rec.amount).toBe("9.99");
      expect(rec.currency).toBe("USD");
      expect(rec as unknown as Record<string, unknown>).not.toHaveProperty("amountMinor");
    });

    it("an ExportSubscription's key set is complete (a hand-rolled field drop is caught)", () => {
      // The exported record keys must be exactly these — the v2 subscription keys
      // with `amountMinor` renamed to the major `amount`, plus the conditional
      // `customInterval`/`trial`. A record missing a key (or carrying `amountMinor`
      // / `postAmountMinor` leftovers) fails here, catching a field drop.
      const EXPECTED_KEYS = [
        "id",
        "name",
        "provider",
        "category",
        "amount", // was amountMinor
        "currency",
        "billingCycle",
        "customInterval", // conditional (present here: Custom cycle)
        "nextRenewal",
        "startDate",
        "paymentMethod",
        "website",
        "notes",
        "color",
        "icon",
        "state",
        "trial", // conditional (present here: Trial state)
        "priceHistory",
        "tags",
        "autoRenew",
        "createdAt",
        "updatedAt",
      ].sort();

      // A record that exercises BOTH conditional keys at once.
      const full = makeSub({
        billingCycle: "Custom",
        customInterval: { unit: "month", count: 3 },
        state: "Trial",
        trial: { startDate: "2025-01-01", lengthDays: 30, postAmountMinor: 2000 },
      });
      const rec = soleJsonRecord(full) as unknown as Record<string, unknown>;
      expect(Object.keys(rec).sort()).toEqual(EXPECTED_KEYS);
      // No stale minor-unit money keys survive into the export shape.
      expect(rec).not.toHaveProperty("amountMinor");
      expect(rec).not.toHaveProperty("isActive");

      // Without the conditional fields, exactly those two keys are absent.
      const plain = soleJsonRecord(makeSub()) as unknown as Record<string, unknown>;
      expect(Object.keys(plain).sort()).toEqual(
        EXPECTED_KEYS.filter((k) => k !== "customInterval" && k !== "trial"),
      );
    });
  });

  describe("CSV column parity (set + order; money header renamed in place)", () => {
    it("the header set+order is preserved; the money column keeps its position as the human `amount`", () => {
      const header = exportCsv([makeSub()]).split("\r\n")[0].split(",");
      expect(header).toEqual([...CSV_HEADERS]);
      // Money column at the SAME index as the stored `amountMinor` key, renamed.
      const idx = CSV_COLUMNS.indexOf("amountMinor");
      expect(header[idx]).toBe("amount");
      expect(csvHeaderLabel("amountMinor")).toBe("amount");
      // Every other column header equals its field key (no other rename).
      CSV_COLUMNS.forEach((key, i) => {
        if (key !== "amountMinor") expect(header[i]).toBe(key);
      });
      // No column dropped and none renamed away: same count, no `amountMinor` header.
      expect(header).toHaveLength(CSV_COLUMNS.length);
      expect(header).not.toContain("amountMinor");
    });
  });

  describe("unknown currency fails loudly through the money seam", () => {
    it("exportJson throws UnknownCurrencyError for an off-table currency (no silent mis-scale)", () => {
      const bad = makeSub({ currency: "XYZ", amountMinor: 100 });
      expect(() => exportJson([bad], DEFAULT_SETTINGS_V2)).toThrow(UnknownCurrencyError);
    });

    it("exportCsv throws UnknownCurrencyError for an off-table currency", () => {
      const bad = makeSub({ currency: "XYZ", amountMinor: 100 });
      expect(() => exportCsv([bad])).toThrow(UnknownCurrencyError);
    });

    it("a bad nested price-history currency also throws (nested amounts route the same seam)", () => {
      const bad = makeSub({
        currency: "USD",
        priceHistory: [{ amountMinor: 100, currency: "ZZZ", date: "2024-01-01" }],
      });
      expect(() => toExportSubscription(bad)).toThrow(UnknownCurrencyError);
    });
  });
});
