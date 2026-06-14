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
import type { Subscription } from "./models/subscription";
import type { Settings } from "./models/settings";

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
  subs: Subscription[],
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
  subs: Subscription[],
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

// --- Settings merge (Req 15.2) -----------------------------------------------

/**
 * Apply `patch` to `current`, returning a NEW Settings object (the input is
 * never mutated) (Req 15.2).
 *
 * Top-level fields are shallow-merged. The nested `notification` object is
 * deep-merged so a patch may update `enabled` and `leadTimes` independently
 * without dropping the unspecified field. The `leadTimes` array is copied so
 * the result never shares a mutable reference with the patch or `current`.
 */
export function mergeSettings(
  current: Settings,
  patch: Partial<Settings>,
): Settings {
  const merged: Settings = { ...current, ...patch };

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
