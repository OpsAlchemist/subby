/**
 * The typed `window.subby` API surface (Req 2.4, 2.5).
 *
 * This is the ONLY contract the renderer knows about. It is platform-
 * independent (references only `core/models` + `shared` types) so it can be
 * imported by BOTH the preload (which implements it via `contextBridge`) and
 * the renderer (which consumes it as `window.subby`). The renderer NEVER sees
 * raw IPC channel strings — only this facade.
 *
 * Every data operation returns the discriminated {@link IpcResult} so the
 * renderer renders validation/errors without exceptions crossing the bridge.
 * The two `on*` subscriptions return an unsubscribe function the caller invokes
 * to detach the listener (e.g. on component unmount).
 */

import type { Category } from "core/models/category";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionState, SubscriptionV2 } from "core/models/subscription";
import type { SubscriptionPatchV2 } from "core/subscriptionsV2";
import type { PriceSuggestion } from "core/priceSeed";
import type { RateSnapshot } from "core/money";
import type { LogoPack } from "core/logo";
import type { ImportOutcome } from "core/import";
import type {
  AppError,
  ExportRequest,
  ImportRequest,
  IpcResult,
  SubscriptionInput,
} from "shared/types";

/** Success data returned by {@link SubbyApi.createCategory}. */
export interface CreateCategoryData {
  categories: Category[];
  created: Category;
}

/**
 * Result data returned by {@link SubbyApi.deleteCategory}.
 *
 * Deleting an in-use category is not an error but a confirmation flow (Req 7.4):
 * `needsConfirmation: true` asks the renderer to prompt the user and re-invoke
 * with `{ confirmed: true }`.
 */
export type DeleteCategoryData =
  | { needsConfirmation: false; categories: Category[] }
  | { needsConfirmation: true; name: string; inUseCount: number };

/** Success data returned by {@link SubbyApi.exportData}. */
export interface ExportResult {
  path: string;
  bytes: number;
}

/** Detaches an event listener registered via {@link SubbyApi.onDataChanged} / {@link SubbyApi.onError}. */
export type Unsubscribe = () => void;

/**
 * The full typed facade exposed at `window.subby` by the preload.
 * Each method forwards to a single IPC channel; no channel strings leak here.
 */
export interface SubbyApi {
  // --- Subscriptions (Req 3) ---
  listSubscriptions(): Promise<IpcResult<SubscriptionV2[]>>;
  createSubscription(input: SubscriptionInput): Promise<IpcResult<SubscriptionV2[]>>;
  updateSubscription(
    id: string,
    patch: SubscriptionPatchV2,
  ): Promise<IpcResult<SubscriptionV2[]>>;
  deleteSubscription(id: string): Promise<IpcResult<SubscriptionV2[]>>;
  setState(
    id: string,
    state: SubscriptionState,
  ): Promise<IpcResult<SubscriptionV2[]>>;

  // --- Categories (Req 7) ---
  listCategories(): Promise<IpcResult<Category[]>>;
  createCategory(name: string): Promise<IpcResult<CreateCategoryData>>;
  /**
   * Set (or clear) a category's color (Story 3.4, FR-3). `color` is a `#rrggbb`
   * hex to set, or `undefined` to clear. Resolves with the new `Category[]`;
   * an unknown id fails with an inline `not_found` error and a non-hex color
   * with an inline `validation` error (never a global toast).
   */
  updateCategory(
    id: string,
    patch: { color: string | undefined },
  ): Promise<IpcResult<Category[]>>;
  deleteCategory(
    id: string,
    opts?: { confirmed: boolean },
  ): Promise<IpcResult<DeleteCategoryData>>;

  // --- Settings (Req 15) ---
  getSettings(): Promise<IpcResult<SettingsV2>>;
  updateSettings(patch: Partial<SettingsV2>): Promise<IpcResult<SettingsV2>>;
  /** Opens the native folder picker; `data` is `null` when the dialog is dismissed (Req 15.3). */
  chooseDataFolder(): Promise<IpcResult<SettingsV2 | null>>;

  // --- Suggested price (FR-13, Story 5.4) ---
  /**
   * Look up a bundled suggested price for a service name (CREATE-mode Add
   * convenience). Resolves with the matching seed entry's figures plus the
   * seed's `asOf` (so the renderer applies the staleness guard with its own
   * local today), or `null` on no match / an absent-or-corrupt seed. READ-ONLY:
   * no mutation, no `evt:dataChanged`; any failure is treated as "no suggestion".
   */
  getPriceSuggestion(name: string): Promise<IpcResult<PriceSuggestion | null>>;

  // --- FX snapshot (Story 6.1) ---
  /**
   * Fetch the bundled FX {@link RateSnapshot} rebased to `homeCurrency`
   * (`rates[home] === "1"`, every other currency in Home major units) plus the
   * snapshot's `asOf` date (so the renderer applies the stale-rate guard with
   * its own local `today`). READ-ONLY: no mutation, no `evt:dataChanged`. A
   * missing/corrupt bundle (or an unknown/absent Home Currency) resolves to a
   * `not_found` error outcome the renderer treats as "rates unavailable" — never
   * a wrong confident total.
   */
  getFxSnapshot(homeCurrency: string): Promise<IpcResult<RateSnapshot>>;

  // --- Logo Pack (Story 8.3) ---
  /**
   * Fetch the bundled {@link LogoPack} ONCE at launch (FR-26, AD-25). READ-ONLY:
   * no mutation, no `evt:dataChanged`, and NO network — the pack is immutable
   * shipped data delivered through the resource reader → IPC → store triad. A
   * missing/corrupt bundle resolves to an EMPTY pack (valid data, not an error),
   * so the renderer shows the deterministic lettered fallback for every row. The
   * renderer hydrates this into `logoPackStore` so rows resolve synchronously
   * with no per-row IPC (AD-9).
   */
  getLogoPack(): Promise<IpcResult<LogoPack>>;

  // --- Logo blob cache + enrichment (Story 8.4) ---
  /**
   * Fetch the fetched-logo cache as a domain→`data:<mime>;base64,…` map (AD-13).
   * READ-ONLY: no mutation, no `evt:dataChanged`, no network — it reads the local
   * `logos/` blob cache. `{}` until a logo has been fetched (live fetch is off
   * until Story 8.5). The renderer hydrates it into `logoCacheStore` at launch
   * AND reloads it on `evt:dataChanged`, so a persisted logo swaps in. `resolveLogo`
   * uses it as the tier BETWEEN the bundled pack and the lettered fallback.
   */
  getLogoCache(): Promise<IpcResult<Record<string, string>>>;
  /**
   * Enqueue a domain for background logo enrichment and resolve IMMEDIATELY with
   * an ACK (`null`) — the UI NEVER awaits the fetch (AD-9). The single serial
   * worker processes the job later (gated by `liveLogoFetch`) and, on a successful
   * cache write, broadcasts a coalesced `evt:dataChanged` the renderer refreshes
   * through its existing `onDataChanged` path. Enqueuing is NOT a data mutation.
   * (The production auto-enqueue trigger and the live toggle arrive in Story 8.5.)
   */
  enqueueEnrichment(domain: string): Promise<IpcResult<null>>;

  // --- Data: import / export / backups (Req 16, 17, 18) ---
  importData(req: ImportRequest): Promise<IpcResult<ImportOutcome>>;
  exportData(req: ExportRequest): Promise<IpcResult<ExportResult>>;
  listBackups(): Promise<IpcResult<string[]>>;
  restoreBackup(name: string): Promise<IpcResult<SubscriptionV2[]>>;
  /**
   * Take a routine backup immediately ("Back up now", Story 7.3) and stamp
   * `settings.lastBackupAt`. Resolves with the new backup's file name; broadcasts
   * `evt:dataChanged`. Always backs up (the at-most-once cap applies only to the
   * SCHEDULED path).
   */
  createBackup(): Promise<IpcResult<string>>;

  // --- Events (main → renderer) ---
  /** Fires after any successful mutation so views can refresh (Req 8.6). Returns an unsubscribe. */
  onDataChanged(cb: () => void): Unsubscribe;
  /** Surfaces system-level failures for a global toast (Req 19.4). Returns an unsubscribe. */
  onError(cb: (error: AppError) => void): Unsubscribe;
}

declare global {
  interface Window {
    /** The typed IPC facade exposed by the preload (Req 2.4, 2.5). */
    subby: SubbyApi;
  }
}
