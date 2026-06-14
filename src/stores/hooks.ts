/**
 * React bindings for the framework-light stores (task 17.1).
 *
 * Thin `useSyncExternalStore` adapters. The stores themselves stay React-free
 * (and thus testable without a DOM); these hooks are the only React-coupled
 * piece. Because each store returns a stable snapshot reference until its state
 * changes, these hooks are safe from infinite re-render loops.
 */

import { useSyncExternalStore } from "react";
import type { Store, StoreState } from "./createStore";
import { errorStore, type ErrorState } from "./errorStore";

/** Subscribe a component to a store's full snapshot. */
export function useStore<T>(store: Store<T>): StoreState<T> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Convenience: subscribe to just a store's `data`. */
export function useStoreData<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().data);
}

/** Subscribe a component to the global error store (Req 19.4). */
export function useErrorState(): ErrorState {
  return useSyncExternalStore(errorStore.subscribe, errorStore.getSnapshot);
}
