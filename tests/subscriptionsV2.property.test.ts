import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  createSubscriptionV2,
  setNativeCurrency,
  editSubscriptionV2,
  setSubscriptionState,
  deleteSubscriptionV2,
  type SubscriptionInputV2,
} from "core/subscriptionsV2";
import {
  minorUnits,
  toMajor,
  exponentOf,
  MINOR_UNIT_EXPONENT,
  UnknownCurrencyError,
  InvalidAmountError,
} from "core/money";
import { roundHalfUpToExponent } from "core/migrations/v1_to_v2";
import { subscriptionV2Schema } from "core/models/schema";
import type { SubscriptionState, SubscriptionV2 } from "core/models/subscription";

/**
 * Native-Currency-per-subscription properties (FR-10, Story 2.1).
 *
 * Property 33 — a v2 subscription created at ANY Home Currency round-trips
 *               `toMajor(created.amountMinor, created.currency)` to the
 *               canonical major value, and with no currency supplied the
 *               created `currency` equals the Home Currency — independent of
 *               the Home Currency.
 * Property 34 — `setNativeCurrency` changes only the target sub, preserves the
 *               amount's major value across the currency change (up to the
 *               target exponent), advances only that sub's `updatedAt`, and the
 *               result validates against `subscriptionV2Schema`.
 *
 * Plus example tests for every I/O-matrix row (default-to-Home, explicit JPY
 * exp-0, unknown-currency throw, over-precise throw, id-not-found no-op, per-sub
 * isolation, Home≠Native display).
 */

const NUM_RUNS = 300;
const NOW = "2026-10-12T00:00:00.000Z";

// --- Generators --------------------------------------------------------------

const ALL_CURRENCIES = Object.keys(MINOR_UNIT_EXPONENT);
const knownCurrencyArb = fc.constantFrom(...ALL_CURRENCIES);

/**
 * A non-negative major amount string with at most `exponent` fractional digits,
 * i.e. an amount exactly representable in the currency's minor units (mirrors
 * `money.property.test.ts`'s `majorAmountArb`).
 */
function majorAmountArb(exponent: number) {
  return fc
    .record({
      whole: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      frac: fc.string({ unit: fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"), maxLength: exponent }),
    })
    .map(({ whole, frac }) => (exponent === 0 || frac === "" ? whole.toString() : `${whole}.${frac}`));
}

/** Reference canonical major string: pad/truncate the fractional part exactly. */
function canonicalMajor(major: string, exponent: number): string {
  const [whole, frac = ""] = major.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  return `${normalizedWhole}.${frac.padEnd(exponent, "0").slice(0, exponent)}`;
}

/**
 * The non-money, non-system fields a `SubscriptionInputV2` carries over. These
 * are the fields the create input shares with a schema-valid `SubscriptionV2`
 * minus `id`/`amountMinor`/`currency`/`createdAt`/`updatedAt`.
 */
const baseInputFieldsArb = fc.record({
  name: fc.string({ minLength: 1 }),
  provider: fc.string(),
  category: fc.string(),
  billingCycle: fc.constantFrom("Weekly", "Monthly", "Quarterly", "Half-Yearly", "Yearly") as fc.Arbitrary<
    "Weekly" | "Monthly" | "Quarterly" | "Half-Yearly" | "Yearly"
  >,
  nextRenewal: fc.constant("2026-11-01"),
  startDate: fc.constant("2026-01-01"),
  paymentMethod: fc.string(),
  website: fc.string(),
  notes: fc.string(),
  color: fc.string(),
  icon: fc.string(),
  state: fc.constantFrom("Active", "Paused") as fc.Arbitrary<"Active" | "Paused">,
  priceHistory: fc.constant([] as SubscriptionV2["priceHistory"]),
  tags: fc.array(fc.string(), { maxLength: 3 }),
  autoRenew: fc.boolean(),
});

/** A ready-made example input, used by example tests. */
const EXAMPLE_FIELDS: Omit<SubscriptionInputV2, "amountMajor" | "currency"> = {
  name: "Netflix",
  provider: "Netflix",
  category: "Streaming",
  billingCycle: "Monthly",
  nextRenewal: "2026-11-01",
  startDate: "2026-01-01",
  paymentMethod: "Visa",
  website: "netflix.com",
  notes: "",
  color: "#000000",
  icon: "netflix",
  state: "Active",
  priceHistory: [],
  tags: ["video"],
  autoRenew: true,
};

// --- Property 33: create round-trips value-exact, independent of Home --------

describe("Feature: subby, Property 33: a created v2 sub round-trips in its Native Currency, independent of Home Currency", () => {
  it("Feature: subby, Property 33: created amountMinor round-trips to the canonical major value for any homeCurrency, and defaults currency to homeCurrency when unspecified", () => {
    const scenarioArb = fc
      .record({
        nativeCurrency: knownCurrencyArb,
        homeCurrency: knownCurrencyArb,
        base: baseInputFieldsArb,
        supplyCurrency: fc.boolean(),
      })
      // The entered amount must be exactly representable in whichever currency
      // is actually resolved — the explicit `nativeCurrency` when supplied, else
      // the `homeCurrency` the default rule falls back to.
      .chain((s) => {
        const resolvedCurrency = s.supplyCurrency ? s.nativeCurrency : s.homeCurrency;
        return majorAmountArb(exponentOf(resolvedCurrency)).map((amountMajor) => ({ ...s, amountMajor }));
      });

    fc.assert(
      fc.property(scenarioArb, ({ nativeCurrency, homeCurrency, base, supplyCurrency, amountMajor }) => {
        const input: SubscriptionInputV2 = supplyCurrency
          ? { ...base, amountMajor, currency: nativeCurrency }
          : { ...base, amountMajor };

        const result = createSubscriptionV2([], input, homeCurrency, NOW);
        const created = result.at(-1)!;

        // Default-to-Home rule: no explicit currency => currency === homeCurrency;
        // an explicit currency is kept verbatim — independent of homeCurrency.
        const expectedCurrency = supplyCurrency ? nativeCurrency : homeCurrency;
        expect(created.currency).toBe(expectedCurrency);

        // amountMinor is an exponent-correct integer scaling, and rendering it
        // back in the created sub's OWN currency yields the canonical major
        // value — regardless of homeCurrency.
        const exponent = exponentOf(expectedCurrency);
        expect(Number.isInteger(created.amountMinor)).toBe(true);
        const back = toMajor(created.amountMinor, created.currency);
        // majorAmountArb(0) yields a bare whole-number string (no fractional
        // part), so for a 0-exponent currency the canonical form is the amount
        // itself; otherwise pad/truncate to the exponent.
        const expected = exponent === 0 ? amountMajor : canonicalMajor(amountMajor, exponent);
        expect(back).toBe(expected);

        // Immutable system fields are set deterministically; input is appended.
        expect(created.createdAt).toBe(NOW);
        expect(created.updatedAt).toBe(NOW);
        expect(typeof created.id).toBe("string");
        expect(created.id.length).toBeGreaterThan(0);
        expect(result).toHaveLength(1);

        // The created record is schema-valid v2.
        expect(subscriptionV2Schema.safeParse(created).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Property 34: setNativeCurrency isolates, preserves major, re-validates --

describe("Feature: subby, Property 34: setNativeCurrency changes only the target sub and preserves the amount's major value", () => {
  /** Build a schema-valid v2 sub with a known currency and amount. */
  function makeSub(id: string, currency: string, amountMinor: number): SubscriptionV2 {
    return {
      ...EXAMPLE_FIELDS,
      id,
      amountMinor,
      currency,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("Feature: subby, Property 34: only the target sub changes; its major value is preserved (to the target exponent), updatedAt advances, and the result stays schema-valid", () => {
    const scenarioArb = fc
      .record({
        sourceCurrency: knownCurrencyArb,
        targetCurrency: knownCurrencyArb,
        otherCurrency: knownCurrencyArb,
      })
      .chain((s) =>
        fc
          .record({
            // Keep amounts well within the safe range so the round-trip is lossless.
            targetAmount: majorAmountArb(exponentOf(s.sourceCurrency)),
            otherAmount: fc.integer({ min: 0, max: 1_000_000 }),
          })
          .map((amounts) => ({ ...s, ...amounts })),
      );

    fc.assert(
      fc.property(scenarioArb, ({ sourceCurrency, targetCurrency, otherCurrency, targetAmount, otherAmount }) => {
        const sourceMinor = minorUnits(targetAmount, sourceCurrency);
        const subA = makeSub("A", sourceCurrency, sourceMinor);
        const subB = makeSub("B", otherCurrency, otherAmount);
        const list = [subA, subB];

        const result = setNativeCurrency(list, "A", targetCurrency, NOW);

        // Input is never mutated.
        expect(list[0]).toBe(subA);
        expect(list[1]).toBe(subB);
        expect(subA.currency).toBe(sourceCurrency);
        expect(subA.updatedAt).toBe("2026-01-01T00:00:00.000Z");

        const [newA, newB] = result;

        // Only A changes: currency set to target, updatedAt advanced.
        expect(newA.currency).toBe(targetCurrency);
        expect(newA.updatedAt).toBe(NOW);

        // B is untouched (same reference, unchanged updatedAt).
        expect(newB).toBe(subB);
        expect(newB.updatedAt).toBe("2026-01-01T00:00:00.000Z");

        // The amount's MAJOR value is preserved across the currency change, up
        // to a half-up round to the target exponent — exactly the migrator's
        // rule. Compute the reference the same way the setter does.
        const sourceExp = exponentOf(sourceCurrency);
        const targetExp = exponentOf(targetCurrency);
        const expectedRoundedMajor = roundHalfUpToExponent(Number(toMajor(sourceMinor, sourceCurrency)), targetExp);
        expect(newA.amountMinor).toBe(minorUnits(expectedRoundedMajor, targetCurrency));

        // When source and target exponents match, the major value is preserved
        // EXACTLY (no rounding loss).
        if (sourceExp === targetExp) {
          expect(toMajor(newA.amountMinor, targetCurrency)).toBe(toMajor(sourceMinor, sourceCurrency));
        }

        // The mutated record stays schema-valid v2.
        expect(subscriptionV2Schema.safeParse(newA).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// --- Example tests: every I/O-matrix row -------------------------------------

describe("subscriptionsV2 I/O matrix (example tests)", () => {
  it("create, no currency given: defaults to Home Currency and parses the major amount (EUR 9.99 -> 999)", () => {
    const result = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "9.99" }, "EUR", NOW);
    const created = result.at(-1)!;
    expect(created.currency).toBe("EUR");
    expect(created.amountMinor).toBe(999);
  });

  it("create, explicit currency ≠ Home: kept verbatim and exponent-correct (JPY 1000 -> 1000, not 100000)", () => {
    const result = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "1000", currency: "JPY" }, "USD", NOW);
    const created = result.at(-1)!;
    expect(created.currency).toBe("JPY");
    expect(created.amountMinor).toBe(1000); // exponent 0, NOT 100000
  });

  it("create, immutable system fields: fresh id, createdAt === updatedAt === now, safe-empty collections", () => {
    const result = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "5.00", priceHistory: [], tags: [] }, "USD", NOW);
    const created = result.at(-1)!;
    expect(created.id).toMatch(/[0-9a-f-]{36}/i);
    expect(created.createdAt).toBe(NOW);
    expect(created.updatedAt).toBe(NOW);
    expect(created.priceHistory).toEqual([]);
    expect(created.tags).toEqual([]);
  });

  it("create: priceHistory/tags default to empties when the caller omits them", () => {
    // Build an input lacking priceHistory/tags entirely.
    const { priceHistory: _ph, tags: _t, ...withoutCollections } = EXAMPLE_FIELDS;
    const input = { ...withoutCollections, amountMajor: "1.00" } as SubscriptionInputV2;
    const created = createSubscriptionV2([], input, "USD", NOW).at(-1)!;
    expect(created.priceHistory).toEqual([]);
    expect(created.tags).toEqual([]);
    expect(subscriptionV2Schema.safeParse(created).success).toBe(true);
  });

  it("create, unknown currency: throws UnknownCurrencyError, never a silent exponent-2 default", () => {
    expect(() => createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "10.00", currency: "ZZZ" }, "USD", NOW)).toThrow(
      UnknownCurrencyError,
    );
  });

  it("create, over-precise amount: throws InvalidAmountError (USD 1.001)", () => {
    expect(() => createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "1.001", currency: "USD" }, "USD", NOW)).toThrow(
      InvalidAmountError,
    );
  });

  it("create does not mutate the existing array and appends in order", () => {
    const existing: SubscriptionV2[] = [];
    const r1 = createSubscriptionV2(existing, { ...EXAMPLE_FIELDS, amountMajor: "1.00" }, "USD", NOW);
    expect(existing).toHaveLength(0); // input untouched
    const r2 = createSubscriptionV2(r1, { ...EXAMPLE_FIELDS, amountMajor: "2.00" }, "USD", NOW);
    expect(r2).toHaveLength(2);
    expect(r2[0].amountMinor).toBe(100);
    expect(r2[1].amountMinor).toBe(200);
  });

  it("set Native Currency per sub: USD $10.00 -> JPY ¥10, major value preserved, only target changes", () => {
    const usdSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "10.00" }, "USD", "2026-01-01T00:00:00.000Z").at(
      -1,
    )!;
    const otherSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "20.00" }, "USD", "2026-01-01T00:00:00.000Z").at(
      -1,
    )!;
    expect(usdSub.amountMinor).toBe(1000);

    const list = [usdSub, otherSub];
    const result = setNativeCurrency(list, usdSub.id, "JPY", NOW);
    const [newUsd, newOther] = result;

    // $10.00 -> major 10 -> ¥10 (round-half-up to exponent 0).
    expect(newUsd.currency).toBe("JPY");
    expect(newUsd.amountMinor).toBe(10);
    expect(newUsd.updatedAt).toBe(NOW);

    // The other sub is untouched.
    expect(newOther).toBe(otherSub);
    expect(newOther.amountMinor).toBe(2000);
    expect(newOther.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("set Native Currency: same-exponent change preserves the major value exactly (USD -> EUR)", () => {
    const usdSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "12.34" }, "USD", "2026-01-01T00:00:00.000Z").at(
      -1,
    )!;
    const result = setNativeCurrency([usdSub], usdSub.id, "EUR", NOW);
    expect(result[0].currency).toBe("EUR");
    expect(result[0].amountMinor).toBe(1234);
    expect(toMajor(result[0].amountMinor, "EUR")).toBe("12.34");
  });

  it("set Native Currency: cross-exponent round rules (KWD 3-exp -> JPY 0-exp rounds half-up)", () => {
    // KWD 1.500 -> major 1.5 -> round half-up to exponent 0 -> 2 -> ¥2.
    const kwdSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "1.500", currency: "KWD" }, "USD", NOW).at(-1)!;
    expect(kwdSub.amountMinor).toBe(1500);
    const result = setNativeCurrency([kwdSub], kwdSub.id, "JPY", NOW);
    expect(result[0].currency).toBe("JPY");
    expect(result[0].amountMinor).toBe(2); // 1.5 rounds half-up to 2
  });

  it("set unknown currency: throws UnknownCurrencyError (loud guard)", () => {
    const usdSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "10.00" }, "USD", NOW).at(-1)!;
    expect(() => setNativeCurrency([usdSub], usdSub.id, "ZZZ", NOW)).toThrow(UnknownCurrencyError);
  });

  it("set, id not found: returns a new array with identical contents (no-op)", () => {
    const usdSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "10.00" }, "USD", "2026-01-01T00:00:00.000Z").at(
      -1,
    )!;
    const list = [usdSub];
    const result = setNativeCurrency(list, "no-such-id", "EUR", NOW);
    expect(result).not.toBe(list); // a new array
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(usdSub); // contents identical and unchanged
    expect(result[0].currency).toBe("USD");
    expect(result[0].updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("display round-trip, Home ≠ Native: a GBP sub renders its GBP major value regardless of Home Currency", () => {
    // Home Currency is INR, but the sub's Native Currency is GBP.
    const gbpSub = createSubscriptionV2([], { ...EXAMPLE_FIELDS, amountMajor: "7.50", currency: "GBP" }, "INR", NOW).at(-1)!;
    expect(gbpSub.currency).toBe("GBP");
    expect(gbpSub.amountMinor).toBe(750);
    // Display is in the sub's OWN Native Currency — independent of homeCurrency.
    expect(toMajor(gbpSub.amountMinor, gbpSub.currency)).toBe("7.50");
  });
});

// --- Property 40: the live v2 mutators (Story 3.3) ---------------------------

/**
 * Property 40 — the three live v2 mutators Story 3.3 wires into the IPC spine
 * each honor the pure, surgical contract they mirror from `core/subscriptions.ts`:
 *
 *   - {@link setSubscriptionState} changes ONLY the target sub's `state` and
 *     advances ONLY its `updatedAt` — every other sub (and every other field of
 *     the target) is untouched; the input array is never mutated.
 *   - {@link editSubscriptionV2} applies a patch to the target, PRESERVES its
 *     `id`/`createdAt`, advances its `updatedAt`, and leaves non-target subs and
 *     the input array untouched.
 *   - {@link deleteSubscriptionV2} removes EXACTLY one sub (the target), keeps the
 *     others in their original relative order, and never mutates the input.
 *
 * Each result stays schema-valid v2 (`subscriptionV2Schema`).
 */

const LATER = "2026-12-25T12:00:00.000Z"; // strictly after each sub's createdAt
const stateArb = fc.constantFrom<SubscriptionState>("Active", "Paused");

/**
 * A small list of distinct, schema-valid v2 subs plus an index into it (the
 * mutation target). Each sub has a unique id (`s0`, `s1`, …) and a known earlier
 * `createdAt`/`updatedAt` so an advance is observable.
 */
const listAndTargetArb = fc
  .array(
    fc.record({
      currency: knownCurrencyArb,
      amountMinor: fc.integer({ min: 0, max: 1_000_000 }),
      state: stateArb,
    }),
    { minLength: 1, maxLength: 6 },
  )
  .chain((specs) =>
    fc.record({
      specs: fc.constant(specs),
      targetIndex: fc.integer({ min: 0, max: specs.length - 1 }),
    }),
  )
  .map(({ specs, targetIndex }) => {
    const subs: SubscriptionV2[] = specs.map((spec, i) => ({
      ...EXAMPLE_FIELDS,
      id: `s${i}`,
      amountMinor: spec.amountMinor,
      currency: spec.currency,
      state: spec.state,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    return { subs, targetIndex };
  });

describe("Feature: subby, Property 40: the live v2 mutators are pure and surgical", () => {
  it("Feature: subby, Property 40: setSubscriptionState touches only the target's state + updatedAt; input never mutated; result schema-valid", () => {
    fc.assert(
      fc.property(listAndTargetArb, stateArb, ({ subs, targetIndex }, nextState) => {
        const target = subs[targetIndex];
        const snapshot = subs.map((s) => ({ ...s }));

        const result = setSubscriptionState(subs, target.id, nextState, LATER);

        // Input array + each element are untouched (pure).
        expect(subs).toEqual(snapshot);

        result.forEach((r, i) => {
          const original = subs[i];
          if (i === targetIndex) {
            expect(r.state).toBe(nextState);
            expect(r.updatedAt).toBe(LATER);
            // Every OTHER field of the target is identical.
            expect({ ...r, state: original.state, updatedAt: original.updatedAt }).toEqual(
              original,
            );
          } else {
            // Non-target subs are referentially unchanged (map returns `s`).
            expect(r).toBe(original);
          }
        });

        expect(subscriptionV2Schema.safeParse(result[targetIndex]).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 40: editSubscriptionV2 preserves id/createdAt, advances updatedAt, applies the patch, leaves others untouched", () => {
    const patchArb = fc.record({
      name: fc.string({ minLength: 1 }),
      amountMinor: fc.integer({ min: 0, max: 1_000_000 }),
      notes: fc.string(),
    });

    fc.assert(
      fc.property(listAndTargetArb, patchArb, ({ subs, targetIndex }, patch) => {
        const target = subs[targetIndex];
        const snapshot = subs.map((s) => ({ ...s }));

        const result = editSubscriptionV2(subs, target.id, patch, LATER);

        // Input untouched.
        expect(subs).toEqual(snapshot);

        const edited = result[targetIndex];
        // Immutable identity preserved.
        expect(edited.id).toBe(target.id);
        expect(edited.createdAt).toBe(target.createdAt);
        // updatedAt advanced to `now`.
        expect(edited.updatedAt).toBe(LATER);
        // The patch landed.
        expect(edited.name).toBe(patch.name);
        expect(edited.amountMinor).toBe(patch.amountMinor);
        expect(edited.notes).toBe(patch.notes);

        // Non-target subs are referentially unchanged.
        result.forEach((r, i) => {
          if (i !== targetIndex) expect(r).toBe(subs[i]);
        });

        expect(subscriptionV2Schema.safeParse(edited).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 40: deleteSubscriptionV2 removes exactly the target, preserves order of the rest, never mutates input", () => {
    fc.assert(
      fc.property(listAndTargetArb, ({ subs, targetIndex }) => {
        const target = subs[targetIndex];
        const snapshot = subs.map((s) => ({ ...s }));

        const result = deleteSubscriptionV2(subs, target.id);

        // Input untouched.
        expect(subs).toEqual(snapshot);

        // Exactly one removed — the target.
        expect(result).toHaveLength(subs.length - 1);
        expect(result.some((s) => s.id === target.id)).toBe(false);

        // The surviving subs keep their original relative order (and identity).
        const expectedSurvivors = subs.filter((_s, i) => i !== targetIndex);
        expect(result).toEqual(expectedSurvivors);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Feature: subby, Property 40: unknown id is a no-op — setState/edit return same contents; delete removes nothing", () => {
    const subs: SubscriptionV2[] = [
      {
        ...EXAMPLE_FIELDS,
        id: "s0",
        amountMinor: 100,
        currency: "USD",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const afterState = setSubscriptionState(subs, "no-such-id", "Paused", LATER);
    expect(afterState).toEqual(subs); // contents identical (fresh array)

    const afterEdit = editSubscriptionV2(subs, "no-such-id", { name: "Nope" }, LATER);
    expect(afterEdit).toEqual(subs);

    const afterDelete = deleteSubscriptionV2(subs, "no-such-id");
    expect(afterDelete).toEqual(subs);
    expect(afterDelete).toHaveLength(1);
  });
});
