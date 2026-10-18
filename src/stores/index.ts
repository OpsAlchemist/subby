/**
 * Client store wiring (task 17.1, Req 8.6, 19.4).
 *
 * Re-exports the individual stores and provides {@link initStores}, which:
 *   1. subscribes to `onDataChanged` and reloads every store so all views
 *      reflect current data after any mutation (Req 8.6), and
 *   2. subscribes to `onError` and records the latest {@link AppError} into
 *      {@link errorStore} for a global toast (Req 19.4),
 *   3. kicks off an initial load of every store.
 *
 * `initStores` returns a teardown function that detaches both subscriptions —
 * useful for tests (task 17.2) and on app shutdown. It is safe to call in a
 * non-Electron context: if `window.subby` is unavailable it records the error
 * and returns a no-op teardown rather than throwing.
 */

import { onDataChanged, onError, toAppError } from "@/api/subby";
import { subscriptionsStore } from "./subscriptionsStore";
import { categoriesStore } from "./categoriesStore";
import { settingsStore } from "./settingsStore";
import { backupsStore } from "./backupsStore";
import { logoPackStore } from "./logoPackStore";
import { errorStore } from "./errorStore";

export { subscriptionsStore } from "./subscriptionsStore";
export { categoriesStore } from "./categoriesStore";
export { settingsStore } from "./settingsStore";
export { backupsStore } from "./backupsStore";
export { logoPackStore } from "./logoPackStore";
export { errorStore } from "./errorStore";
export type { Store, StoreState } from "./createStore";
export { createStore } from "./createStore";

/**
 * All data-backed stores reloaded together on a `onDataChanged` broadcast. The
 * `backupsStore` (Story 7.4) is included so the backup history refreshes
 * automatically after a restore AND after the Story 7.3 "Back up now" action
 * (both broadcast `evt:dataChanged`).
 */
const allStores = [
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  backupsStore,
] as const;

/** Reload every data store. Errors are captured per-store (never thrown). */
export function reloadAll(): Promise<void[]> {
  return Promise.all(allStores.map((store) => store.load()));
}

/**
 * Wire the stores to the live IPC event stream and load initial data.
 *
 * @returns a teardown function detaching the `onDataChanged` / `onError`
 * subscriptions. Idempotent to tear down (calling the returned function twice
 * is harmless).
 */
export function initStores(): () => void {
  try {
    const offData = onDataChanged(() => {
      void reloadAll();
    });
    const offError = onError((error) => {
      errorStore.set(error);
    });

    // Initial population so views render current data on startup.
    void reloadAll();

    // Hydrate the Logo Pack ONCE at launch (Story 8.3). It is immutable shipped
    // data, so it is NOT in `allStores` (nothing to reload on a mutation) — a
    // single load is enough for every row to resolve its tile synchronously.
    void logoPackStore.load();

    let torndown = false;
    return () => {
      if (torndown) return;
      torndown = true;
      offData();
      offError();
    };
  } catch (err) {
    // No bridge available (e.g. opened outside Electron): surface, don't crash.
    errorStore.set(toAppError(err));
    return () => {};
  }
}
