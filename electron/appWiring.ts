/**
 * App wiring (Req 2.3, 2.4).
 *
 * Electron MAIN process composition root. This module assembles the
 * application services by injecting a {@link StoragePort} (the
 * {@link JsonFileStorage} adapter) into the platform-independent `core/`
 * functions. It is the IMPURE boundary: it is the single place that reads the
 * wall clock (`new Date().toISOString()`) so every `core/` function stays pure
 * and deterministic.
 *
 * The wiring is intentionally THIN — each service method composes a core pure
 * function with a storage read/write and returns the new persisted state. It
 * registers NO `ipcMain` handlers (task 13.2) and exposes NO preload bridge
 * (task 13.3); it only builds the services those layers will call.
 *
 * Destructive-operation sequencing (backup-before-destructive: delete,
 * import-apply, restore — Req 3.3, 16.4, 18.1–18.3) is centralized here so the
 * handlers do not have to re-implement it.
 */

import * as catCore from "core/categories";
import * as subsCore from "core/subscriptions";
import { exportCsv, exportJson } from "core/export";
import { planImport, type ImportOutcome } from "core/import";
import type { Category } from "core/models/category";
import type { Settings } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { StoragePort } from "core/ports/storagePort";
import type { ConflictMode, SubscriptionInput } from "shared/types";

import { JsonFileStorage } from "./storage/jsonFileStorage";

/** Serialization format for export/import. */
export type DataFormat = "json" | "csv";

/** Result of {@link AppServices.deleteCategory}. */
export type DeleteCategoryOutcome =
  | { ok: true; categories: Category[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "needs_confirmation"; name: string; inUseCount: number };

/**
 * The operations the IPC handlers (task 13.2) call. Each mutating method
 * persists the change through the {@link StoragePort} and returns the new
 * persisted state so the handler can wrap it in an `IpcResult` and broadcast
 * `evt:dataChanged`.
 *
 * Methods that perform a destructive operation back up the current
 * subscriptions BEFORE applying the change (Req 3.3, 16.4, 18.1–18.3).
 */
export interface AppServices {
  // --- Subscriptions (Req 3) ---
  /** Read all subscriptions. */
  listSubscriptions(): Promise<Subscription[]>;
  /** Create a subscription (unique id, createdAt === updatedAt); returns the new full set. */
  createSubscription(input: SubscriptionInput): Promise<Subscription[]>;
  /** Apply a patch to a subscription and advance `updatedAt`; returns the new full set. */
  updateSubscription(
    id: string,
    patch: subsCore.SubscriptionPatch,
  ): Promise<Subscription[]>;
  /** Backup, then remove a subscription; returns the new full set (Req 3.3). */
  deleteSubscription(id: string): Promise<Subscription[]>;
  /** Set `isActive` on a subscription; returns the new full set (Req 3.7). */
  toggleActive(id: string, value: boolean): Promise<Subscription[]>;

  // --- Categories (Req 7) ---
  /** Read all categories. */
  listCategories(): Promise<Category[]>;
  /** Create a custom category, rejecting duplicate names (Req 7.2, 7.3). */
  createCategory(name: string): Promise<catCore.CreateCategoryResult>;
  /**
   * Delete a category. When the category is assigned to ≥1 subscription and the
   * caller has not confirmed, returns `needs_confirmation` so the renderer can
   * prompt before completing the deletion (Req 7.4).
   */
  deleteCategory(
    id: string,
    opts?: { confirmed: boolean },
  ): Promise<DeleteCategoryOutcome>;

  // --- Settings (Req 15) ---
  /** Read the persisted settings. */
  getSettings(): Promise<Settings>;
  /** Merge and persist a settings patch; returns the merged settings (Req 15.2). */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Switch the active data folder and persist it into settings (Req 15.3). */
  setDataFolder(path: string | null): Promise<Settings>;

  // --- Import / Export (Req 16, 17) ---
  /** Backup, then plan + persist an import; returns the outcome (Req 16.4). */
  applyImport(
    raw: string,
    format: DataFormat,
    mode: ConflictMode,
  ): Promise<ImportOutcome>;
  /** Serialize subscriptions (+ settings for JSON) to the chosen format (Req 17). */
  exportData(format: DataFormat): Promise<string>;

  // --- Backups (Req 18) ---
  /** List backup file names, newest first (Req 18.2). */
  listBackups(): Promise<string[]>;
  /** Backup current data, then restore subscriptions from `name` (Req 18.2, 18.3). */
  restoreBackup(name: string): Promise<Subscription[]>;

  // --- Shared destructive helper ---
  /** Create a timestamped backup of the current subscriptions (Req 18.1). */
  createBackup(reason: string): Promise<string>;
}

/** The assembled application context: the storage port plus the services. */
export interface AppContext {
  storage: StoragePort;
  services: AppServices;
}

/** Current instant as an ISO-8601 string — the single wall-clock read site. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build the application services over an injected {@link StoragePort}.
 *
 * Used directly in tests with an in-memory/temp-dir storage implementation, and
 * by {@link createAppContext} in production with the {@link JsonFileStorage}
 * adapter.
 */
export function buildAppServices(storage: StoragePort): AppServices {
  return {
    // --- Subscriptions -------------------------------------------------------
    listSubscriptions() {
      return storage.readSubscriptions();
    },

    async createSubscription(input) {
      const existing = await storage.readSubscriptions();
      const next = subsCore.createSubscription(existing, input, nowIso());
      await storage.writeSubscriptions(next);
      return next;
    },

    async updateSubscription(id, patch) {
      const existing = await storage.readSubscriptions();
      const next = subsCore.editSubscription(existing, id, patch, nowIso());
      await storage.writeSubscriptions(next);
      return next;
    },

    async deleteSubscription(id) {
      // Backup-before-destructive (Req 3.3).
      await storage.createBackup("pre-delete");
      const existing = await storage.readSubscriptions();
      const next = subsCore.deleteSubscription(existing, id);
      await storage.writeSubscriptions(next);
      return next;
    },

    async toggleActive(id, value) {
      const existing = await storage.readSubscriptions();
      const next = subsCore.toggleActive(existing, id, value, nowIso());
      await storage.writeSubscriptions(next);
      return next;
    },

    // --- Categories ----------------------------------------------------------
    listCategories() {
      return storage.readCategories();
    },

    async createCategory(name) {
      const existing = await storage.readCategories();
      const result = catCore.createCategory(existing, name);
      if (result.ok) {
        await storage.writeCategories(result.categories);
      }
      return result;
    },

    async deleteCategory(id, opts) {
      const existing = await storage.readCategories();
      const target = existing.find((c) => c.id === id);
      if (target === undefined) {
        return { ok: false, reason: "not_found" };
      }
      if (opts?.confirmed !== true) {
        const subs = await storage.readSubscriptions();
        const inUseCount = catCore.categoryAssignmentCount(subs, target.name);
        if (inUseCount > 0) {
          // Defer to the renderer to confirm before deleting an in-use category (Req 7.4).
          return {
            ok: false,
            reason: "needs_confirmation",
            name: target.name,
            inUseCount,
          };
        }
      }
      const next = catCore.deleteCategory(existing, id);
      await storage.writeCategories(next);
      return { ok: true, categories: next };
    },

    // --- Settings ------------------------------------------------------------
    getSettings() {
      return storage.readSettings();
    },

    async updateSettings(patch) {
      // Read from the CURRENT folder before any data-folder switch so existing
      // settings are not lost.
      const current = await storage.readSettings();
      const merged = catCore.mergeSettings(current, patch);
      if ("dataFolder" in patch) {
        await storage.setDataFolder(merged.dataFolder);
      }
      await storage.writeSettings(merged);
      return merged;
    },

    async setDataFolder(path) {
      const current = await storage.readSettings();
      await storage.setDataFolder(path);
      const merged = catCore.mergeSettings(current, { dataFolder: path });
      await storage.writeSettings(merged);
      return merged;
    },

    // --- Import / Export -----------------------------------------------------
    async applyImport(raw, format, mode) {
      // Backup-before-destructive (Req 16.4).
      await storage.createBackup("pre-import");
      const existing = await storage.readSubscriptions();
      const outcome = planImport(existing, raw, format, mode);
      // `applied` starts from `existing`, so partial failures never discard
      // valid data (Req 16.5).
      await storage.writeSubscriptions(outcome.applied);
      return outcome;
    },

    async exportData(format) {
      const subs = await storage.readSubscriptions();
      if (format === "csv") {
        return exportCsv(subs);
      }
      const settings = await storage.readSettings();
      return exportJson(subs, settings);
    },

    // --- Backups -------------------------------------------------------------
    listBackups() {
      return storage.listBackups();
    },

    async restoreBackup(name) {
      // Backup current data before replacing it (Req 18.3).
      await storage.createBackup("pre-restore");
      const file = await storage.readBackup(name);
      await storage.writeSubscriptions(file.subscriptions);
      return file.subscriptions;
    },

    // --- Shared destructive helper -------------------------------------------
    createBackup(reason) {
      return storage.createBackup(reason);
    },
  };
}

/**
 * Construct the production {@link AppContext}: build the {@link JsonFileStorage}
 * adapter (injecting the platform `userData` directory and any persisted data
 * folder override) and assemble the services over it.
 *
 * @param defaultUserData The platform `userData` directory
 *                        (`app.getPath('userData')`).
 * @param dataFolder      Optional initial data-folder override from
 *                        `settings.dataFolder` (Req 15.3).
 */
export function createAppContext(
  defaultUserData: string,
  dataFolder: string | null = null,
): AppContext {
  const storage = new JsonFileStorage(defaultUserData, dataFolder);
  const services = buildAppServices(storage);
  return { storage, services };
}
