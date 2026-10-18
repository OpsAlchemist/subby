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
import * as subsCore from "core/subscriptionsV2";
import { exportCsv, exportJson } from "core/export";
import { planImport, type ImportOutcome } from "core/import";
import { hexColor } from "core/models/schema";
import { lookupSuggestion, type PriceSeed, type PriceSuggestion } from "core/priceSeed";
import {
  ratesForHome,
  resolveEffectiveSnapshot,
  type BundledFxSnapshot,
  type FxOverride,
} from "core/fxSnapshot";
import { EMPTY_LOGO_PACK, type LogoPack } from "core/logo";
import type { RateSnapshot } from "core/money";
import type { Category } from "core/models/category";
import type { ReminderLedger } from "core/models/reminder";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { StoragePort } from "core/ports/storagePort";
import type { ConflictMode, SubscriptionInputV2 } from "shared/types";

import { JsonFileStorage } from "./storage/jsonFileStorage";
import { defaultIsCloudPath, type CloudPathPredicate } from "./storage/paths";
import {
  readBundledFxSnapshot,
  readBundledLogoPack,
  readBundledPriceSeed,
} from "./storage/resourceReader";
import { LogoBlobCache } from "./services/logoBlobCache";
import { EnrichmentService } from "./services/enrichment";
import type { GetWindow } from "./ipc/handlers";

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
type MutableFileKey =
  | "subscriptions"
  | "settings"
  | "categories"
  | "reminderLedger";

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
 * Result of {@link AppServices.updateCategoryColor} (Story 3.4). The service
 * never throws: an unknown id yields `not_found`, a non-hex color yields
 * `validation`, and both map to inline IPC errors (no global toast).
 */
export type UpdateCategoryColorOutcome =
  | { ok: true; categories: Category[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "validation" };

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
  listSubscriptions(): Promise<SubscriptionV2[]>;
  /** Create a subscription (unique id, createdAt === updatedAt); returns the new full set. */
  createSubscription(input: SubscriptionInputV2): Promise<SubscriptionV2[]>;
  /** Apply a patch to a subscription and advance `updatedAt`; returns the new full set. */
  updateSubscription(
    id: string,
    patch: subsCore.SubscriptionPatchV2,
  ): Promise<SubscriptionV2[]>;
  /** Backup, then remove a subscription; returns the new full set (Req 3.3). */
  deleteSubscription(id: string): Promise<SubscriptionV2[]>;
  /** Set the three-way `state` on a subscription; returns the new full set (Req 3.7, AD-17). */
  setState(
    id: string,
    state: SubscriptionV2["state"],
  ): Promise<SubscriptionV2[]>;

  // --- Categories (Req 7) ---
  /** Read all categories. */
  listCategories(): Promise<Category[]>;
  /** Create a custom category, rejecting duplicate names (Req 7.2, 7.3). */
  createCategory(name: string): Promise<catCore.CreateCategoryResult>;
  /**
   * Set (or clear) a category's color (Story 3.4, FR-3). `color` is a validated
   * `#rrggbb` hex to set, or `undefined` to clear. Returns the new `Category[]`
   * on success; an unknown id → `not_found`, a non-hex color → `validation`
   * (never throws).
   */
  updateCategoryColor(
    id: string,
    color: string | undefined,
  ): Promise<UpdateCategoryColorOutcome>;
  /**
   * Delete a category. When the category is assigned to ≥1 subscription and the
   * caller has not confirmed, returns `needs_confirmation` so the renderer can
   * prompt before completing the deletion (Req 7.4).
   */
  deleteCategory(
    id: string,
    opts?: { confirmed: boolean },
  ): Promise<DeleteCategoryOutcome>;

  // --- Suggested price (FR-13, Story 5.4) ---
  /**
   * Look up a bundled suggested price for a queried service name (CREATE-mode
   * Add convenience). Returns the matching seed entry's figures plus the seed's
   * `asOf` (so the renderer applies the staleness guard with its own local
   * `today`), or `null` on no match. Returns `null` when the bundled seed failed
   * to load (missing/corrupt — the feature degrades off). READ-ONLY, lock-free,
   * never throws: the seed is an immutable bundle, never the StoragePort.
   */
  getPriceSuggestion(name: string): PriceSuggestion | null;

  // --- FX snapshot (Story 6.1 + Story 8.6 refresh override) ---
  /**
   * Return the EFFECTIVE FX {@link RateSnapshot} rebased to `homeCurrency`
   * (`rates[home] === "1"`, every other currency expressed in Home major units),
   * or `null` when no snapshot is available (bundle failed to load AND no
   * override) or the Home Currency is unknown/absent from the effective snapshot.
   *
   * The effective snapshot is resolved ONCE per call (a call == a conversion
   * batch) by {@link resolveEffectiveSnapshot} over {bundle, override}: whichever
   * has the newer `asOf` wins (AD-23) — the opt-in Story 8.6 refresh override
   * (`<DataFolder>/fx-snapshot.json`) when it is fresher, else the shipped bundle
   * (so a stale override never shadows a post-release bundle). READ-ONLY and
   * lock-free: the override read is atomic (temp-then-rename), so a lock-free read
   * sees the whole old or whole new file, never a torn one; a missing/corrupt
   * override degrades to "no override" (`null`), never a throw. Staleness is NOT
   * decided here (core takes no clock); the renderer applies `rateConfidence` with
   * its own local `today` to the returned `asOf`.
   */
  getFxSnapshot(homeCurrency: string): Promise<RateSnapshot | null>;

  // --- Logo Pack (Story 8.3) ---
  /**
   * Return the bundled {@link LogoPack} loaded once at construction (FR-26,
   * AD-25). READ-ONLY, lock-free, NEVER throws and NEVER touches the network:
   * the pack is immutable shipped data read through the resource reader, not the
   * StoragePort. A missing/corrupt pack arrives here as the EMPTY pack, so the
   * renderer resolves every row to the deterministic lettered fallback — never a
   * crash, never a blocking fetch, never a toast.
   */
  getLogoPack(): LogoPack;

  // --- Logo blob cache + enrichment (Story 8.4) ---
  /**
   * Return the fetched-logo cache as a domain→`data:<mime>;base64,…` map (AD-13).
   * READ-ONLY, lock-free: reads the `<DataFolder>/logos/` blob cache fresh. `{}`
   * until a logo has been fetched (live fetch is off until Story 8.5), so for
   * real users this story it is empty — the renderer then resolves every row to
   * the bundled pack or the lettered fallback. Never throws (an absent/unreadable
   * cache yields `{}`); the StoragePort is untouched.
   */
  getLogoCache(): Promise<Record<string, string>>;
  /**
   * Enqueue a domain for background logo enrichment and return IMMEDIATELY (AD-9)
   * — the UI never awaits the fetch. The single serial worker processes the job
   * later (gated by `liveLogoFetch`) and, on a successful cache write, broadcasts
   * a coalesced `evt:dataChanged`. A no-op when the enrichment service is not
   * wired (e.g. a test context that did not inject one).
   */
  enqueueEnrichment(domain: string): void;

  // --- FX refresh override (Story 8.6, AD-23) ---
  /**
   * Persist the FX refresh override atomically through the StoragePort, serialized
   * under the settings-family lock (AD-2/AD-29) so the single-writer discipline
   * holds and a lock-free `getFxSnapshot` reader never observes a torn write. The
   * EnrichmentService's FX job is the ONLY caller. Validates rates LOUDLY (a bad
   * rate throws, caught by the service as a silent miss — "no override written").
   */
  writeFxOverride(override: FxOverride): Promise<void>;
  /**
   * Request a background FX rate refresh and return IMMEDIATELY (AD-9). Triggered
   * by `main.ts` at launch (when `fxRefresh` is on) and by the `onSettingsMutated`
   * hook when the toggle flips on — NO second timer. The job self-gates on the
   * toggle and the ≤24h cadence; a no-op when the enrichment service is not wired.
   */
  enqueueFxRefresh(): void;

  // --- Settings (Req 15) ---
  /** Read the persisted settings. */
  getSettings(): Promise<SettingsV2>;
  /** Merge and persist a settings patch; returns the merged settings (Req 15.2). */
  updateSettings(patch: Partial<SettingsV2>): Promise<SettingsV2>;
  /** Switch the active data folder and persist it into settings (Req 15.3). */
  setDataFolder(path: string | null): Promise<SettingsV2>;

  // --- Reminder ledger (Epic 4) ---
  /**
   * Read the persisted reminder ledger. Lock-free snapshot read (mirrors
   * `getSettings`): the adapter writes atomically, so a lock-free read observes
   * either the pre-write or the post-write file, never a torn state.
   */
  readReminderLedger(): Promise<ReminderLedger>;
  /**
   * Write the reminder ledger back, serialized under `lock("reminderLedger")`
   * so the scheduler (its only writer) is a single serialized writer and a
   * crash mid-cycle leaves a consistent prior ledger (atomic write — AD-19/4.2).
   */
  writeReminderLedger(ledger: ReminderLedger): Promise<void>;

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
  restoreBackup(name: string): Promise<SubscriptionV2[]>;

  // --- Shared destructive helper ---
  /** Create a timestamped backup of the current subscriptions (Req 18.1). */
  createBackup(reason: string): Promise<string>;

  /**
   * Take a ROUTINE backup and stamp `settings.lastBackupAt` as ONE atomic unit
   * under `lock("settings")` (Story 7.3). Re-reads settings inside the lock
   * (never trusts a stale caller copy), calls `storage.createBackup(reason)`,
   * then persists `{...settings, lastBackupAt: nowIso()}`, returning the backup
   * name. Reused verbatim by BOTH the scheduled path (Scheduler, `reason:
   * "scheduled"`) and the manual "Back up now" path (IPC, `reason: "manual"`).
   */
  backupNow(reason: string): Promise<string>;
}

/**
 * The enrichment wiring the services + `main.ts` share (Story 8.4). Kept as a
 * narrow seam so `buildAppServices` can take an injected fake in tests and the
 * production composition root can construct the real {@link LogoBlobCache} +
 * {@link EnrichmentService}.
 *
 *   - `blobCache` backs the read-only {@link AppServices.getLogoCache}.
 *   - `service` backs {@link AppServices.enqueueEnrichment}; `main.ts` also calls
 *     `start()`/`stop()` on it directly for the deferred-drain launch ordering.
 */
export interface EnrichmentWiring {
  blobCache: LogoBlobCache;
  service: EnrichmentService;
}

/** The assembled application context: the storage port, services, and enrichment. */
export interface AppContext {
  storage: StoragePort;
  services: AppServices;
  /**
   * The logo-enrichment pipeline (Story 8.4). Always built by
   * {@link createAppContext} (with the live `getWindow`). `main.ts` captures it
   * and permits it to drain only after the migration barrier has passed AND the
   * window is `ready-to-show` — via `start()`, which it defers to `ready-to-show`
   * (AD-28); it stops the service on quit.
   */
  enrichment: EnrichmentService;
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
 * Load the bundled suggested-price seed, or `null` on any failure (Story 5.4).
 *
 * The default production loader reads the asar-aware bundle via
 * {@link readBundledPriceSeed} and returns `null` on a `ResourceReadError`
 * (missing/unreadable) OR a `PriceSeedError` (bad shape) — the whole feature
 * degrades off. It is injectable so tests can supply a fixed {@link PriceSeed}
 * (or a null-returning loader to simulate an absent/corrupt seed) WITHOUT
 * booting Electron (the default would touch the `electron` `app` globals).
 */
export type PriceSeedLoader = () => PriceSeed | null;

/** The production seed loader: read the bundle, degrade to `null` on any error. */
export const defaultPriceSeedLoader: PriceSeedLoader = () => {
  try {
    return readBundledPriceSeed();
  } catch {
    // ResourceReadError (missing/malformed) OR PriceSeedError (bad shape):
    // surface as "no suggestions available" by holding null.
    return null;
  }
};

/**
 * Load the bundled EUR-based FX snapshot, or `null` on any failure (Story 6.1).
 *
 * The default production loader reads the asar-aware bundle via
 * {@link readBundledFxSnapshot} and returns `null` on a `ResourceReadError`
 * (missing/unreadable) OR an `FxSnapshotError`/`UnknownCurrencyError` (bad
 * shape/currency/rate) — the Dashboard then surfaces "rates unavailable" rather
 * than a wrong confident total. Injectable so tests can supply a fixed
 * {@link BundledFxSnapshot} (or a null-returning loader to simulate an
 * absent/corrupt bundle) WITHOUT booting Electron (the default would touch the
 * `electron` `app` globals).
 */
export type FxSnapshotLoader = () => BundledFxSnapshot | null;

/** The production FX loader: read the bundle, degrade to `null` on any error. */
export const defaultFxSnapshotLoader: FxSnapshotLoader = () => {
  try {
    return readBundledFxSnapshot();
  } catch {
    // ResourceReadError (missing/malformed) OR FxSnapshotError/UnknownCurrencyError
    // (bad shape/currency/rate): surface as "rates unavailable" by holding null.
    return null;
  }
};

/**
 * Load the bundled Logo Pack, degrading to the EMPTY pack on any failure (Story
 * 8.3).
 *
 * The default production loader reads the asar-aware bundle via
 * {@link readBundledLogoPack}, which itself never throws (a missing/corrupt pack
 * yields the {@link EMPTY_LOGO_PACK}). Injectable so tests can supply a fixed
 * {@link LogoPack} (or the empty pack to simulate an absent/corrupt bundle)
 * WITHOUT booting Electron (the default would touch the `electron` `app`
 * globals).
 */
export type LogoPackLoader = () => LogoPack;

/** The production Logo Pack loader: read the bundle, EMPTY pack on any failure. */
export const defaultLogoPackLoader: LogoPackLoader = () => {
  try {
    return readBundledLogoPack();
  } catch {
    // readBundledLogoPack already degrades, but belt-and-suspenders: a logo is
    // decorative, so any surprise failure resolves to the lettered fallback.
    return EMPTY_LOGO_PACK;
  }
};

/**
 * Build the application services over an injected {@link StoragePort}.
 *
 * Used directly in tests with an in-memory/temp-dir storage implementation, and
 * by {@link createAppContext} in production with the {@link JsonFileStorage}
 * adapter.
 *
 * @param storage      the storage port backing mutable user data.
 * @param priceSeed    the loaded suggested-price seed (or `null` when it failed
 *                     to load / the feature is off). Defaults to the production
 *                     {@link defaultPriceSeedLoader}; tests inject a fixed seed.
 * @param fxSnapshot   the loaded bundled FX snapshot (or `null` when it failed
 *                     to load — rates then surface as "unavailable"). Defaults to
 *                     the production {@link defaultFxSnapshotLoader}; tests inject
 *                     a fixed snapshot.
 * @param logoPack     the loaded bundled Logo Pack (or the EMPTY pack when it
 *                     failed to load — every row then shows the lettered
 *                     fallback). Defaults to the production
 *                     {@link defaultLogoPackLoader}; tests inject a fixed pack.
 */
export function buildAppServices(
  storage: StoragePort,
  priceSeed: PriceSeed | null = defaultPriceSeedLoader(),
  fxSnapshot: BundledFxSnapshot | null = defaultFxSnapshotLoader(),
  logoPack: LogoPack = defaultLogoPackLoader(),
  enrichment: EnrichmentWiring | null = null,
): AppServices {
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

  // The bundled suggested-price seed (Story 5.4) is read ONCE at construction
  // through the asar-aware resource reader (the `defaultPriceSeedLoader` default
  // of the `priceSeed` parameter) — never the StoragePort, since the seed is
  // immutable shipped data. A missing/corrupt seed arrives here as `null`, so the
  // whole feature degrades OFF (`getPriceSuggestion` returns null): a suggestion
  // is a convenience, never load-bearing, and must NEVER block or crash Add. No
  // network, no lock (read-only, immutable in-memory bundle).

  return {
    // --- Subscriptions -------------------------------------------------------
    listSubscriptions() {
      // Lock-free read: snapshot-consistent at the adapter's atomic-write
      // granularity (see read stance above).
      return storage.readSubscriptions();
    },

    createSubscription(input) {
      return lock("subscriptions", async () => {
        // `createSubscriptionV2` needs the Home Currency for its
        // default-to-Home rule (an unspecified Native Currency becomes Home).
        // Settings is now v2, so `homeCurrency` is read here (the migrator maps
        // v1 `defaultCurrency` → `homeCurrency`).
        const [existing, settings] = await Promise.all([
          storage.readSubscriptions(),
          storage.readSettings(),
        ]);
        const next = subsCore.createSubscriptionV2(
          existing,
          input,
          settings.homeCurrency,
          nowIso(),
        );
        await storage.writeSubscriptions(next);
        return next;
      });
    },

    updateSubscription(id, patch) {
      return lock("subscriptions", async () => {
        const existing = await storage.readSubscriptions();
        const next = subsCore.editSubscriptionV2(existing, id, patch, nowIso());
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
        const next = subsCore.deleteSubscriptionV2(existing, id);
        await storage.writeSubscriptions(next);
        return next;
      });
    },

    setState(id, state) {
      return lock("subscriptions", async () => {
        const existing = await storage.readSubscriptions();
        const next = subsCore.setSubscriptionState(existing, id, state, nowIso());
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

    updateCategoryColor(id, color) {
      // Serializes on the file it writes (`categories`), mirroring the other
      // category mutators: read → setCategoryColor → write under the lock.
      return lock("categories", async () => {
        // VALIDATE the color at this service boundary (the single runtime source
        // is `hexColor`). `undefined` means CLEAR and is always allowed; a string
        // must be a `#rrggbb` hex, otherwise a `validation` outcome is returned
        // (never throws, never persists arbitrary text into an inline style).
        if (color !== undefined && !hexColor.safeParse(color).success) {
          return { ok: false, reason: "validation" };
        }
        const existing = await storage.readCategories();
        if (!existing.some((c) => c.id === id)) {
          // Unknown id: nothing is written.
          return { ok: false, reason: "not_found" };
        }
        const next = catCore.setCategoryColor(existing, id, color);
        await storage.writeCategories(next);
        return { ok: true, categories: next };
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

    // --- Suggested price (FR-13, Story 5.4) ----------------------------------
    getPriceSuggestion(name) {
      // Lock-free, read-only lookup over the immutable in-memory bundle. When the
      // seed failed to load, the feature is off → null. Staleness is NOT decided
      // here (core takes no clock); the renderer applies `isSeedStale` with its
      // real local `today` to the returned `asOf`.
      if (priceSeed === null) return null;
      return lookupSuggestion(priceSeed, name);
    },

    // --- FX snapshot (Story 6.1 + Story 8.6 refresh override) ----------------
    async getFxSnapshot(homeCurrency) {
      // Resolve the EFFECTIVE snapshot ONCE per call (a call == a conversion
      // batch, AD-23): newest `asOf` of {bundle, override} wins. The override read
      // is lock-free + atomic (temp-then-rename), so it observes a whole old/new
      // file, never a torn one; a missing/corrupt override degrades to `null`
      // (bundle still totals), so this never throws from the read.
      const override = await storage.readFxOverride();
      const effective = resolveEffectiveSnapshot(fxSnapshot, override);
      // No bundle AND no override → rates unavailable.
      if (effective === null) return null;
      // `ratesForHome` can throw for an unknown Home Currency or one absent from
      // the effective snapshot (UnknownCurrencyError / FxSnapshotError); catch here
      // so a bad query degrades to null rather than crossing the bridge as a throw —
      // the renderer treats null as "rates unavailable", never a wrong total.
      try {
        return ratesForHome(effective, homeCurrency);
      } catch {
        return null;
      }
    },

    // --- Logo Pack (Story 8.3) -----------------------------------------------
    getLogoPack() {
      // Lock-free, read-only return of the immutable in-memory pack read once at
      // construction. When the pack failed to load it is the EMPTY pack, so the
      // renderer resolves every row to the lettered fallback. No network, no
      // StoragePort, never throws.
      return logoPack;
    },

    // --- Logo blob cache + enrichment (Story 8.4) ----------------------------
    async getLogoCache() {
      // Lock-free, read-only read of the `<DataFolder>/logos/` blob cache as a
      // domain→data-URI map. No enrichment wiring (e.g. a bare test context) →
      // an empty map. The cache helper never throws (an absent cache yields {}),
      // and the StoragePort is untouched (AD-13).
      if (enrichment === null) return {};
      return enrichment.blobCache.readAllAsDataUris();
    },

    enqueueEnrichment(domain) {
      // Fire-and-forget (AD-9): push onto the serial worker's queue and return.
      // A no-op when no enrichment service is wired. The worker enforces the
      // gate (liveLogoFetch), never-refetch, and silent-fail-and-fallback.
      enrichment?.service.enqueue(domain);
    },

    // --- FX refresh override (Story 8.6, AD-23) ------------------------------
    writeFxOverride(override) {
      // Serialize on the SETTINGS family lock (AD-2/AD-29): the override is a
      // settings-adjacent single-writer file, so taking the same lock settings
      // mutations take keeps the EnrichmentService the sole serialized writer and
      // guarantees a lock-free `getFxSnapshot` reader never races the atomic write.
      return lock("settings", () => storage.writeFxOverride(override));
    },

    enqueueFxRefresh() {
      // Fire-and-forget (AD-9): ask the serial FX job to run and return. A no-op
      // when no enrichment service is wired. The job enforces the `fxRefresh` gate,
      // the ≤24h cadence cap, and silent-fail-keep-last-good.
      enrichment?.service.enqueueFxRefresh();
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

    // --- Reminder ledger -----------------------------------------------------
    readReminderLedger() {
      // Lock-free snapshot read, like `getSettings`/`listSubscriptions`: the
      // adapter writes atomically so a lock-free read never observes a torn file.
      return storage.readReminderLedger();
    },

    writeReminderLedger(ledger) {
      // Serialize on the file it writes (`reminderLedger`): the scheduler is the
      // lone writer, so this lock makes it a single serialized writer whose
      // atomic write leaves a consistent prior ledger on a mid-cycle crash.
      return lock("reminderLedger", () => storage.writeReminderLedger(ledger));
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

    backupNow(reason) {
      // Serialize on `settings` so the backup + the `lastBackupAt` stamp are ONE
      // atomic unit: a concurrent `updateSettings` can neither interleave between
      // them nor clobber the stamp (AD-29). Re-read settings INSIDE the lock —
      // never trust a stale caller copy — so the merge writes the freshest state.
      return lock("settings", async () => {
        const settings = await storage.readSettings();
        const name = await storage.createBackup(reason);
        const merged = catCore.mergeSettings(settings, { lastBackupAt: nowIso() });
        await storage.writeSettings(merged);
        return name;
      });
    },
  };
}

/**
 * Construct the production {@link AppContext}: build the {@link JsonFileStorage}
 * adapter (injecting the platform `userData` directory and any persisted data
 * folder override), the Story 8.4 enrichment pipeline, and assemble the services
 * over them.
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
 * @param getWindow       Accessor returning the live renderer window (or `null`),
 *                        used by the {@link EnrichmentService} to broadcast a
 *                        coalesced `evt:dataChanged` on a completed job (AD-8).
 *                        It is a LAZY closure (`() => mainWindow`), so passing it
 *                        before the window exists is safe — it is only read when a
 *                        job completes, long after launch. Defaults to a no-window
 *                        accessor so a bare `createAppContext(dir)` call (tests)
 *                        still wires a functioning service that simply skips the
 *                        broadcast when no window is present.
 */
export function createAppContext(
  defaultUserData: string,
  dataFolder: string | null = null,
  isCloudPath: CloudPathPredicate = defaultIsCloudPath,
  getWindow: GetWindow = () => null,
): AppContext {
  const storage = new JsonFileStorage(
    defaultUserData,
    dataFolder,
    undefined,
    isCloudPath,
  );

  // Story 8.4 enrichment pipeline. The blob cache reads the active data folder
  // FRESH on each op via `storage.getDataFolder` (bound), so a Data-Folder
  // relocation is a plain re-point. The service is built here but only DRAINS
  // after `main.ts` calls `start()` (post-barrier + ready-to-show, AD-28). The
  // services need the blob cache (for `getLogoCache`) and the service (for
  // `enqueueEnrichment`), so build them first and inject them.
  const blobCache = new LogoBlobCache(() => storage.getDataFolder());

  // Placeholder services used only to satisfy the EnrichmentService's
  // `getSettings` seam; it is immediately replaced by the real services below.
  // To avoid a chicken-and-egg (service needs services, services need service),
  // the service reads settings through a thin accessor that forwards to the
  // assembled services once they exist.
  let assembled: AppServices;
  const service = new EnrichmentService({
    services: {
      getSettings: () => assembled.getSettings(),
      // The FX refresh job (Story 8.6) is the SOLE writer of the override, through
      // the StoragePort (AD-23). The read/write are serialized under the settings-
      // family lock (see `writeFxOverride` on AppServices) so a lock-free reader
      // never sees a torn file; the service itself is a single serial FX job.
      readFxOverride: () => storage.readFxOverride(),
      writeFxOverride: (override) => assembled.writeFxOverride(override),
      // Story 9.1: the backfill-on-enable reads ALL subscriptions (lock-free
      // snapshot) and maps each `website` → registrable domain to feed the
      // existing serial queue. Forwarded to the assembled services like the
      // other seams above.
      listSubscriptions: () => assembled.listSubscriptions(),
    },
    blobCache,
    getWindow,
  });

  assembled = buildAppServices(storage, undefined, undefined, undefined, {
    blobCache,
    service,
  });

  return { storage, services: assembled, enrichment: service };
}
