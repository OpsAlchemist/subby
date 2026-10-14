/**
 * Category model (Req 7.1).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 */

export interface Category {
  id: string;
  name: string;
  isDefault: boolean;
  /** Optional category color as `#rrggbb` (lowercase/uppercase hex both valid). */
  color?: string;
}

/**
 * Root file shape for `categories.json` (Req 1.2).
 *
 * `colorsSeeded` is the one-time seed marker (Story 3.4): the default-category
 * color backfill runs — and writes back — exactly once, at the barrier-serialized
 * first read after upgrade, then stamps this `true`. Every later read returns the
 * stored categories verbatim with no write, so a user-CLEARED default color stays
 * cleared and the seed never resurrects it. Optional/additive: an older file
 * without the key is treated as not-yet-seeded.
 */
export interface CategoriesFile {
  version: number;
  categories: Category[];
  colorsSeeded?: boolean;
}
