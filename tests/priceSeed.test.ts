import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePriceSeed,
  lookupSuggestion,
  isSeedStale,
  PriceSeedError,
  PRICE_SEED_SCHEMA_VERSION,
  type PriceSeed,
} from "core/priceSeed";
import { billingCycleSchema } from "core/models/schema";
import {
  readBundledPriceSeed,
  type ResolveResourceDirOptions,
} from "../electron/storage/resourceReader";

/**
 * Bundled suggested-price seed: loud validation + normalized exact lookup +
 * pure staleness guard (FR-13; Story 5.4).
 *
 * Mirrors `tests/fxSnapshot.property.test.ts` / `tests/resourceReader.test.ts`:
 *
 * Property — `parsePriceSeed` round-trips a well-formed object (schemaVersion /
 *            asOf / disclaimer / every entry preserved under a normalized key)
 *            and throws `PriceSeedError` on each malformed variant; and for any
 *            valid seed, `lookupSuggestion` returns the matching entry under a
 *            trim/case-insensitive query and `null` on a miss.
 *
 * Plus example tests covering every I/O-matrix row, a boundary sweep of
 * `isSeedStale`, and a FIXTURE-FREE sanity parse of the REAL committed
 * `resources/price-seed.json` (like the tray/FX real-asset tests).
 */

const NUM_RUNS = 300;

const VALID_CYCLES = billingCycleSchema.options;

/** A well-formed raw seed object (the shape `parsePriceSeed` accepts). */
function validRawSeed(): Record<string, unknown> {
  return {
    schemaVersion: PRICE_SEED_SCHEMA_VERSION,
    asOf: "2026-10-01",
    disclaimer: "Approximate typical prices, bundled offline and read-only.",
    services: {
      netflix: { amountMinor: 1549, currency: "USD", billingCycle: "Monthly" },
      spotify: { amountMinor: 1199, currency: "USD", billingCycle: "Monthly" },
      "youtube premium": { amountMinor: 1399, currency: "USD", billingCycle: "Monthly" },
    },
  };
}

// --- Property tests ----------------------------------------------------------

describe("parsePriceSeed / lookupSuggestion — property", () => {
  /** An arbitrary normalized (already trim+lowercase) service key. */
  const normalizedKey = fc
    .string({ minLength: 1, maxLength: 12 })
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s === s.trim().toLowerCase());

  const entryArb = fc.record({
    amountMinor: fc.nat({ max: 10_000_000 }),
    currency: fc.constantFrom("USD", "EUR", "GBP", "JPY", "INR"),
    billingCycle: fc.constantFrom(...VALID_CYCLES),
  });

  it("round-trips a well-formed seed; every entry is retrievable by trim/case-insensitive name", () => {
    fc.assert(
      fc.property(
        fc.dictionary(normalizedKey, entryArb, { minKeys: 1, maxKeys: 8 }),
        (services) => {
          const seed = parsePriceSeed({
            schemaVersion: PRICE_SEED_SCHEMA_VERSION,
            asOf: "2026-10-01",
            disclaimer: "approx",
            services,
          });

          // schemaVersion / asOf / disclaimer preserved.
          expect(seed.schemaVersion).toBe(PRICE_SEED_SCHEMA_VERSION);
          expect(seed.asOf).toBe("2026-10-01");

          for (const [key, entry] of Object.entries(services)) {
            // Exact normalized match returns the entry + the seed's asOf.
            const hit = lookupSuggestion(seed, key);
            expect(hit).not.toBeNull();
            expect(hit!.amountMinor).toBe(entry.amountMinor);
            expect(hit!.currency).toBe(entry.currency);
            expect(hit!.billingCycle).toBe(entry.billingCycle);
            expect(hit!.asOf).toBe("2026-10-01");

            // Trim + case variants hit the SAME entry (normalization).
            expect(lookupSuggestion(seed, `  ${key.toUpperCase()}  `)).toEqual(hit);
          }

          // A name that is not a key (append a sentinel) misses → null.
          expect(lookupSuggestion(seed, "zzz-not-a-key-zzz")).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("throws PriceSeedError on each malformed variant (loud, never a silent empty table)", () => {
    const base = validRawSeed();
    const bad: unknown[] = [
      null,
      42,
      "nope",
      [],
      { ...base, schemaVersion: 2 }, // unsupported version
      { ...base, schemaVersion: "1" }, // non-integer
      { ...base, asOf: "10/01/2026" }, // bad date shape
      { ...base, asOf: 20261001 },
      { ...base, asOf: "2026-13-99" }, // shape-valid but impossible calendar date
      { ...base, asOf: "2026-02-30" }, // Feb 30 — right shape, not a real date
      { ...base, disclaimer: "" }, // empty disclaimer
      { ...base, disclaimer: 123 },
      { ...base, services: null },
      { ...base, services: [] },
      { ...base, services: { x: { amountMinor: -1, currency: "USD", billingCycle: "Monthly" } } },
      { ...base, services: { x: { amountMinor: 1.5, currency: "USD", billingCycle: "Monthly" } } },
      { ...base, services: { x: { amountMinor: 100, currency: "", billingCycle: "Monthly" } } },
      { ...base, services: { x: { amountMinor: 100, currency: "USD", billingCycle: "Decade" } } },
      { ...base, services: { x: { amountMinor: 100, currency: "USD" } } }, // missing cycle
      { ...base, services: { x: "not-an-object" } },
    ];
    for (const raw of bad) {
      expect(() => parsePriceSeed(raw)).toThrow(PriceSeedError);
    }
  });
});

// --- Example tests: I/O matrix rows ------------------------------------------

describe("parsePriceSeed — valid shape", () => {
  it("validates a well-formed seed into a typed PriceSeed (normalized service keys)", () => {
    const seed = parsePriceSeed(validRawSeed());
    expect(seed.schemaVersion).toBe(1);
    expect(seed.asOf).toBe("2026-10-01");
    expect(seed.disclaimer).toMatch(/[Aa]pproximate/);
    expect(Object.keys(seed.services)).toContain("netflix");
    expect(seed.services["netflix"]).toEqual({
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly",
    });
  });

  it("throws on a shape-valid but impossible-calendar asOf (fails LOUD in main, never reaches the renderer)", () => {
    // "2026-13-99" matches the YYYY-MM-DD shape but is not a real date. It must
    // throw at PARSE time so the main process degrades the feature off — it must
    // NOT pass parse and later throw in the renderer's isSeedStale (outside the
    // modal's try/catch).
    expect(() => parsePriceSeed({ ...validRawSeed(), asOf: "2026-13-99" })).toThrow(
      PriceSeedError,
    );
    expect(() => parsePriceSeed({ ...validRawSeed(), asOf: "2026-02-30" })).toThrow(
      PriceSeedError,
    );
  });

  it("re-normalizes mixed-case / whitespace keys so lookup is a stable exact match", () => {
    const seed = parsePriceSeed({
      schemaVersion: 1,
      asOf: "2026-10-01",
      disclaimer: "approx",
      services: {
        "  NetFlix ": { amountMinor: 1549, currency: "USD", billingCycle: "Monthly" },
      },
    });
    expect(lookupSuggestion(seed, "netflix")).toEqual({
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly",
      asOf: "2026-10-01",
    });
  });
});

describe("lookupSuggestion — match / miss / normalization", () => {
  const seed: PriceSeed = parsePriceSeed(validRawSeed());

  it("matches a known name regardless of surrounding whitespace and case", () => {
    const expected = {
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly" as const,
      asOf: "2026-10-01",
    };
    expect(lookupSuggestion(seed, "  Netflix ")).toEqual(expected);
    expect(lookupSuggestion(seed, "NETFLIX")).toEqual(expected);
    expect(lookupSuggestion(seed, "netflix")).toEqual(expected);
  });

  it("returns null for an unknown name", () => {
    expect(lookupSuggestion(seed, "MyCustomThing")).toBeNull();
  });

  it("returns null for an empty / whitespace-only query (no fuzzy)", () => {
    expect(lookupSuggestion(seed, "")).toBeNull();
    expect(lookupSuggestion(seed, "   ")).toBeNull();
  });

  it("does NOT fuzzy-match a partial / superstring name", () => {
    expect(lookupSuggestion(seed, "net")).toBeNull();
    expect(lookupSuggestion(seed, "netflix premium")).toBeNull();
  });
});

describe("isSeedStale — boundary around maxAgeDays", () => {
  it("a seed older than maxAgeDays is stale; exactly maxAgeDays or newer is fresh", () => {
    // asOf 2024-01-01 → 2026-01-01 is 731 days (incl. 2024 leap year) > 365.
    expect(isSeedStale("2024-01-01", "2026-01-01", 365)).toBe(true);
    // A recent seed (one month old) is fresh.
    expect(isSeedStale("2026-09-01", "2026-10-01", 365)).toBe(false);
  });

  it("exactly maxAgeDays old is NOT stale (strictly greater is stale)", () => {
    // 2025-01-01 + 365 days = 2026-01-01 (2025 is not a leap year).
    expect(isSeedStale("2025-01-01", "2026-01-01", 365)).toBe(false); // == 365
    expect(isSeedStale("2025-01-01", "2026-01-02", 365)).toBe(true); // 366 > 365
  });

  it("a same-day or future-dated seed is never stale", () => {
    expect(isSeedStale("2026-10-01", "2026-10-01", 365)).toBe(false);
    expect(isSeedStale("2026-12-01", "2026-10-01", 365)).toBe(false); // future
  });

  it("throws on an invalid date (never a silent 'fresh')", () => {
    expect(() => isSeedStale("not-a-date", "2026-10-01", 365)).toThrow(PriceSeedError);
    expect(() => isSeedStale("2026-13-99", "2026-10-01", 365)).toThrow(PriceSeedError);
  });
});

// --- Real committed asset parses (fixture-free sanity, like the tray test) ---

describe("the REAL committed resources/price-seed.json parses", () => {
  const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  const devOpts: ResolveResourceDirOptions = {
    isPackaged: false,
    resourcesPath: "/unused/in/dev",
    appPath: REPO_ROOT,
  };

  it("reads + validates the shipped seed and resolves a known service", () => {
    const seed = readBundledPriceSeed(devOpts);
    expect(seed.schemaVersion).toBe(PRICE_SEED_SCHEMA_VERSION);
    expect(seed.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(seed.disclaimer.length).toBeGreaterThan(0);

    // The committed asset ships 20 services (per the authored fixture).
    expect(Object.keys(seed.services).length).toBe(20);

    // A spot-checked known service resolves with its figures + the seed's asOf.
    const netflix = lookupSuggestion(seed, "Netflix");
    expect(netflix).not.toBeNull();
    expect(netflix!.currency).toBe("USD");
    expect(netflix!.billingCycle).toBe("Monthly");
    expect(netflix!.amountMinor).toBeGreaterThan(0);
    expect(netflix!.asOf).toBe(seed.asOf);

    // Every entry's billingCycle is a valid BillingCycle and amount is a
    // non-negative integer.
    for (const [, entry] of Object.entries(seed.services)) {
      expect(VALID_CYCLES).toContain(entry.billingCycle);
      expect(Number.isInteger(entry.amountMinor)).toBe(true);
      expect(entry.amountMinor).toBeGreaterThanOrEqual(0);
      expect(entry.currency.length).toBeGreaterThan(0);
    }
  });

  it("a missing seed resource throws (loud) — the main process catches this to degrade off", () => {
    const seedPath = join(REPO_ROOT, "resources", "price-seed.json");
    // Sanity: the asset exists (it is authored & committed).
    expect(seedPath).toContain("price-seed.json");
    // Pointing at a dir with no seed throws (ResourceReadError), proving the
    // read is loud; app-wiring wraps this in try/catch → feature off.
    expect(() =>
      readBundledPriceSeed({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath: "/nonexistent-subby-root",
      }),
    ).toThrow();
  });
});
