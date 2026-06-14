/**
 * Categories store (task 17.1, Req 8.6).
 *
 * Holds the current category list, reloaded via `categoriesApi.list()`.
 * Reloaded automatically on `onDataChanged` by {@link initStores}.
 */

import type { Category } from "core/models/category";
import { categoriesApi } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton categories store. Initial data is an empty list. */
export const categoriesStore: Store<Category[]> = createStore<Category[]>(
  [],
  () => categoriesApi.list(),
);
