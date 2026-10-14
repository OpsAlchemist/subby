/**
 * Settings store (task 17.1, Req 8.6).
 *
 * Holds the current {@link SettingsV2}, reloaded via `settingsApi.get()`. Seeded
 * with `DEFAULT_SETTINGS_V2` so the UI has sane values before the first load
 * resolves. Reloaded automatically on `onDataChanged` by {@link initStores}.
 */

import type { SettingsV2 } from "core/models/settings";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import { settingsApi } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton settings store (v2), seeded with the dark-first defaults. */
export const settingsStore: Store<SettingsV2> = createStore<SettingsV2>(
  DEFAULT_SETTINGS_V2,
  () => settingsApi.get(),
);
