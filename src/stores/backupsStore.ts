/**
 * Backups store (Story 7.4).
 *
 * Holds the current backup history as a newest-first `string[]` of file names,
 * reloaded via `dataApi.listBackups()` (the storage adapter already sorts
 * newest-first). Mirrors {@link categoriesStore}: it is registered in
 * {@link reloadAll} so a `evt:dataChanged` broadcast — fired by BOTH a restore
 * AND the Story 7.3 "Back up now" action — refreshes the history automatically,
 * exactly like every other data view.
 */

import { dataApi } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton backups store. Initial data is an empty list. */
export const backupsStore: Store<string[]> = createStore<string[]>(
  [],
  () => dataApi.listBackups(),
);
