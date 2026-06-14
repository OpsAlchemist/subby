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
import type { Settings } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { SubscriptionPatch } from "core/subscriptions";
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
  listSubscriptions(): Promise<IpcResult<Subscription[]>>;
  createSubscription(input: SubscriptionInput): Promise<IpcResult<Subscription[]>>;
  updateSubscription(
    id: string,
    patch: SubscriptionPatch,
  ): Promise<IpcResult<Subscription[]>>;
  deleteSubscription(id: string): Promise<IpcResult<Subscription[]>>;
  toggleActive(id: string, value: boolean): Promise<IpcResult<Subscription[]>>;

  // --- Categories (Req 7) ---
  listCategories(): Promise<IpcResult<Category[]>>;
  createCategory(name: string): Promise<IpcResult<CreateCategoryData>>;
  deleteCategory(
    id: string,
    opts?: { confirmed: boolean },
  ): Promise<IpcResult<DeleteCategoryData>>;

  // --- Settings (Req 15) ---
  getSettings(): Promise<IpcResult<Settings>>;
  updateSettings(patch: Partial<Settings>): Promise<IpcResult<Settings>>;
  /** Opens the native folder picker; `data` is `null` when the dialog is dismissed (Req 15.3). */
  chooseDataFolder(): Promise<IpcResult<Settings | null>>;

  // --- Data: import / export / backups (Req 16, 17, 18) ---
  importData(req: ImportRequest): Promise<IpcResult<ImportOutcome>>;
  exportData(req: ExportRequest): Promise<IpcResult<ExportResult>>;
  listBackups(): Promise<IpcResult<string[]>>;
  restoreBackup(name: string): Promise<IpcResult<Subscription[]>>;

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
