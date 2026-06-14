/**
 * Global error store (task 17.1, Req 19.4).
 *
 * Captures the latest {@link AppError} broadcast by the main process on
 * `evt:error` (via `api.onError`) so the UI can show a global toast/banner.
 * Framework-light: `subscribe` + `getSnapshot` for `useSyncExternalStore`, with
 * a stable snapshot reference until the error changes.
 *
 * This complements the per-store `error` field (which reflects a failed
 * `load()`); `errorStore` is for system-level failures pushed from main that
 * aren't tied to a specific store fetch.
 */

import type { AppError } from "shared/types";

/** Immutable snapshot of the global error state. */
export interface ErrorState {
  /** The most recent system error, or `null` when none / cleared. */
  latest: AppError | null;
}

export interface ErrorStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ErrorState;
  /** Record a new system error (called from the `onError` subscription). */
  set(error: AppError): void;
  /** Clear the current error (e.g. after the user dismisses the toast). */
  clear(): void;
}

function createErrorStore(): ErrorStore {
  let state: ErrorState = { latest: null };
  const listeners = new Set<() => void>();

  function setState(next: ErrorState): void {
    state = next;
    for (const listener of listeners) listener();
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
    set(error) {
      setState({ latest: error });
    },
    clear() {
      if (state.latest !== null) setState({ latest: null });
    },
  };
}

/** The singleton global error store. */
export const errorStore: ErrorStore = createErrorStore();
