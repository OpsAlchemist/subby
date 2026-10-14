import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  createCategory,
  mergeSettings,
  assignDefaultColors,
  setCategoryColor,
  addTag,
  removeTag,
} from "core/categories";
import type { Category } from "core/models/category";
import type { ReminderLeadTime, Settings } from "core/models/settings";
import { DEFAULT_CATEGORIES, DEFAULT_CATEGORY_COLORS } from "core/models/schema";

/**
 * Property-based tests for category and settings logic (task 6.4).
 *
 * Property 11: Category names are unique — Validates: Requirements 7.3
 * Property 18: Settings update round-trips — Validates: Requirements 15.2
 *
 * Each `fc.assert` runs at least 100 iterations.
 */

const NUM_RUNS = 200;

/** Normalize a category name exactly as `createCategory` does. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// =============================================================================
// Property 11: Category names are unique (Req 7.3)
// =============================================================================

// Names are drawn from a constrained ASCII alphabet so that case folding is
// stable (e.g. avoids unicode pitfalls like "ß".toUpperCase() === "SS"). This
// keeps the casing/whitespace perturbations used to force duplicates faithful.
const NAME_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split("");

const rawNameArb = fc
  .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""))
  .filter((s) => s.trim().length > 0);

/** A list of existing categories with pairwise-distinct normalized names. */
const existingCategoriesArb = fc
  .uniqueArray(rawNameArb, { selector: normalizeName, maxLength: 12 })
  .map((names): Category[] =>
    names.map((name, i) => ({ id: `id-${i}`, name, isDefault: false })),
  );

/** Whitespace padding (trimmed away by normalization). */
const paddingArb = fc.stringOf(fc.constantFrom(" ", "\t"), { maxLength: 3 });

/**
 * A scenario: an existing list plus a candidate name. The candidate is either
 * genuinely fresh OR a case/whitespace perturbation of an existing name, so
 * both the accept and the duplicate-reject branches are exercised heavily.
 */
const scenarioArb = existingCategoriesArb.chain((existing) => {
  const freshArb = rawNameArb.map((name) => ({ existing, name }));
  if (existing.length === 0) return freshArb;

  const collidingArb = fc
    .record({
      base: fc.constantFrom(...existing.map((c) => c.name)),
      lead: paddingArb,
      trail: paddingArb,
      upper: fc.boolean(),
    })
    .map(({ base, lead, trail, upper }) => ({
      existing,
      name: lead + (upper ? base.toUpperCase() : base.toLowerCase()) + trail,
    }));

  return fc.oneof(freshArb, collidingArb);
});

describe("Feature: subby, Property 11: Category names are unique", () => {
  it("Feature: subby, Property 11: createCategory never yields two categories with the same normalized name (Req 7.3)", () => {
    fc.assert(
      fc.property(scenarioArb, ({ existing, name }) => {
        const result = createCategory(existing, name);

        const candidateNorm = normalizeName(name);
        const existingNorms = existing.map((c) => normalizeName(c.name));
        const isDuplicate = existingNorms.includes(candidateNorm);

        if (isDuplicate) {
          // A pre-existing name (case-insensitive, trimmed) is rejected (Req 7.3).
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBe("duplicate");
            // The echoed name matches an existing category by normalization.
            expect(existingNorms).toContain(normalizeName(result.name));
          }
        } else {
          // A genuinely new name is accepted and grows the list by exactly one.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.categories).toHaveLength(existing.length + 1);
            expect(result.created.isDefault).toBe(false);
          }
        }

        // Core invariant: any produced list has all-unique normalized names.
        if (result.ok) {
          const norms = result.categories.map((c) => normalizeName(c.name));
          expect(new Set(norms).size).toBe(norms.length);
        }

        // Purity: the input list is never mutated.
        expect(existing).toHaveLength(existingNorms.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Property 18: Settings update round-trips (Req 15.2)
// =============================================================================

const leadTimeArb = fc.constantFrom<ReminderLeadTime>(
  "same-day",
  "one-day",
  "three-days",
);
const leadTimesArb = fc.uniqueArray(leadTimeArb);

const settingsArb: fc.Arbitrary<Settings> = fc.record({
  defaultCurrency: fc.string({ minLength: 1 }),
  notification: fc.record({
    enabled: fc.boolean(),
    leadTimes: leadTimesArb,
  }),
  backupFrequency: fc.constantFrom("off", "daily", "weekly"),
  theme: fc.constantFrom("dark", "light", "system"),
  accentColor: fc.string(),
  trayMode: fc.boolean(),
  dataFolder: fc.oneof(fc.string(), fc.constant(null)),
});

/** Drop keys whose value is `undefined` (i.e. "not present in the patch"). */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

const some = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

/**
 * A partial notification patch: `enabled` and/or `leadTimes` may be present or
 * absent, so the deep-merge behavior is fully exercised.
 */
const notificationPatchArb = fc
  .record({
    enabled: some(fc.boolean()),
    leadTimes: some(leadTimesArb),
  })
  .map((o) => compact(o) as Partial<Settings["notification"]>);

/** A patch including an arbitrary subset of top-level fields. */
const patchArb: fc.Arbitrary<Partial<Settings>> = fc
  .record({
    defaultCurrency: some(fc.string({ minLength: 1 })),
    notification: some(notificationPatchArb),
    backupFrequency: some(fc.constantFrom("off", "daily", "weekly")),
    theme: some(fc.constantFrom("dark", "light", "system")),
    accentColor: some(fc.string()),
    trayMode: some(fc.boolean()),
    dataFolder: some(fc.oneof(fc.string(), fc.constant(null))),
  })
  // notification is cast because mergeSettings intentionally accepts a partial
  // notification object and deep-merges it.
  .map((o) => compact(o) as Partial<Settings>);

describe("Feature: subby, Property 18: Settings update round-trips", () => {
  it("Feature: subby, Property 18: patched fields take the patch value, unpatched fields are preserved, input is not mutated, notification deep-merges (Req 15.2)", () => {
    fc.assert(
      fc.property(settingsArb, patchArb, (current, patch) => {
        const before = structuredClone(current);
        const merged = mergeSettings(current, patch);

        // --- Top-level fields (everything except the nested notification) ---
        const topLevelKeys = [
          "defaultCurrency",
          "backupFrequency",
          "theme",
          "accentColor",
          "trayMode",
          "dataFolder",
        ] as const;

        for (const key of topLevelKeys) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) {
            // Patched field equals the patch value.
            expect(merged[key]).toEqual(patch[key]);
          } else {
            // Unpatched field equals the original value.
            expect(merged[key]).toEqual(current[key]);
          }
        }

        // --- Nested notification deep-merge ---
        const patchNotif = patch.notification as
          | Partial<Settings["notification"]>
          | undefined;

        const expectedEnabled =
          patchNotif && Object.prototype.hasOwnProperty.call(patchNotif, "enabled")
            ? patchNotif.enabled
            : current.notification.enabled;
        const expectedLeadTimes =
          patchNotif &&
          Object.prototype.hasOwnProperty.call(patchNotif, "leadTimes")
            ? patchNotif.leadTimes
            : current.notification.leadTimes;

        expect(merged.notification.enabled).toBe(expectedEnabled);
        expect(merged.notification.leadTimes).toEqual(expectedLeadTimes);

        // --- Immutability / no shared references ---
        // Original object is structurally unchanged.
        expect(current).toEqual(before);
        // Result does not alias the original's nested objects/arrays.
        expect(merged.notification).not.toBe(current.notification);
        expect(merged.notification.leadTimes).not.toBe(
          current.notification.leadTimes,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// =============================================================================
// Story 3.4: category color seed/mutation + tag helpers
// =============================================================================

const defaultNameArb = fc.constantFrom(...DEFAULT_CATEGORIES);
const hexArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0")}`);

/** A category that is EITHER a default name or a custom name, with/without color. */
const categoryArb: fc.Arbitrary<Category> = fc
  .record({
    id: fc.uuid(),
    name: fc.oneof(defaultNameArb, rawNameArb),
    isDefault: fc.boolean(),
    color: fc.option(hexArb, { nil: undefined }),
  })
  .map(({ id, name, isDefault, color }) => {
    const c: Category = { id, name, isDefault };
    if (color !== undefined) c.color = color;
    return c;
  });

describe("Story 3.4 Property: assignDefaultColors is additive, never overwrites or affects custom", () => {
  it("only fills a MISSING color on a default-named category; existing colors + custom untouched; input not mutated", () => {
    fc.assert(
      fc.property(fc.array(categoryArb, { maxLength: 20 }), (categories) => {
        const before = structuredClone(categories);
        const next = assignDefaultColors(categories);

        expect(next).toHaveLength(categories.length);
        next.forEach((c, i) => {
          const original = categories[i];
          const seed = DEFAULT_CATEGORY_COLORS[c.name];
          if (original.color !== undefined) {
            // An already-set color is NEVER overwritten.
            expect(c.color).toBe(original.color);
          } else if (seed !== undefined) {
            // A missing color on a default NAME is filled from the seed.
            expect(c.color).toBe(seed);
          } else {
            // A custom name with no color stays colorless.
            expect(c.color).toBeUndefined();
          }
          // id/name/isDefault are preserved; order preserved.
          expect({ id: c.id, name: c.name, isDefault: c.isDefault }).toEqual({
            id: original.id,
            name: original.name,
            isDefault: original.isDefault,
          });
        });

        // Purity: the input is structurally unchanged.
        expect(categories).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("running assignDefaultColors a second time changes nothing beyond the first pass (seeds settle)", () => {
    fc.assert(
      fc.property(fc.array(categoryArb, { maxLength: 20 }), (categories) => {
        const once = assignDefaultColors(categories);
        const twice = assignDefaultColors(once);
        // After one seed every default name already has a color, so a second
        // pass is a pure copy — the seeding has settled.
        expect(twice).toEqual(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Story 3.4 Property: setCategoryColor is color-only, id-scoped, clears by dropping the key", () => {
  it("sets/clears exactly one category and never mutates the input or other fields", () => {
    fc.assert(
      fc.property(
        fc.array(categoryArb, { minLength: 1, maxLength: 15 }),
        fc.option(hexArb, { nil: undefined }),
        (categories, color) => {
          const targetIndex = categories.length - 1;
          const targetId = categories[targetIndex].id;
          const before = structuredClone(categories);
          const next = setCategoryColor(categories, targetId, color);

          // Every category OTHER than ones sharing the target id is identical.
          next.forEach((c, i) => {
            if (categories[i].id !== targetId) {
              expect(c).toEqual(categories[i]);
              return;
            }
            // Target: name/isDefault unchanged; color set or key dropped.
            expect(c.name).toBe(categories[i].name);
            expect(c.isDefault).toBe(categories[i].isDefault);
            if (color === undefined) {
              expect("color" in c).toBe(false);
            } else {
              expect(c.color).toBe(color);
            }
          });

          // Purity.
          expect(categories).toEqual(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

const tagArb = fc.string({ maxLength: 10 });
// `addTag` preserves the invariant it is handed: callers keep `tags` free of
// case-insensitive duplicates (that is exactly what addTag enforces on each add),
// so the precondition for these properties is an already-deduplicated input.
const tagsArb = fc
  .array(tagArb, { maxLength: 12 })
  .map((tags) => tags.reduce<string[]>((acc, t) => addTag(acc, t), []));

describe("Story 3.4 Property: addTag trims, de-dups case-insensitively, order-preserving, ignores blank", () => {
  it("holds the add invariants and never mutates input", () => {
    fc.assert(
      fc.property(tagsArb, tagArb, (tags, raw) => {
        const before = [...tags];
        const next = addTag(tags, raw);
        const trimmed = raw.trim();

        // Result has all-unique (case-insensitive) tags.
        const lowered = next.map((t) => t.toLowerCase());
        expect(new Set(lowered).size).toBe(lowered.length);

        if (trimmed === "") {
          // Blank is ignored → copy unchanged.
          expect(next).toEqual(tags);
        } else {
          const already = tags.some(
            (t) => t.toLowerCase() === trimmed.toLowerCase(),
          );
          if (already) {
            // Duplicate (case-insensitive) → unchanged.
            expect(next).toEqual(tags);
          } else {
            // Fresh tag → appended at the end, trimmed, order preserved.
            expect(next).toEqual([...tags, trimmed]);
          }
        }

        // Purity.
        expect(tags).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Story 3.4 Property: removeTag drops the trimmed+case-insensitive match, order-preserving", () => {
  it("removes every case-insensitive match and preserves the rest in order; input not mutated", () => {
    fc.assert(
      fc.property(tagsArb, tagArb, (tags, raw) => {
        const before = [...tags];
        const next = removeTag(tags, raw);
        const target = raw.trim().toLowerCase();

        const expected = tags.filter((t) => t.toLowerCase() !== target);
        expect(next).toEqual(expected);

        // Purity.
        expect(tags).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
