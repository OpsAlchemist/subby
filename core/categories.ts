/**
 * Pure category management and settings-merge helpers
 * (Req 7.2, 7.3, 7.4, 15.2).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 * `crypto.randomUUID` is a runtime global (Node 19+, modern browsers) and is
 * acceptable here; it keeps `core/` dependency-light (no `uuid` package).
 *
 * Every function in this module is PURE:
 *   - it never mutates its inputs in place (arrays/objects are copied), and
 *   - it never reads the wall clock.
 */

import type { Category } from "./models/category";
import { DEFAULT_CATEGORY_COLORS } from "./models/schema";

/**
 * The only subscription field these category helpers read: the assigned
 * category name. Structural so both v1 `Subscription` and v2 `SubscriptionV2`
 * satisfy it (the field is identical across versions).
 */
interface CategorizedSubscription {
  category: string;
}

/**
 * The only settings shape {@link mergeSettings} depends on: a `notification`
 * block it deep-merges (its other top-level fields are shallow-merged untyped).
 * Structural so it serves both v1 `Settings` and v2 `SettingsV2` unchanged.
 */
interface MergeableSettings {
  notification: {
    enabled: boolean;
    leadTimes: string[];
  };
}

/**
 * Generate a unique identifier for a new category (uuid v4).
 *
 * Uses the `crypto.randomUUID` global so `core/` stays free of a `uuid`
 * dependency and free of platform imports.
 */
function newId(): string {
  return crypto.randomUUID();
}

/** Normalize a category name for case-insensitive duplicate comparison. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// --- Category create (Req 7.2, 7.3) ------------------------------------------

/**
 * Discriminated result of {@link createCategory}.
 *
 * Return contract: instead of throwing, `createCategory` returns this
 * discriminated union so callers (e.g. the IPC layer, which already speaks in
 * `IpcResult`) can branch without try/catch and surface the offending name
 * directly (Req 7.3).
 *
 * - `{ ok: true, ... }`  — the name was unique; `categories` is the new list
 *   (the input is never mutated) and `created` is the appended Category.
 * - `{ ok: false, ... }` — a category with the same name already exists
 *   (case-insensitive, trimmed); `name` echoes the existing name that
 *   collided so the UI can name the duplicate (Req 7.3).
 */
export type CreateCategoryResult =
  | { ok: true; categories: Category[]; created: Category }
  | { ok: false; reason: "duplicate"; name: string };

/**
 * Create a custom category with the given `name`, returning a new list with the
 * category appended (Req 7.2).
 *
 * Names are compared case-insensitively and with surrounding whitespace
 * trimmed; if an existing category already uses the name, the creation is
 * rejected (Req 7.3) and no new list is produced. On success the new Category
 * receives a unique id, `isDefault: false`, and the trimmed display name.
 */
export function createCategory(
  existing: Category[],
  name: string,
): CreateCategoryResult {
  const trimmed = name.trim();
  const target = normalizeName(trimmed);

  const collision = existing.find((c) => normalizeName(c.name) === target);
  if (collision !== undefined) {
    // Reject duplicate; echo the EXISTING name so the UI can identify it (Req 7.3).
    return { ok: false, reason: "duplicate", name: collision.name };
  }

  const created: Category = {
    id: newId(),
    name: trimmed,
    isDefault: false,
  };
  return { ok: true, categories: [...existing, created], created };
}

// --- Category delete-detection and delete (Req 7.4) --------------------------

/**
 * Count how many subscriptions are assigned to the category named
 * `categoryName` (Req 7.4). Comparison is exact on the stored category name,
 * matching how subscriptions reference categories by name.
 *
 * Used by the deletion flow to decide whether the user must be prompted before
 * deleting a category that is still in use.
 */
export function categoryAssignmentCount(
  subs: CategorizedSubscription[],
  categoryName: string,
): number {
  return subs.reduce(
    (count, s) => (s.category === categoryName ? count + 1 : count),
    0,
  );
}

/**
 * Convenience predicate: `true` when at least one subscription is assigned to
 * the category named `categoryName` (Req 7.4). Callers prompt the user before
 * completing the deletion when this returns `true`.
 */
export function isCategoryInUse(
  subs: CategorizedSubscription[],
  categoryName: string,
): boolean {
  return categoryAssignmentCount(subs, categoryName) > 0;
}

/**
 * Remove exactly the category with the matching `id`, returning a new array.
 * Other categories are preserved in their original order; the input is never
 * mutated. Deciding whether to prompt before deletion (Req 7.4) is the
 * caller's responsibility via {@link isCategoryInUse} /
 * {@link categoryAssignmentCount}.
 */
export function deleteCategory(existing: Category[], id: string): Category[] {
  return existing.filter((c) => c.id !== id);
}

// --- Category color: one-time seed + user-owned mutation (Story 3.4, FR-3) ---

/**
 * The ONE-TIME default-color seeding transform (Story 3.4). Returns a NEW array
 * in which every default-named category that is **missing** a `color` is stamped
 * with its {@link DEFAULT_CATEGORY_COLORS} hue. A category that already has a
 * color is left untouched, and a CUSTOM (non-default-named) category is never
 * assigned a color. The input is never mutated and order is preserved.
 *
 * **NOT idempotent-safe to run on every read.** This transform cannot distinguish
 * a default whose color the user deliberately CLEARED (color removed) from one
 * that was never set — both present as "missing color on a default name" — so
 * re-running it would silently resurrect a cleared color (review finding A). The
 * caller MUST run it exactly once, gated by the sticky `colorsSeeded` marker on
 * the categories file; after that one seed, `color` is purely user-owned.
 *
 * Keying on the category NAME (not `isDefault`) is deliberate and additive: it
 * backfills the stable default palette by the same name the defaults ship with,
 * and a user-renamed-or-custom category simply has no palette entry.
 */
export function assignDefaultColors(categories: Category[]): Category[] {
  return categories.map((c) => {
    if (c.color !== undefined) return { ...c };
    const seeded = DEFAULT_CATEGORY_COLORS[c.name];
    if (seeded === undefined) return { ...c };
    return { ...c, color: seeded };
  });
}

/**
 * Set (or CLEAR) the `color` of exactly the category with the matching `id`,
 * returning a NEW array (Story 3.4). This is the only mutable field — rename is
 * explicitly out of scope. Passing a hex string sets it; passing `undefined`
 * CLEARS the color by DROPPING the `color` key entirely (not storing an empty
 * string), so a cleared default renders colorless and — because the one-time seed
 * is marker-gated — stays cleared across reloads. Other categories and the input
 * array are left untouched; an unknown `id` yields a new array with identical
 * contents.
 *
 * Color-format validation lives at the schema + `cat:update` service boundary
 * ({@link hexColor}); this pure helper assumes a validated value so `core/` stays
 * free of a chosen color grammar it doesn't own.
 */
export function setCategoryColor(
  existing: Category[],
  id: string,
  color: string | undefined,
): Category[] {
  return existing.map((c) => {
    if (c.id !== id) return c;
    if (color === undefined) {
      // Clear: drop the key so the category is genuinely colorless.
      const { color: _dropped, ...rest } = c;
      return rest;
    }
    return { ...c, color };
  });
}

// --- Tags: trimmed, case-insensitive de-dup, order-preserving (Story 3.4) ----

/**
 * Add `raw` to a subscription's `tags`, returning a NEW array (Story 3.4, FR-3).
 * The tag is trimmed; a blank/whitespace-only tag is IGNORED (returns a copy
 * unchanged). De-duplication is case-insensitive and the FIRST-seen casing wins —
 * an incoming tag that matches an existing one case-insensitively is dropped (the
 * existing entry and its order are kept). Appends in order otherwise. The input
 * array is never mutated.
 */
export function addTag(tags: string[], raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [...tags];
  const exists = tags.some((t) => t.toLowerCase() === trimmed.toLowerCase());
  return exists ? [...tags] : [...tags, trimmed];
}

/**
 * Remove `raw` from a subscription's `tags`, returning a NEW array (Story 3.4).
 * Matching is trimmed + case-insensitive, so removing `" work "` drops a stored
 * `"Work"`. Non-matching tags are preserved in order; the input is never mutated.
 */
export function removeTag(tags: string[], raw: string): string[] {
  const target = raw.trim().toLowerCase();
  return tags.filter((t) => t.toLowerCase() !== target);
}

// --- Settings merge (Req 15.2) -----------------------------------------------

/**
 * Apply `patch` to `current`, returning a NEW settings object (the input is
 * never mutated) (Req 15.2).
 *
 * Generic over the settings shape `T` (v1 `Settings` or v2 `SettingsV2`): it
 * reads only the shared `notification` block, so the same merge serves both and
 * returns the caller's own type. Top-level fields are shallow-merged; the nested
 * `notification` object is deep-merged so a patch may update `enabled` and
 * `leadTimes` independently without dropping the unspecified field. The
 * `leadTimes` array is copied so the result never shares a mutable reference
 * with the patch or `current`.
 */
export function mergeSettings<T extends MergeableSettings>(
  current: T,
  patch: Partial<T>,
): T {
  const merged: T = { ...current, ...patch };

  if (patch.notification !== undefined) {
    const notification = { ...current.notification, ...patch.notification };
    // Defensive copy: never share the leadTimes array reference.
    merged.notification = {
      ...notification,
      leadTimes: [...notification.leadTimes],
    };
  } else {
    // Preserve a fresh notification object even when not patched.
    merged.notification = {
      ...current.notification,
      leadTimes: [...current.notification.leadTimes],
    };
  }

  return merged;
}
