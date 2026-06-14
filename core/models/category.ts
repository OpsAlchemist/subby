/**
 * Category model (Req 7.1).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 */

export interface Category {
  id: string;
  name: string;
  isDefault: boolean;
  color?: string;
}

/** Root file shape for `categories.json` (Req 1.2). */
export interface CategoriesFile {
  version: number;
  categories: Category[];
}
