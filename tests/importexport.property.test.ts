import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  exportJson,
  exportCsv,
  EXPORT_VERSION,
  CSV_COLUMNS,
  CSV_HEADERS,
  type ExportFile,
  type ExportSubscription,
  type ExportPriceEntry,
} from "core/export";
import { planImport } from "core/import";
import { minorUnits, MINOR_UNIT_EXPONENT } from "core/money";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SubscriptionV2 } from "core/models/subscription";
import type { ConflictMode } from "shared/types";

/**
 * Properties 19–21: export/import round-trip, per-record validation, and
 * conflict-mode resolution.
 *
 * Property 19 — Export emits value-exact MAJOR-decimal money (Req 17.3 / FR-17):
 *               every monetary value serializes through `core/money.toMajor` and
 *               parses back via `core/money.minorUnits` to the ORIGINAL integer
 *               minor units, for the top-level amount AND the nested trial +
 *               price-history amounts, across every supported currency. This is
 *               the WRITE-side exactness, proven by parsing the written major back
 *               via `minorUnits` directly.
 * Property 19b — The full export→import round-trip is value-exact through the REAL
 *               `planImport` (Story 7.2): `exportJson/Csv(subs)` → `planImport([],
 *               …, "Replace")` reconstructs the SAME subs value-exact (top-level,
 *               nested trial, and each price-history entry) across every supported
 *               currency. This is the end-to-end contract — a regression on either
 *               the export or the import side fails here. It also proves the
 *               importer reconstructs integer minor units via `core/money` (never a
 *               hand-rolled `*100`) and that a bad/unknown-currency amount is
 *               rejected-with-reason while valid records still import, and a newer
 *               `version` gives a clear whole-file reason.
 * Property 20 — Import validates per record and preserves existing valid data
 *               (Req 16.1, 16.2, 16.5).
 * Property 21 — Conflict modes resolve duplicates correctly (Req 16.3).
 */

const NUM_RUNS = 200;

/** The supported currencies the money seam knows an exponent for (the single
 * exponent table) — export's `toMajor` throws on anything else, so every exported
 * amount must be in one of these. Spans the 0/2/3-decimal exponents. */
const SUPPORTED_CURRENCIES: readonly string[] = Object.keys(MINOR_UNIT_EXPONENT);
const currencyArb = fc.constantFrom(...SUPPORTED_CURRENCIES);

const MODES: readonly ConflictMode[] = ["Replace", "Merge", "Skip"];
const modeArb = fc.constantFrom<ConflictMode>(...MODES);

// --- Shared generators -------------------------------------------------------

/** A valid YYYY-MM-DD calendar date string accepted by the schema. */
const isoDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
        day,
      ).padStart(2, "0")}`,
  );

/** A valid ISO datetime string (e.g. from `new Date().toISOString()`). */
const isoDateTimeArb = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2099-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

const cycleArb = fc.constantFrom(
  "Weekly",
  "Monthly",
  "Quarterly",
  "Half-Yearly",
  "Yearly",
  "Custom",
);

/** Custom interval: a positive integer count with a unit (Req 5.4). */
const customIntervalArb = fc.record({
  unit: fc.constantFrom<"day" | "week" | "month" | "year">(
    "day",
    "week",
    "month",
    "year",
  ),
  count: fc.integer({ min: 1, max: 365 }),
});

/**
 * A non-negative INTEGER amount in minor units (AD-10). The v2 schema requires
 * `amountMinor` to be a non-negative integer, so floats are invalid here.
 */
const amountMinorArb = fc.integer({ min: 0, max: 1_000_000_000 });

/**
 * A single schema-valid {@link SubscriptionV2}. Includes a `customInterval` only
 * when the billing cycle is `Custom` (mirrors the schema's requirement). String
 * fields use the full unicode space to exercise CSV escaping (commas, quotes,
 * CR/LF). Only `Active`/`Paused` states are generated and `trial` is omitted so
 * the "trial required iff state === 'Trial'" invariant holds trivially. The
 * currency is drawn from the supported exponent table so a value fed through
 * export's `toMajor` seam never hits the unknown-currency path (Properties 20/21
 * build raw records directly and never export, so their currency is unconstrained
 * there).
 */
const subscriptionArb: fc.Arbitrary<SubscriptionV2> = fc
  .record({
    id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    provider: fc.string(),
    category: fc.string(),
    amountMinor: amountMinorArb,
    currency: currencyArb,
    billingCycle: cycleArb,
    customInterval: customIntervalArb,
    nextRenewal: isoDateArb,
    startDate: isoDateArb,
    paymentMethod: fc.string(),
    website: fc.string(),
    notes: fc.string(),
    color: fc.string(),
    icon: fc.string(),
    state: fc.constantFrom<"Active" | "Paused">("Active", "Paused"),
    priceHistory: fc.constant([]),
    tags: fc.array(fc.string(), { maxLength: 3 }),
    autoRenew: fc.boolean(),
    createdAt: isoDateTimeArb,
    updatedAt: isoDateTimeArb,
  })
  .map((raw) => {
    const { customInterval, ...rest } = raw;
    const sub = { ...rest } as SubscriptionV2;
    if (rest.billingCycle === "Custom") {
      sub.customInterval = customInterval;
    }
    return sub;
  });

/** An append-only price-history entry in a supported currency (its own currency,
 * possibly different from the subscription's — export majors each independently). */
const priceEntryArb = fc.record({
  amountMinor: amountMinorArb,
  currency: currencyArb,
  date: isoDateArb,
});

/**
 * A schema-valid Trial subscription with an embedded trial and a non-empty price
 * history — the generator that exercises Property 19's NESTED money round-trip
 * (`trial.postAmountMinor` and each `priceHistory[].amountMinor`). The trial uses
 * the `startDate + lengthDays` form (months unrepresentable, AD-18). The post
 * amount is in the subscription's own currency; price entries carry their own.
 */
const trialSubscriptionArb: fc.Arbitrary<SubscriptionV2> = fc
  .record({
    base: subscriptionArb,
    postAmountMinor: amountMinorArb,
    lengthDays: fc.integer({ min: 1, max: 365 }),
    trialStart: isoDateArb,
    priceHistory: fc.array(priceEntryArb, { minLength: 1, maxLength: 4 }),
  })
  .map(({ base, postAmountMinor, lengthDays, trialStart, priceHistory }) => ({
    ...base,
    state: "Trial" as const,
    trial: { startDate: trialStart, lengthDays, postAmountMinor },
    priceHistory,
  }));

/**
 * Stamp a subscription with a tag so its `id` AND its `name + provider` key are
 * globally unique. Import dedupes by `id`, then by `name + provider` (Req 16.3),
 * so a faithful round-trip requires uniqueness on BOTH keys.
 */
function stamp(sub: SubscriptionV2, tag: string): SubscriptionV2 {
  return {
    ...sub,
    id: `${sub.id}-id-${tag}`,
    name: `${sub.name}-n-${tag}`,
    provider: `${sub.provider}-p-${tag}`,
  };
}

/**
 * A mix of plain (Active/Paused) and Trial-with-price-history subscriptions, each
 * made id-unique — the input to Property 19's money round-trip so BOTH the simple
 * top-level amount AND the nested trial/price amounts are exercised.
 */
const moneySubsArb: fc.Arbitrary<SubscriptionV2[]> = fc
  .array(fc.oneof(subscriptionArb, trialSubscriptionArb), { minLength: 1, maxLength: 10 })
  .map((subs) => subs.map((s, i) => stamp(s, String(i))));

/** Compare two subscription sets ignoring order (sort by unique id). */
function expectSameSet(
  actual: SubscriptionV2[],
  expected: SubscriptionV2[],
): void {
  const byId = (a: SubscriptionV2, b: SubscriptionV2) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  expect([...actual].sort(byId)).toEqual([...expected].sort(byId));
}

// --- Property 19 -------------------------------------------------------------

/**
 * Parse a `core/export` CSV string into header + rows of cells, honoring RFC 4180
 * quoting (doubled quotes, embedded commas / CR / LF) and CRLF separators. A tiny
 * local tokenizer so Property 19 does not depend on the (Story-7.2-owned)
 * importer to read the file back.
 */
function parseExportedCsv(text: string): { header: string[]; rows: string[][] } {
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
          field += '"';
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
      if (text[i + 1] === "\n") i += 1;
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
  endRow();
  const nonBlank = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  return { header: nonBlank[0] ?? [], rows: nonBlank.slice(1) };
}

/**
 * Property 19 (Req 17.3 / FR-17): export emits value-exact MAJOR-decimal money.
 *
 * Story 7.1 only WRITES the major representation; the importer that READS it is
 * Story 7.2, so this proves exactness by parsing the written major back through
 * `core/money.minorUnits` DIRECTLY (never through `planImport`, which still reads
 * raw `amountMinor` until 7.2). It covers the top-level amount AND the nested
 * `trial.postAmount` + each `priceHistory[].amount`, across supported currencies.
 */
describe("Feature: subby, Property 19: Export emits value-exact major-decimal money", () => {
  it("Feature: subby, Property 19: JSON export majors every amount and round-trips value-exact via minorUnits (Req 17.3)", () => {
    fc.assert(
      fc.property(moneySubsArb, (subs) => {
        const parsed = JSON.parse(exportJson(subs, DEFAULT_SETTINGS_V2)) as ExportFile;

        // JSON shape + version identify the (major-decimal) money representation.
        expect(parsed.version).toBe(EXPORT_VERSION);
        expect(parsed.settings).toEqual(DEFAULT_SETTINGS_V2);
        expect(parsed.subscriptions).toHaveLength(subs.length);

        const byId = new Map<string, ExportSubscription>(
          parsed.subscriptions.map((r) => [r.id, r]),
        );
        for (const sub of subs) {
          const rec = byId.get(sub.id);
          expect(rec).toBeDefined();
          const r = rec as ExportSubscription;

          // Non-money fields reproduce verbatim.
          expect(r.name).toBe(sub.name);
          expect(r.provider).toBe(sub.provider);
          expect(r.currency).toBe(sub.currency);
          expect(r.state).toBe(sub.state);
          expect(r.tags).toEqual(sub.tags);

          // Money is a MAJOR decimal (not the raw minor int) that parses back to
          // the ORIGINAL integer minor units, value-exact.
          expect(typeof r.amount).toBe("string");
          expect(minorUnits(r.amount, r.currency)).toBe(sub.amountMinor);

          // Nested trial post amount: major, value-exact in the sub's currency.
          if (sub.trial !== undefined) {
            expect(r.trial).toBeDefined();
            const t = r.trial as NonNullable<ExportSubscription["trial"]>;
            expect(minorUnits(t.postAmount, r.currency)).toBe(sub.trial.postAmountMinor);
          }

          // Each price-history entry: major, value-exact in the entry's OWN currency.
          expect(r.priceHistory).toHaveLength(sub.priceHistory.length);
          sub.priceHistory.forEach((orig, idx) => {
            const e = r.priceHistory[idx] as ExportPriceEntry;
            expect(e.currency).toBe(orig.currency);
            expect(minorUnits(e.amount, e.currency)).toBe(orig.amountMinor);
          });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 19: CSV export majors the money column + nested cells and round-trips value-exact (Req 17.3)", () => {
    fc.assert(
      fc.property(moneySubsArb, (subs) => {
        const { header, rows } = parseExportedCsv(exportCsv(subs));

        // Column parity: the header set+order equals CSV_HEADERS; the money column
        // keeps its position with the human `amount` header (never `amountMinor`).
        expect(header).toEqual([...CSV_HEADERS]);
        const amountIdx = CSV_COLUMNS.indexOf("amountMinor");
        expect(header[amountIdx]).toBe("amount");
        expect(header).not.toContain("amountMinor");

        const col = (name: string) => header.indexOf(name);
        expect(rows).toHaveLength(subs.length);

        const byId = new Map<string, string[]>(rows.map((cells) => [cells[col("id")], cells]));
        for (const sub of subs) {
          const cells = byId.get(sub.id);
          expect(cells).toBeDefined();
          const c = cells as string[];

          // Money column is a major decimal that parses back value-exact.
          expect(minorUnits(c[amountIdx], sub.currency)).toBe(sub.amountMinor);

          // Trial JSON cell carries a major `postAmount`.
          if (sub.trial !== undefined) {
            const t = JSON.parse(c[col("trial")]) as { postAmount: string };
            expect(minorUnits(t.postAmount, sub.currency)).toBe(sub.trial.postAmountMinor);
          }

          // Price-history JSON cell carries a major `amount` per entry in its currency.
          const entries = JSON.parse(c[col("priceHistory")]) as ExportPriceEntry[];
          expect(entries).toHaveLength(sub.priceHistory.length);
          sub.priceHistory.forEach((orig, idx) => {
            expect(entries[idx].currency).toBe(orig.currency);
            expect(minorUnits(entries[idx].amount, entries[idx].currency)).toBe(orig.amountMinor);
          });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 19b: real export → import round-trip (Story 7.2) ----------------

/**
 * The expected v2 record after a round-trip: identical to the original EXCEPT the
 * importer's merge/validation never changes money, so every `amountMinor` (top,
 * trial, each price entry) must survive EXACTLY. We compare the whole object — a
 * value-exact round-trip must reproduce the record verbatim.
 */
describe("Feature: subby, Property 19b: export → import round-trip is value-exact through planImport (Req 17.3 / FR-17)", () => {
  it("Feature: subby, Property 19b: JSON exportJson → planImport reconstructs the SAME subs value-exact (Replace into empty)", () => {
    fc.assert(
      fc.property(moneySubsArb, (subs) => {
        const json = exportJson(subs, DEFAULT_SETTINGS_V2);
        const outcome = planImport([], json, "json", "Replace");

        // Every record imports; none rejected or skipped (all new into empty).
        expect(outcome.rejected).toEqual([]);
        expect(outcome.imported).toBe(subs.length);
        expect(outcome.skipped).toBe(0);

        // The reconstructed set equals the originals — money (incl. nested trial
        // and each price-history entry) is reconstructed to the exact minor units.
        expectSameSet(outcome.applied, subs);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 19b: CSV exportCsv → planImport reconstructs the SAME subs value-exact (Replace into empty)", () => {
    fc.assert(
      fc.property(moneySubsArb, (subs) => {
        const csv = exportCsv(subs);
        const outcome = planImport([], csv, "csv", "Replace");

        expect(outcome.rejected).toEqual([]);
        expect(outcome.imported).toBe(subs.length);
        expect(outcome.skipped).toBe(0);
        expectSameSet(outcome.applied, subs);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 20 -------------------------------------------------------------

type IncomingItem =
  | { kind: "valid"; base: SubscriptionV2 }
  | {
      kind: "invalid";
      base: SubscriptionV2;
      flavor: "emptyName" | "negAmount" | "badCycle" | "notObject" | "missingId";
    };

const incomingItemArb: fc.Arbitrary<IncomingItem> = fc.oneof(
  fc.record({ kind: fc.constant("valid" as const), base: subscriptionArb }),
  fc.record({
    kind: fc.constant("invalid" as const),
    base: subscriptionArb,
    flavor: fc.constantFrom<
      "emptyName" | "negAmount" | "badCycle" | "notObject" | "missingId"
    >("emptyName", "negAmount", "badCycle", "notObject", "missingId"),
  }),
);

/** Corrupt a valid subscription so it fails schema validation (Req 16.2). */
function corrupt(base: SubscriptionV2, flavor: string): unknown {
  switch (flavor) {
    case "emptyName":
      return { ...base, name: "" };
    case "negAmount":
      // A negative `amountMinor` violates the non-negative integer constraint.
      return { ...base, amountMinor: -1 };
    case "badCycle":
      return { ...base, billingCycle: "NotACycle" };
    case "missingId": {
      const { id: _omit, ...withoutId } = base;
      return withoutId;
    }
    case "notObject":
    default:
      return 42; // not an object at all
  }
}

describe("Feature: subby, Property 20: Import validates per record and preserves existing valid data", () => {
  it("Feature: subby, Property 20: rejects exactly the invalid records while applying valid ones and keeping existing data (Req 16.1, 16.2, 16.5)", () => {
    fc.assert(
      fc.property(
        fc.array(subscriptionArb, { maxLength: 6 }),
        fc.array(incomingItemArb, { maxLength: 10 }),
        modeArb,
        (existingRaw, incoming, mode) => {
          // Make existing unique on both keys; these are the pre-existing,
          // already-valid records that must be preserved (Req 16.5).
          const existing = existingRaw.map((s, i) => stamp(s, `ex${i}`));

          // Build the incoming `subscriptions` array, tracking which row
          // indices are malformed and which valid records we expect applied.
          const entries: unknown[] = [];
          const invalidRows: number[] = [];
          const validIncoming: SubscriptionV2[] = [];

          incoming.forEach((item, i) => {
            if (item.kind === "valid") {
              const sub = stamp(item.base, `in${i}`);
              validIncoming.push(sub);
              entries.push(sub);
            } else {
              invalidRows.push(i);
              entries.push(corrupt(stamp(item.base, `in${i}`), item.flavor));
            }
          });

          const raw = JSON.stringify({ version: 2, subscriptions: entries });
          const outcome = planImport(existing, raw, "json", mode);

          // Exactly the malformed rows are rejected, by their incoming index.
          expect(outcome.rejected.map((r) => r.row).sort((a, b) => a - b)).toEqual(
            [...invalidRows].sort((a, b) => a - b),
          );

          // Valid incoming records are applied; none are skipped (all are new).
          expect(outcome.imported).toBe(validIncoming.length);
          expect(outcome.skipped).toBe(0);

          // The applied set is exactly existing ∪ valid-incoming.
          expectSameSet(outcome.applied, [...existing, ...validIncoming]);

          // Pre-existing valid data is preserved verbatim (Req 16.5).
          const appliedById = new Map(outcome.applied.map((s) => [s.id, s]));
          for (const e of existing) {
            expect(appliedById.get(e.id)).toEqual(e);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 21 -------------------------------------------------------------

/**
 * Clearable string fields that the schema permits to be empty. `currency` is
 * NOT clearable under v2 (the schema requires a non-empty currency), so it is
 * excluded from this set.
 */
const CLEARABLE = [
  "category",
  "paymentMethod",
  "website",
  "notes",
  "color",
  "icon",
] as const;

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

interface DupCase {
  existing: SubscriptionV2;
  incoming: SubscriptionV2;
}

/**
 * Generate a duplicate pair: an `existing` record and an `incoming` record that
 * collide either by `id` or by `name + provider` (Req 16.3). The existing record
 * has a random subset of its clearable fields emptied; the incoming record has
 * all fields populated with values distinct from the existing ones, so Merge's
 * fill-empty-only behavior is observable.
 */
const dupCaseArb: fc.Arbitrary<DupCase> = fc
  .record({
    clearMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    dupKind: fc.constantFrom("id", "nameProvider"),
    eAmount: fc.integer({ min: 0, max: 1_000_000_000 }),
    eActive: fc.boolean(),
    eAutoRenew: fc.boolean(),
  })
  .map(({ clearMask, dupKind, eAmount, eActive, eAutoRenew }) => {
    const NAME = "DupName";
    const PROVIDER = "DupProvider";
    const ID_E = "id-existing";
    const ID_I = "id-incoming";

    const existing: SubscriptionV2 = {
      id: ID_E,
      name: NAME,
      provider: PROVIDER,
      category: "cat#ex",
      amountMinor: eAmount,
      currency: "cur#ex",
      billingCycle: "Monthly",
      nextRenewal: "2030-01-01",
      startDate: "2025-01-01",
      paymentMethod: "pm#ex",
      website: "web#ex",
      notes: "notes#ex",
      color: "#111111",
      icon: "icon#ex",
      state: eActive ? "Active" : "Paused",
      priceHistory: [],
      tags: [],
      autoRenew: eAutoRenew,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    };
    CLEARABLE.forEach((field, i) => {
      if (clearMask[i]) existing[field] = "";
    });

    const incoming: SubscriptionV2 = {
      id: dupKind === "id" ? ID_E : ID_I,
      name: NAME,
      provider: PROVIDER,
      category: "cat#in",
      amountMinor: eAmount + 1, // distinct from existing so preservation is visible
      currency: "cur#in",
      billingCycle: "Monthly",
      nextRenewal: "2031-06-06",
      startDate: "2026-06-06",
      paymentMethod: "pm#in",
      website: "web#in",
      notes: "notes#in",
      color: "#222222",
      icon: "icon#in",
      state: !eActive ? "Active" : "Paused",
      priceHistory: [],
      tags: [],
      autoRenew: !eAutoRenew,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };

    return { existing, incoming };
  });

function rawFor(sub: SubscriptionV2): string {
  return JSON.stringify({ version: 2, subscriptions: [sub] });
}

describe("Feature: subby, Property 21: Conflict modes resolve duplicates correctly", () => {
  it("Feature: subby, Property 21: Replace yields the incoming version (Req 16.3)", () => {
    fc.assert(
      fc.property(dupCaseArb, ({ existing, incoming }) => {
        const outcome = planImport(
          [existing],
          rawFor(incoming),
          "json",
          "Replace",
        );

        expect(outcome.rejected).toEqual([]);
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.applied[0]).toEqual(incoming);
        expect(outcome.imported).toBe(1);
        expect(outcome.skipped).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 21: Skip yields the existing version (Req 16.3)", () => {
    fc.assert(
      fc.property(dupCaseArb, ({ existing, incoming }) => {
        const outcome = planImport([existing], rawFor(incoming), "json", "Skip");

        expect(outcome.rejected).toEqual([]);
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.applied[0]).toEqual(existing);
        expect(outcome.imported).toBe(0);
        expect(outcome.skipped).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 21: Merge fills only missing/empty fields and preserves existing non-empty values and identity (Req 16.3)", () => {
    fc.assert(
      fc.property(dupCaseArb, ({ existing, incoming }) => {
        const outcome = planImport(
          [existing],
          rawFor(incoming),
          "json",
          "Merge",
        );

        expect(outcome.rejected).toEqual([]);
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.imported).toBe(1);
        expect(outcome.skipped).toBe(0);

        const merged = outcome.applied[0] as unknown as Record<string, unknown>;
        const e = existing as unknown as Record<string, unknown>;
        const inc = incoming as unknown as Record<string, unknown>;

        // Identity of the existing record is always preserved (Req 16.3).
        expect(merged.id).toBe(existing.id);

        // Every other field: take incoming only where existing is empty;
        // otherwise the existing non-empty value is preserved.
        const keys = new Set([...Object.keys(e), ...Object.keys(inc)]);
        for (const key of keys) {
          if (key === "id") continue;
          const expected = isEmpty(e[key]) ? inc[key] : e[key];
          expect(merged[key]).toEqual(expected);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
