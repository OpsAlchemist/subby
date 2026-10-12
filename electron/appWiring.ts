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
import { defaultIsCloudPath, type CloudPathPredicate } from "./storage/paths";

/** Serialization format for export/import. */
export type DataFormat = "json" | "csv";

/**
 * The synced-folder caveat surfaced to the user when a data folder lives in a
 * cloud-synced location (AD-31, Story 1.7).
 *
 * Subby's data folder may be relocated into an iCloud / Dropbox / Drive folder,
 * but Subby does NOT provide real multi-device sync. The stance is
 * **single-machine-at-a-time**: a synced folder is safe only when one machine
 * writes to it at a time, and two machines running Subby against the same synced
 * folder concurrently can corrupt or lose data mid-sync. This string is the
 * canonical copy of that stance — exported so the Settings / data-folder surface
 * (UI copy is Epic-3/5 territory) can present it rather than hiding it. It is a
 * documented stance, not advertised as blessed multi-device sync.
 */
export const SYNCED_FOLDER_CAVEAT =
  "Storing your data folder in a cloud-synced location (iCloud, Dropbox, Google " +
  "Drive, OneDrive) is supported for a single machine at a time. Subby does not " +
  "provide multi-device sync: running Subby on two machines against the same " +
  "synced folder at once can lose or corrupt data mid-sync. If a file is " +
  "temporarily unavailable while syncing, Subby will ask you to retry or restore " +
  "from a backup rather than overwrite it with empty data.";

/**
 * The mutable user-data files that get an independent serialized write
 * authority. Serialization is **per-file**, never global (AD-29): a
 * subscriptions mutation and a settings mutation may run concurrently; only
 * same-file mutations are forced one-at-a-time.
 */
type MutableFileKey = "subscriptions" | "settings" | "categories";

/**
 * Build a set of per-file async mutexes (AD-29).
 *
 * Each key owns its own promise chain. A `runExclusive(key, fn)` call appends
 * `fn` to that key's chain so the next same-key critical section does not begin
 * until the previous one has fully resolved (its `read → core → write` — and, for
 * a destructive op, its backup — complete). Different keys have independent
 * chains, so unrelated files never block each other.
 *
 * The chain only sequences execution; it never propagates a prior section's
 * rejection to the next waiter. A failing mutation rejects **its own** returned
 * promise only — the next section still runs (edge-case matrix: "a failing
 * mutation rejects its own call only; the other still applies").
 *
 * This is deliberately a tiny inline primitive (no new dependency): a
 * `Map<key, Promise>` tail per file, exactly as the Design Notes describe.
 */
function createPerFileLock(): <T>(
  key: MutableFileKey,
  fn: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<MutableFileKey, Promise<unknown>>();

  return function runExclusive<T>(
    key: MutableFileKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    // Chain AFTER the previous section regardless of whether it fulfilled or
    // rejected (`catch(() => {})` swallows a prior failure for sequencing only;
    // it never leaks to this section's result).
    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    // Advance the tail to this section's completion. Swallow for the tail only
    // so a rejection here does not become an unhandled rejection AND does not
    // poison the next waiter — the real result is returned via `run` below.
    tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
}

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

/**
 * Run the migration barrier (AD-28): bring every mutable user-data file to the
 * current schema version **before** the scheduler or any IPC handler reads user
 * data on launch.
 *
 * It touches each file through the storage port's version-gated read path
 * (Story 1.4): a `< current` file is backed up, migrated, re-validated, and
 * atomically written back; a `== current` file is validated and returned
 * unchanged with no write-back. Running every migratable read here, up front,
 * is the hard barrier — nothing downstream (scheduler catch-up, periodic ticks,
 * handler reads) observes a half-migrated file because the migration already
 * completed-or-no-opped by the time this resolves.
 *
 * **Inert at `current = 1` (live scope A):** every file on disk is already at the
 * live `CURRENT_VERSION`, so each read takes the `== current` branch — it
 * validates and returns with NO migration and NO write-back. The barrier is a
 * genuine no-op *pass* today: it changes launch *structure*, not launch
 * *behavior*. When Epic 3 flips `CURRENT_VERSION` to 2, these same reads become
 * the load-bearing migrate-and-write-back step, ahead of any reader — no change
 * to this function is required.
 *
 * **Fail-soft contract (AD-28):** a migration/read fault is surfaced as a typed
 * storage error to the caller (`createAppContext`'s launch sequence in
 * `main.ts`), which degrades to an `evt:error` and does NOT start the scheduler
 * on corrupt/un-migrated state. This function does not swallow the error — it
 * lets the typed storage error propagate so the launch sequence can classify it;
 * it just guarantees the migration is driven to completion before returning.
 *
 * Categories are included for completeness even though at scope A they share the
 * same no-op semantics; reading them here keeps the barrier's "no reader touches
 * un-migrated user data" guarantee total across every mutable file.
 */
export async function runMigrationBarrier(storage: StoragePort): Promise<void> {
  // Order is irrelevant (each read is independent and the version-gated path is
  // idempotent once a file is at current), but doing them sequentially keeps the
  // launch path deterministic and avoids a burst of concurrent write-backs on an
  // upgrade launch. Each call either no-ops (== current) or migrates-and-writes
  // (< current) to completion before the next begins.
  await storage.readSubscriptions();
  await storage.readSettings();
  await storage.readCategories();
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
  // Per-file write authority (AD-29). Every mutating method below runs its whole
  // `read → core → write` (and, for a destructive op, its pre-op backup) inside
  // `lock(<file>, ...)` so two same-file mutations never interleave across an
  // `await` — the second does not begin its read until the first has written.
  // This closes the last-writer-wins bug where two concurrent read-modify-writes
  // each read the same `existing` set and the later write clobbered the earlier.
  //
  // Read stance (snapshot consistency): read-only methods (`listSubscriptions`,
  // `getSettings`, `listCategories`, `listBackups`, `exportData`) stay OUTSIDE
  // the lock. The storage adapter writes atomically (temp-then-rename), so a
  // lock-free read observes either the pre-write file or the post-write file —
  // never a torn/partial state — even when issued between two serialized writes.
  const lock = createPerFileLock();

  return {
    // --- Subscriptions -------------------------------------------------------
    listSubscriptions() {
      // Lock-free read: snapshot-consistent at the adapter's atomic-write
      // granularity (see read stance above).
      return storage.readSubscriptions();
    },

    createSubscription(input) {
      return lock("subscriptions", async () => {
        const existing = await storage.readSubscriptions();
        const next = subsCore.createSubscription(existing, input, nowIso());
        await storage.writeSubscriptions(next);
        return next;
      });
    },

    updateSubscription(id, patch) {
      return lock("subscriptions", async () => {
        const existing = await storage.readSubscriptions();
        const next = subsCore.editSubscription(existing, id, patch, nowIso());
        await storage.writeSubscriptions(next);
        return next;
      });
    },

    deleteSubscription(id) {
      return lock("subscriptions", async () => {
        // Backup-before-destructive (Req 3.3) runs INSIDE the serialized section
        // so the backup + the delete write are one atomic unit — no other
        // subscriptions mutation can interleave between them (AD-29).
        await storage.createBackup("pre-delete");
        const existing = await storage.readSubscriptions();
        const next = subsCore.deleteSubscription(existing, id);
        await storage.writeSubscriptions(next);
        return next;
      });
    },

    toggleActive(id, value) {
      return lock("subscriptions", async () => {
        const existing = await storage.readSubscriptions();
        const next = subsCore.toggleActive(existing, id, value, nowIso());
        await storage.writeSubscriptions(next);
        return next;
      });
    },

    // --- Categories ----------------------------------------------------------
    listCategories() {
      return storage.readCategories();
    },

    createCategory(name) {
      return lock("categories", async () => {
        const existing = await storage.readCategories();
        const result = catCore.createCategory(existing, name);
        if (result.ok) {
          await storage.writeCategories(result.categories);
        }
        return result;
      });
    },

    deleteCategory(id, opts) {
      // Serializes on the file it WRITES — `categories`. The subscriptions read
      // used to count assignments is a lock-free, snapshot-consistent read (it
      // does not mutate subscriptions).
      return lock("categories", async () => {
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
      });
    },

    // --- Settings ------------------------------------------------------------
    getSettings() {
      return storage.readSettings();
    },

    updateSettings(patch) {
      return lock("settings", async () => {
        // Read from the CURRENT folder before any data-folder switch so existing
        // settings are not lost.
        const current = await storage.readSettings();
        const merged = catCore.mergeSettings(current, patch);
        if ("dataFolder" in patch) {
          await storage.setDataFolder(merged.dataFolder);
        }
        await storage.writeSettings(merged);
        return merged;
      });
    },

    setDataFolder(path) {
      return lock("settings", async () => {
        const current = await storage.readSettings();
        await storage.setDataFolder(path);
        const merged = catCore.mergeSettings(current, { dataFolder: path });
        await storage.writeSettings(merged);
        return merged;
      });
    },

    // --- Import / Export -----------------------------------------------------
    applyImport(raw, format, mode) {
      return lock("subscriptions", async () => {
        // Backup-before-destructive (Req 16.4) inside the serialized section.
        await storage.createBackup("pre-import");
        const existing = await storage.readSubscriptions();
        const outcome = planImport(existing, raw, format, mode);
        // `applied` starts from `existing`, so partial failures never discard
        // valid data (Req 16.5).
        await storage.writeSubscriptions(outcome.applied);
        return outcome;
      });
    },

    async exportData(format) {
      // Read-only: no lock (snapshot-consistent reads).
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

    restoreBackup(name) {
      return lock("subscriptions", async () => {
        // Backup current data before replacing it (Req 18.3) inside the
        // serialized section so the backup + restore write are atomic.
        await storage.createBackup("pre-restore");
        const file = await storage.readBackup(name);
        await storage.writeSubscriptions(file.subscriptions);
        return file.subscriptions;
      });
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
 * @param isCloudPath     The cloud-path detection predicate behind the AD-31
 *                        safe-read guardrail (Story 1.7). **Defaults to the safe
 *                        no-op {@link defaultIsCloudPath}** (`() => false`), so
 *                        production is byte-identical to before this story — the
 *                        guardrail is dormant until PRD Q7 supplies a real per-OS
 *                        detector behind this same seam. Threaded here so the
 *                        swap is a one-argument change with no structural edit.
 */
export function createAppContext(
  defaultUserData: string,
  dataFolder: string | null = null,
  isCloudPath: CloudPathPredicate = defaultIsCloudPath,
): AppContext {
  const storage = new JsonFileStorage(
    defaultUserData,
    dataFolder,
    undefined,
    isCloudPath,
  );
  const services = buildAppServices(storage);
  return { storage, services };
}
