/**
 * Settings store (task 17.1, Req 8.6).
 *
 * Holds the current {@link Settings}, reloaded via `settingsApi.get()`. Seeded
 * with `DEFAULT_SETTINGS` so the UI has sane values before the first load
 * resolves. Reloaded automatically on `onDataChanged` by {@link initStores}.
 */

import type { Settings } from "core/models/settings";
import { DEFAULT_SETTINGS } from "core/models/schema";
import { settingsApi } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton settings store, seeded with the dark-first defaults. */
export const settingsStore: Store<Settings> = createStore<Settings>(
  DEFAULT_SETTINGS,
  () => settingsApi.get(),
);
