/**
 * Typed renderer wrapper over `window.subby` (task 17.1, Req 2.4, 8.6, 19.4).
 *
 * The preload exposes a single typed facade at `window.subby` ({@link SubbyApi})
 * whose every data method resolves to a discriminated {@link IpcResult}. This
 * module is the renderer's ergonomic front door to that facade:
 *
 *   - It UNWRAPS `IpcResult<T>`: on `ok` it returns `data`; on failure it throws
 *     a typed {@link SubbyError} carrying the {@link AppError}, so callers can
 *     use plain `await`/`try-catch` (or let a store capture the error).
 *   - It RE-EXPORTS the `onDataChanged` / `onError` subscriptions so the stores
 *     and UI never reach for `window.subby` directly.
 *   - It is TESTABLE outside Electron: the facade is read through {@link getSubby},
 *     which prefers an injected fake (see {@link setSubby}) and otherwise falls
 *     back to `globalThis.subby`. In a non-Electron / test context with no fake
 *     installed, calling an API throws a clear error instead of dereferencing
 *     `undefined`.
 */

import type { SubbyApi, Unsubscribe } from "shared/subbyApi";
import type { AppError, IpcResult } from "shared/types";

// --- Facade access / injection ----------------------------------------------

/**
 * An optional fake facade installed for tests (task 17.2) or non-Electron
 * contexts. When set it takes precedence over `globalThis.subby`.
 */
let injected: SubbyApi | null = null;

/**
 * Inject a fake {@link SubbyApi} (tests) or clear it by passing `null`.
 *
 * This is the seam task 17.2 uses to exercise store reactivity without
 * Electron: install a fake whose `onDataChanged`/`onError` callbacks can be
 * triggered manually, then assert the stores reload / surface errors.
 */
export function setSubby(api: SubbyApi | null): void {
  injected = api;
}

/**
 * Resolve the active {@link SubbyApi} facade.
 *
 * Order of precedence: an injected fake (tests) → `globalThis.subby` (the real
 * preload bridge in Electron). Throws a clear error when neither is available
 * so a missing bridge fails loudly instead of as `undefined is not a function`.
 */
export function getSubby(): SubbyApi {
  if (injected) return injected;
  const candidate = (globalThis as { subby?: SubbyApi }).subby;
  if (candidate) return candidate;
  throw new Error(
    "window.subby is unavailable: the preload bridge is not loaded. " +
      "In tests, install a fake with setSubby(...).",
  );
}

// --- Error unwrapping --------------------------------------------------------

/**
 * A thrown {@link AppError}. The wrapper converts an `IpcResult` failure into
 * this typed error so callers get a normal exception while retaining the full,
 * structured {@link AppError} (code, field, file, restore hint) on `.appError`.
 */
export class SubbyError extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(appError.message);
    this.name = "SubbyError";
    this.appError = appError;
  }
}

/** Type guard: was a caught value a {@link SubbyError}? */
export function isSubbyError(err: unknown): err is SubbyError {
  return err instanceof SubbyError;
}

/**
 * Normalize an unknown thrown value into an {@link AppError}. A {@link SubbyError}
 * yields its structured error; anything else becomes an `unknown`-coded error
 * with a best-effort message. Used by the stores to surface failures uniformly.
 */
export function toAppError(err: unknown): AppError {
  if (isSubbyError(err)) return err.appError;
  return {
    code: "unknown",
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Await an `IpcResult` call: return `data` on success, throw {@link SubbyError} on failure. */
async function unwrap<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const result = await call;
  if (result.ok) return result.data;
  throw new SubbyError(result.error);
}

// --- Ergonomic, unwrapped API groups -----------------------------------------
//
// Each function reads the facade lazily via getSubby() so an injected fake is
// honored at call time (not module-load time).

/** Subscription operations (Req 3). */
export const subscriptionsApi = {
  list: () => unwrap(getSubby().listSubscriptions()),
  create: (input: Parameters<SubbyApi["createSubscription"]>[0]) =>
    unwrap(getSubby().createSubscription(input)),
  update: (
    id: string,
    patch: Parameters<SubbyApi["updateSubscription"]>[1],
  ) => unwrap(getSubby().updateSubscription(id, patch)),
  remove: (id: string) => unwrap(getSubby().deleteSubscription(id)),
  setState: (id: string, state: Parameters<SubbyApi["setState"]>[1]) =>
    unwrap(getSubby().setState(id, state)),
} as const;

/** Category operations (Req 7). */
export const categoriesApi = {
  list: () => unwrap(getSubby().listCategories()),
  create: (name: string) => unwrap(getSubby().createCategory(name)),
  update: (id: string, patch: { color: string | undefined }) =>
    unwrap(getSubby().updateCategory(id, patch)),
  remove: (id: string, opts?: { confirmed: boolean }) =>
    unwrap(getSubby().deleteCategory(id, opts)),
} as const;

/** Settings operations (Req 15). */
export const settingsApi = {
  get: () => unwrap(getSubby().getSettings()),
  update: (patch: Parameters<SubbyApi["updateSettings"]>[0]) =>
    unwrap(getSubby().updateSettings(patch)),
  chooseDataFolder: () => unwrap(getSubby().chooseDataFolder()),
} as const;

/**
 * Suggested-price operations (FR-13, Story 5.4). READ-ONLY: `suggest` returns
 * the matching seed entry + `asOf` (or `null` on no match / absent seed). The
 * caller treats ANY failure as "no suggestion" — a suggestion is never
 * load-bearing — so prefer {@link suggestPriceSafe} in UI hot paths.
 */
export const priceApi = {
  suggest: (name: string) => unwrap(getSubby().getPriceSuggestion(name)),
} as const;

/**
 * Suggestion lookup that NEVER throws: resolves to the suggestion (or `null`)
 * and swallows any bridge/IPC failure as `null`. This is the ergonomic front
 * door the Add modal uses — a failed lookup must silently become "no
 * suggestion", never surface an error or block typing.
 */
export async function suggestPriceSafe(
  name: string,
): Promise<Awaited<ReturnType<typeof priceApi.suggest>> | null> {
  try {
    return await priceApi.suggest(name);
  } catch {
    return null;
  }
}

/**
 * FX-snapshot operations (Story 6.1). READ-ONLY: `snapshot` returns the bundled
 * {@link RateSnapshot} rebased to the queried Home Currency, or THROWS a
 * {@link SubbyError} when the bundle is missing/corrupt / the Home Currency is
 * unknown (the IPC `not_found` outcome). The Dashboard uses the never-throws
 * {@link getFxSnapshotSafe} so an unavailable snapshot degrades to a clear
 * "rates unavailable" state rather than a wrong confident number.
 */
export const fxApi = {
  snapshot: (home: string) => unwrap(getSubby().getFxSnapshot(home)),
} as const;

/**
 * Snapshot fetch that NEVER throws: resolves to the rebased {@link RateSnapshot}
 * or `null`, swallowing any bridge/IPC failure (a missing/corrupt bundle, an
 * unknown Home Currency, or an absent preload) as `null`. The Dashboard treats
 * `null` as "rates unavailable" — it must NEVER crash or show a wrong total.
 */
export async function getFxSnapshotSafe(
  home: string,
): Promise<Awaited<ReturnType<typeof fxApi.snapshot>> | null> {
  try {
    return await fxApi.snapshot(home);
  } catch {
    return null;
  }
}

/** Import / export / backup operations (Req 16, 17, 18). */
export const dataApi = {
  importData: (req: Parameters<SubbyApi["importData"]>[0]) =>
    unwrap(getSubby().importData(req)),
  exportData: (req: Parameters<SubbyApi["exportData"]>[0]) =>
    unwrap(getSubby().exportData(req)),
  listBackups: () => unwrap(getSubby().listBackups()),
  restoreBackup: (name: string) => unwrap(getSubby().restoreBackup(name)),
} as const;

// --- Event subscriptions (re-exported) ---------------------------------------

/**
 * Subscribe to the post-mutation "data changed" broadcast (Req 8.6). Returns an
 * {@link Unsubscribe}. Used by {@link initStores} to invalidate/reload stores.
 */
export function onDataChanged(cb: () => void): Unsubscribe {
  return getSubby().onDataChanged(cb);
}

/**
 * Subscribe to system-level errors for a global toast/banner (Req 19.4).
 * Returns an {@link Unsubscribe}.
 */
export function onError(cb: (error: AppError) => void): Unsubscribe {
  return getSubby().onError(cb);
}
