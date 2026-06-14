/**
 * Framework-light store factory (task 17.1, Req 8.6, 19.4).
 *
 * Each store holds an immutable {@link StoreState} snapshot, exposes
 * `subscribe(listener)` + `getSnapshot()` (the exact shape React's
 * `useSyncExternalStore` wants), and a `load()` that fetches via the
 * `src/api/subby.ts` wrapper. Stores are PLAIN TypeScript — no React import —
 * so they are trivially unit-testable without a DOM (task 17.2) while still
 * being usable from components.
 *
 * Snapshot identity contract: `getSnapshot()` returns the SAME object reference
 * until the state actually changes. This is required by `useSyncExternalStore`
 * to avoid infinite re-render loops, and it lets tests assert reload by
 * reference inequality.
 */

import type { AppError } from "shared/types";
import { toAppError } from "@/api/subby";

/** Immutable snapshot held by a {@link Store}. */
export interface StoreState<T> {
  /** Latest successfully-loaded data (or the initial value before first load). */
  data: T;
  /** True while a `load()` is in flight. */
  loading: boolean;
  /** The error from the most recent failed `load()`, or `null` when healthy. */
  error: AppError | null;
  /** True once a `load()` has completed successfully at least once. */
  loaded: boolean;
}

/** A minimal external store compatible with `useSyncExternalStore`. */
export interface Store<T> {
  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Current immutable snapshot (stable reference until state changes). */
  getSnapshot(): StoreState<T>;
  /** Fetch fresh data via the api wrapper, updating `loading`/`data`/`error`. */
  load(): Promise<void>;
  /** Reset to the initial state (clears data/error/loaded). */
  reset(): void;
}

/**
 * Build a store around an async `fetcher` (typically an `src/api/subby.ts`
 * function). The fetcher is expected to resolve with data or throw
 * (`SubbyError` for IPC failures); thrown values are normalized to
 * {@link AppError} via `toAppError` and stored in `state.error` so the UI can
 * read them (Req 19.4) without crashing.
 *
 * Concurrent/overlapping `load()` calls are coalesced: only the most recent
 * call is allowed to write results, so an earlier slow response can't clobber a
 * newer one.
 */
export function createStore<T>(
  initialData: T,
  fetcher: () => Promise<T>,
): Store<T> {
  let state: StoreState<T> = {
    data: initialData,
    loading: false,
    error: null,
    loaded: false,
  };

  const listeners = new Set<() => void>();
  let loadToken = 0;

  function emit(): void {
    for (const listener of listeners) listener();
  }

  /** Replace the snapshot with a new reference and notify listeners. */
  function setState(patch: Partial<StoreState<T>>): void {
    state = { ...state, ...patch };
    emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return state;
    },

    async load() {
      const token = ++loadToken;
      setState({ loading: true, error: null });
      try {
        const data = await fetcher();
        if (token !== loadToken) return; // a newer load superseded this one
        setState({ data, loading: false, error: null, loaded: true });
      } catch (err) {
        if (token !== loadToken) return;
        setState({ loading: false, error: toAppError(err) });
      }
    },

    reset() {
      loadToken++; // invalidate any in-flight load
      setState({
        data: initialData,
        loading: false,
        error: null,
        loaded: false,
      });
    },
  };
}
