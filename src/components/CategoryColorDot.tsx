/**
 * CategoryColorDot — a small decorative dot carrying a category's color
 * (Story 3.4, FR-3).
 *
 * Rendered before a category NAME in the List and the Dashboard sub-lists. The
 * color is looked up from {@link categoriesStore} by the subscription's category
 * NAME. It is purely DECORATIVE and `aria-hidden`: the category NAME beside it is
 * the real text label, so color is never the sole carrier of meaning (DESIGN
 * state/color rule). A category with no color — or a category name not present in
 * the store (e.g. "Uncategorized") — renders NOTHING, so the name shows with no
 * dot. The caller is responsible for rendering the name itself.
 */

import { categoriesStore } from "@/stores/categoriesStore";
import { useStoreData } from "@/stores/hooks";

export interface CategoryColorDotProps {
  /** The subscription's category NAME (as stored on the subscription). */
  categoryName: string;
}

/** A decorative, aria-hidden dot keyed by the category's color (or nothing). */
export default function CategoryColorDot({
  categoryName,
}: CategoryColorDotProps): JSX.Element | null {
  const categories = useStoreData(categoriesStore);
  const color = categories.find((c) => c.name === categoryName)?.color;
  if (!color) return null;
  return (
    <span
      aria-hidden="true"
      className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
      style={{ backgroundColor: color }}
    />
  );
}
