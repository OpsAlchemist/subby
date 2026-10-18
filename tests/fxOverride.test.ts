import { describe, expect, it } from "vitest";

import {
  FxSnapshotError,
  parseBundledSnapshot,
  parseFxOverride,
  resolveEffectiveSnapshot,
  type BundledFxSnapshot,
  type FxOverride,
} from "core/fxSnapshot";
import { UnknownCurrencyError } from "core/money";

/**
 * FX refresh override — the pure resolution core (Story 8.6; AD-23).
 *
 * Covers the I/O matrix rows that live in `core/fxSnapshot.ts`:
 *   - `parseFxOverride` LOUD validation (reuses the bundle's positive-rate rule
 *     + requires a `fetchedAt` instant): a malformed override throws (so the
 *     service never writes a bad one; a disk read degrades to null elsewhere).
 *   - `resolveEffectiveSnapshot` newest-`asOf`-wins: newer override wins, a
 *     FRESHER bundle is never shadowed by a stale override, equal → bundle, and
 *     the null-safe cases.
 */

/** A valid EUR-based bundle at a given asOf. */
function bundle(asOf: string): BundledFxSnapshot {
  return parseBundledSnapshot({
    schemaVersion: 1,
    asOf,
    base: "EUR",
    attribution: "ECB reference rates, bundled offline.",
    rates: { EUR: "1", USD: "1.0950", INR: "91.350" },
  });
}

/** A valid override at a given asOf + fetchedAt. */
function override(asOf: string, fetchedAt: string): FxOverride {
  return parseFxOverride({
    schemaVersion: 1,
    asOf,
    base: "EUR",
    attribution: "ECB reference rates via Frankfurter.",
    rates: { EUR: "1", USD: "1.1000", INR: "92.000" },
    fetchedAt,
  });
}

// --- parseFxOverride: loud validation ----------------------------------------

describe("parseFxOverride: LOUD validation (reuses the bundle positive-rate rule)", () => {
  it("accepts a well-formed override and carries fetchedAt verbatim", () => {
    const o = parseFxOverride({
      schemaVersion: 1,
      asOf: "2026-10-15",
      base: "EUR",
      attribution: "ECB via Frankfurter.",
      rates: { EUR: "1", USD: "1.1" },
      fetchedAt: "2026-10-15T08:00:00.000Z",
    });
    expect(o.asOf).toBe("2026-10-15");
    expect(o.fetchedAt).toBe("2026-10-15T08:00:00.000Z");
    expect(o.rates.USD).toBe("1.1");
  });

  it("THROWS on a non-positive rate (a wrong rate is a wrong total)", () => {
    expect(() =>
      parseFxOverride({
        schemaVersion: 1,
        asOf: "2026-10-15",
        base: "EUR",
        attribution: "x",
        rates: { EUR: "1", USD: "0" },
        fetchedAt: "2026-10-15T00:00:00Z",
      }),
    ).toThrow(FxSnapshotError);
  });

  it("THROWS on a malformed (non-decimal) rate", () => {
    expect(() =>
      parseFxOverride({
        schemaVersion: 1,
        asOf: "2026-10-15",
        base: "EUR",
        attribution: "x",
        rates: { EUR: "1", USD: "abc" },
        fetchedAt: "2026-10-15T00:00:00Z",
      }),
    ).toThrow(FxSnapshotError);
  });

  it("THROWS on an unknown currency (reuses the money core's UnknownCurrencyError)", () => {
    expect(() =>
      parseFxOverride({
        schemaVersion: 1,
        asOf: "2026-10-15",
        base: "EUR",
        attribution: "x",
        rates: { EUR: "1", ZZZ: "1.1" },
        fetchedAt: "2026-10-15T00:00:00Z",
      }),
    ).toThrow(UnknownCurrencyError);
  });

  it("THROWS on a missing / badly-shaped fetchedAt", () => {
    const base = {
      schemaVersion: 1,
      asOf: "2026-10-15",
      base: "EUR",
      attribution: "x",
      rates: { EUR: "1", USD: "1.1" },
    };
    expect(() => parseFxOverride(base)).toThrow(FxSnapshotError); // absent
    expect(() => parseFxOverride({ ...base, fetchedAt: "" })).toThrow(FxSnapshotError);
    expect(() => parseFxOverride({ ...base, fetchedAt: "nope" })).toThrow(FxSnapshotError);
    expect(() => parseFxOverride({ ...base, fetchedAt: 1699 })).toThrow(FxSnapshotError);
  });
});

// --- resolveEffectiveSnapshot: newest asOf wins ------------------------------

describe("resolveEffectiveSnapshot: newest asOf wins (AD-23)", () => {
  it("a NEWER override wins over the bundle", () => {
    const b = bundle("2026-10-01");
    const o = override("2026-10-15", "2026-10-15T00:00:00Z");
    const effective = resolveEffectiveSnapshot(b, o);
    expect(effective).toBe(o);
    expect(effective!.asOf).toBe("2026-10-15");
    // The override's distinct USD rate is the one that flows into totals.
    expect(effective!.rates.USD).toBe("1.1000");
  });

  it("a FRESHER bundle is NOT shadowed by a stale override (release bump wins)", () => {
    // A release bumps the bundle to 2026-11-01 while the override is still 10-15.
    const b = bundle("2026-11-01");
    const o = override("2026-10-15", "2026-10-15T00:00:00Z");
    const effective = resolveEffectiveSnapshot(b, o);
    expect(effective).toBe(b);
    expect(effective!.asOf).toBe("2026-11-01");
  });

  it("EQUAL asOf → the bundle (no churn)", () => {
    const b = bundle("2026-10-15");
    const o = override("2026-10-15", "2026-10-15T09:00:00Z");
    expect(resolveEffectiveSnapshot(b, o)).toBe(b);
  });

  it("null-safe: one-null returns the other, both-null returns null", () => {
    const b = bundle("2026-10-01");
    const o = override("2026-10-15", "2026-10-15T00:00:00Z");
    expect(resolveEffectiveSnapshot(b, null)).toBe(b);
    expect(resolveEffectiveSnapshot(null, o)).toBe(o);
    expect(resolveEffectiveSnapshot(null, null)).toBeNull();
  });
});
