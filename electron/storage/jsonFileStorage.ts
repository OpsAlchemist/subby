/**
 * Electron storage adapter: `JsonFileStorage` (Req 1.2, 1.3, 1.4, 1.5, 2.3,
 * 15.3, 18.1, 18.2, 19.3).
 *
 * Electron MAIN process module. Node imports (`node:fs/promises`, `node:path`,
 * `node:crypto`) are allowed here. This class implements the platform-
 * independent {@link StoragePort} using local JSON files in the
 * `App_Data_Directory`.
 *
 * Responsibilities:
 *   - Resolve the active data directory from a default `userData` path,
 *     overridable by `settings.dataFolder` (Req 1.1, 15.3).
 *   - Ensure the directory tree (`App_Data_Directory` + `backup/`) exists
 *     (Req 1.3, 1.4).
 *   - Lazily create missing JSON files with valid defaults on read
 *     (Req 1.5, 19.3).
 *   - Read every file through {@link safeReadJson} so a read never crashes the
 *     app (Req 19). Corrupt/malformed files are NOT overwritten; instead a
 *     typed {@link StorageCorruptError} is thrown so the IPC layer can surface
 *     the affected file and offer a backup restore (Req 19.1, 19.2).
 *   - Write atomically via {@link writeJsonAtomic} (Req 19).
 *   - Manage subscription backups (Req 18.1, 18.2).
 *
 * Testability: the constructor takes the default `userData` directory as an
 * explicit argument (rather than calling `app.getPath('userData')` internally),
 * so the adapter can be exercised against a temp directory without booting
 * Electron. The real value is injected by the app-wiring layer.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  categoriesFileSchema,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_V2,
  settingsFileSchema,
  settingsFileV2Schema,
  subscriptionsFileSchema,
  subscriptionsFileV2Schema,
} from "core/models/schema";
import { assembleBackupPayload, backupFileName } from "core/backup";
import { migrate } from "core/migrations";
import type { Category } from "core/models/category";
import type { SettingsFileV2, SettingsV2 } from "core/models/settings";
import type {
  SubscriptionsFileV2,
  SubscriptionV2,
} from "core/models/subscription";
import type { StoragePort } from "core/ports/storagePort";

import {
  defaultIsCloudPath,
  fileNames,
  resolveDataDir,
  type CloudPathPredicate,
} from "./paths";
import {
  isFileExistsError,
  safeReadJson,
  safeReadVersionedJson,
  writeJsonAtomic,
  writeJsonExclusive,
} from "./safeJson";

/**
 * The current on-disk schema version the live app reads and writes.
 *
 * Story 3.3 cutover: this is now **2**. The running app reads/writes v2 files;
 * an existing `version: 1` file on disk migrates-on-read through the already-
 * tested version-gated path below (back up the raw v1 file, run the frozen
 * `migrateSubscriptionV1toV2` migrator, validate against the v2 schema, write
 * back). The gating logic was built and proven in Epic 1 against a synthetic
 * `current = 2`; flipping this one constant is what makes that path live (AD-15,
 * FR-29). No change to the gating logic itself was required.
 */
export const CURRENT_VERSION = 2;

/**
 * Typed error thrown when a data file exists but cannot be read as valid data
 * (Req 19.1, 19.2).
 *
 * Corrupt-file contract: the adapter never silently overwrites a malformed or
 * schema-invalid file. It instead throws this error, which the IPC layer can
 * detect (`instanceof StorageCorruptError`, or via the public `isStorage
 * CorruptError` marker) and translate into an `AppError` of code `"corrupt"`,
 * carrying `file` and `canRestoreBackup` to the renderer so it can offer a
 * "restore latest backup" action.
 *
 *   - `file`             — the affected file name (e.g. `subscriptions.json`).
 *   - `reason`           — `"malformed"` (not valid JSON) or `"corrupt"`
 *                          (valid JSON, failed schema validation).
 *   - `canRestoreBackup` — `true` only when a subscription backup is available
 *                          to restore from. Settings/categories have no backup
 *                          stream, so this is `false` for those files (the IPC
 *                          layer can offer "reset to defaults" instead).
 */
export class StorageCorruptError extends Error {
  /** Discriminator so non-`instanceof` consumers can still detect this error. */
  readonly isStorageCorruptError = true as const;
  readonly file: string;
  readonly reason: "malformed" | "corrupt";
  readonly canRestoreBackup: boolean;

  constructor(
    file: string,
    reason: "malformed" | "corrupt",
    canRestoreBackup: boolean,
  ) {
    super(
      `Data file "${file}" is ${reason} and was not modified. ` +
        (canRestoreBackup
          ? "A backup is available to restore from."
          : "No backup is available; it can be reset to defaults."),
    );
    this.name = "StorageCorruptError";
    this.file = file;
    this.reason = reason;
    this.canRestoreBackup = canRestoreBackup;
  }
}

/** Type guard for {@link StorageCorruptError} usable across module boundaries. */
export function isStorageCorruptError(
  err: unknown,
): err is StorageCorruptError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isStorageCorruptError?: unknown }).isStorageCorruptError === true
  );
}

/**
 * Typed, **recoverable** error thrown when a data file is missing *and* the
 * active data folder is a synced cloud path *and* there is evidence that real
 * data exists (a backup, or another data file is present) — the cloud-folder
 * safe-read guardrail (AD-31, Story 1.7).
 *
 * The scenario this exists to catch: the data folder is an iCloud / Dropbox /
 * Drive directory and one file (e.g. `subscriptions.json`) is *transiently*
 * absent mid-sync — the cloud client has not yet materialized it locally. The
 * ordinary recreate-on-missing behavior would silently stamp an empty-defaults
 * file over the gap and, when the sync completes, the user's real data is gone.
 * Instead the adapter refuses to recreate and surfaces THIS error so the IPC/UI
 * layer can offer **retry** (wait for sync) or **restore** (from a backup) rather
 * than establishing empty data.
 *
 * It is intentionally distinct from {@link StorageCorruptError}: the file is not
 * corrupt, it is *transiently gone*, and the recommended action is retry-then-
 * restore, not reset-to-defaults. It still carries `canRestoreBackup` in the same
 * shape so the existing IPC → `AppError` mapping can treat it uniformly.
 *
 *   - `file`             — the affected file name (e.g. `subscriptions.json`).
 *   - `dataDir`          — the active (cloud) data directory it was read from.
 *   - `canRestoreBackup` — `true` when a backup is available to restore from.
 *   - `recoverable`      — always `true`; a marker that retry is a valid action
 *                          (the absence may be transient), distinguishing this
 *                          from a hard corruption.
 */
export class StorageTransientMissingError extends Error {
  /** Discriminator so non-`instanceof` consumers can still detect this error. */
  readonly isStorageTransientMissingError = true as const;
  /** Always true: a transiently-missing file may reappear, so retry is valid. */
  readonly recoverable = true as const;
  readonly file: string;
  readonly dataDir: string;
  readonly canRestoreBackup: boolean;

  constructor(file: string, dataDir: string, canRestoreBackup: boolean) {
    super(
      // The absolute `dataDir` is intentionally kept OUT of the human-readable
      // message (it would leak an absolute path + OS username into UI/logs,
      // inconsistent with StorageCorruptError's bare-filename message). It is
      // retained as a field below for structured logging only.
      `Data file "${file}" is missing from the synced cloud folder. ` +
        "It may be mid-sync; it was NOT recreated with empty defaults. " +
        (canRestoreBackup
          ? "Retry once sync completes, or restore from a backup."
          : "Retry once sync completes."),
    );
    this.name = "StorageTransientMissingError";
    this.file = file;
    this.dataDir = dataDir;
    this.canRestoreBackup = canRestoreBackup;
  }
}

/** Type guard for {@link StorageTransientMissingError} across module boundaries. */
export function isStorageTransientMissingError(
  err: unknown,
): err is StorageTransientMissingError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isStorageTransientMissingError?: unknown })
      .isStorageTransientMissingError === true
  );
}

/**
 * Typed error thrown when a data file on disk carries a `version` **newer** than
 * the adapter's `current` (AD-15). A newer-than-supported file is never
 * downgrade-migrated and never overwritten — the adapter refuses the read and
 * leaves the file untouched on disk, so a future-version file written by a newer
 * app build cannot be silently clobbered with a downgraded shape.
 *
 *   - `file`         — the affected file name (e.g. `subscriptions.json`).
 *   - `fileVersion`  — the `version` found on disk.
 *   - `currentVersion` — the version this adapter supports.
 */
export class StorageNewerVersionError extends Error {
  /** Discriminator so non-`instanceof` consumers can still detect this error. */
  readonly isStorageNewerVersionError = true as const;
  readonly file: string;
  readonly fileVersion: number;
  readonly currentVersion: number;

  constructor(file: string, fileVersion: number, currentVersion: number) {
    super(
      `Data file "${file}" is version ${fileVersion}, newer than the supported ` +
        `version ${currentVersion}. It was not modified; upgrade the app to read it.`,
    );
    this.name = "StorageNewerVersionError";
    this.file = file;
    this.fileVersion = fileVersion;
    this.currentVersion = currentVersion;
  }
}

/** Type guard for {@link StorageNewerVersionError} across module boundaries. */
export function isStorageNewerVersionError(
  err: unknown,
): err is StorageNewerVersionError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isStorageNewerVersionError?: unknown })
      .isStorageNewerVersionError === true
  );
}

/**
 * Typed error thrown when a `< current` file was detected and a migration was
 * attempted but the migrate step or the post-migration validation failed
 * (AD-15). The original file is left untouched (no write-back occurred) and the
 * pre-migration backup — taken before the attempt — survives. The underlying
 * `MigrationError` / zod error is carried as `cause`.
 *
 *   - `file`           — the affected file name.
 *   - `fromVersion`    — the on-disk version the migration started from.
 *   - `currentVersion` — the version the migration targeted.
 */
export class StorageMigrationError extends Error {
  /** Discriminator so non-`instanceof` consumers can still detect this error. */
  readonly isStorageMigrationError = true as const;
  readonly file: string;
  readonly fromVersion: number;
  readonly currentVersion: number;

  constructor(
    file: string,
    fromVersion: number,
    currentVersion: number,
    cause?: unknown,
  ) {
    super(
      `Migrating data file "${file}" from version ${fromVersion} to ` +
        `${currentVersion} failed. The original file was not modified and a ` +
        `pre-migration backup was taken.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "StorageMigrationError";
    this.file = file;
    this.fromVersion = fromVersion;
    this.currentVersion = currentVersion;
  }
}

/** Type guard for {@link StorageMigrationError} across module boundaries. */
export function isStorageMigrationError(
  err: unknown,
): err is StorageMigrationError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isStorageMigrationError?: unknown }).isStorageMigrationError ===
      true
  );
}

/**
 * Local JSON file implementation of {@link StoragePort} for the Electron main
 * process.
 */
export class JsonFileStorage implements StoragePort {
  private readonly defaultUserData: string;
  private dataFolder: string | null;

  /**
   * The schema version this adapter treats as "current" for the migrate-before-
   * validate read path (AD-15). Production constructs the adapter at the default
   * {@link CURRENT_VERSION} (1 in Epic 1), so the live `== current` branch runs
   * and behavior is byte-identical to before. Tests inject `current = 2` to
   * exercise the `< current` migrate branch and the `> current` refuse branch
   * end-to-end against the Story 1.3 migrator and the v2 schemas, without
   * flipping the live constant (scope A: the running app never sees v2).
   */
  private readonly current: number;

  /**
   * The cloud-path predicate behind the AD-31 safe-read guardrail (Story 1.7).
   * It is consulted on a `missing` read: when `isCloudPath(this.dataDir)` is true
   * AND there is evidence of real data to protect, the adapter does NOT recreate
   * the file with empty defaults — it surfaces a {@link StorageTransientMissingError}
   * so the UI can offer retry/restore instead of silently establishing empty data.
   *
   * Injected like {@link current}, it **defaults to {@link defaultIsCloudPath}**
   * (`() => false`), so production is byte-identical to before this story — the
   * guardrail is dormant until PRD Q7 supplies a real per-OS detector behind this
   * exact seam. Tests drive it directly (true/false) to exercise the matrix. It
   * is a pure string predicate: no wall-clock, no network, no filesystem probe.
   */
  private readonly isCloudPath: CloudPathPredicate;

  /**
   * @param defaultUserData The platform `userData` directory (typically
   *                        `app.getPath('userData')`). Used whenever no data
   *                        folder override is configured (Req 1.1).
   * @param dataFolder      Optional initial data-folder override from
   *                        `settings.dataFolder` (Req 15.3). `null`/omitted
   *                        means "use the default".
   * @param current         The current schema version for the version-gated
   *                        read path (AD-15). Defaults to {@link CURRENT_VERSION}
   *                        (1 in Epic 1). Injectable so tests can drive the
   *                        migrate/refuse branches at `current = 2` without
   *                        touching the live constant.
   * @param isCloudPath     The cloud-path detection predicate behind the AD-31
   *                        guardrail. Defaults to {@link defaultIsCloudPath}
   *                        (`() => false`), keeping the guardrail dormant and
   *                        production behavior unchanged until PRD Q7 supplies a
   *                        real detector. Injectable so tests drive the guardrail
   *                        directly without a real detection heuristic.
   */
  constructor(
    defaultUserData: string,
    dataFolder: string | null = null,
    current: number = CURRENT_VERSION,
    isCloudPath: CloudPathPredicate = defaultIsCloudPath,
  ) {
    this.defaultUserData = defaultUserData;
    this.dataFolder = dataFolder;
    this.current = current;
    this.isCloudPath = isCloudPath;
  }

  // --- Path helpers ----------------------------------------------------------

  /** Resolve the active `App_Data_Directory` (override wins; Req 15.3). */
  private get dataDir(): string {
    return resolveDataDir(this.dataFolder, this.defaultUserData);
  }

  private get backupDir(): string {
    return join(this.dataDir, fileNames.backupDir);
  }

  private get subscriptionsPath(): string {
    return join(this.dataDir, fileNames.subscriptions);
  }

  private get settingsPath(): string {
    return join(this.dataDir, fileNames.settings);
  }

  private get categoriesPath(): string {
    return join(this.dataDir, fileNames.categories);
  }

  /**
   * Ensure the directory tree exists: create `App_Data_Directory` and the
   * `backup/` subdirectory if missing (Req 1.3, 1.4). Idempotent.
   */
  async ensureTree(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.backupDir, { recursive: true });
  }

  // --- Default file builders (Req 1.5, 19.3) ---------------------------------
  //
  // Recreate-on-missing stamps the adapter's own `current` version so a freshly
  // created file is already at the current version (its subsequent read takes
  // the `== current` branch, never a spurious migrate). In Epic 1 production
  // `current` is 1, so defaults are stamped `version: 1` exactly as before.

  private defaultSubscriptionsFile(): SubscriptionsFileV2 {
    // Stamp the adapter's own `current` version (as the settings/categories
    // default builders do) so a freshly recreated file is already at the
    // version the subsequent read validates against — never a spurious
    // migrate or a self-inflicted newer-than-current refusal.
    return { version: this.current as 2, subscriptions: [] };
  }

  private defaultSettingsFile(): SettingsV2 & { version: number } {
    // Match the default CONTENT to the adapter's `current`: a `current = 1`
    // adapter (today's live scope-A behavior / version-pinned test adapters)
    // recreates the v1-shaped defaults so the subsequent `== current` read
    // validates against the v1 schema; `current >= 2` recreates the v2 defaults.
    return this.current >= 2
      ? { version: this.current, ...DEFAULT_SETTINGS_V2 }
      : ({ version: this.current, ...DEFAULT_SETTINGS } as unknown as SettingsV2 & {
          version: number;
        });
  }

  private defaultCategoriesFile(): { version: number; categories: Category[] } {
    const categories: Category[] = DEFAULT_CATEGORIES.map((name) => ({
      id: randomUUID(),
      name,
      isDefault: true,
    }));
    return { version: this.current, categories };
  }

  // --- Cloud-path guardrail (AD-31) ------------------------------------------

  /**
   * Decide whether a `missing` file in the active data folder is a **transient
   * loss worth guarding** (there is evidence of real data to protect) versus a
   * **pristine folder** that should be allowed to initialize (AD-31, Story 1.7).
   *
   * This is the conservative transient-vs-pristine heuristic the spec mandates:
   * guard ONLY when there is positive evidence that real data exists, so a
   * genuine first-run in a cloud folder is never bricked. It returns `true`
   * (→ transient, guard) when EITHER
   *   - at least one backup exists in `backup/` (a backup is only ever written by
   *     a destructive/scheduled op on real data — it never appears during a
   *     pristine first-run), OR
   *   - a *sibling* record file (`subscriptions.json` or `categories.json`),
   *     other than the one being read, exists **and holds at least one record**.
   * Otherwise the folder has no backups and no populated record file, so the
   * vanished file is treated as a pristine first-run (→ `false`, allow init).
   *
   * **Why "populated record file", not "any sibling present":** first-run
   * initialization recreates the three data files one at a time, so after the
   * first is written the folder is no longer strictly empty. A naive "a sibling
   * file exists" check would make the *second* file's init look like a transient
   * loss and brick first-run. Keying on a non-empty record LIST sidesteps this:
   * a just-recreated `subscriptions.json`/`categories.json` holds an **empty**
   * list, and the default `settings.json` — though full of default keys — is
   * deliberately NOT consulted (it always has content, so it cannot discriminate
   * pristine-init from real data). An established user who lost a file mid-sync
   * will have backups and/or populated record files; a pristine first-run has
   * neither.
   *
   * The bias is deliberate (favor NOT destroying data): a record file that is
   * present but **unparseable / unreadable** is ambiguous, and ambiguity is
   * treated as evidence (it is on disk — possibly a mid-sync artifact of real
   * data — so it is not a pristine-folder signal) rather than waved through to an
   * empty-recreate. A false "transient" only costs the user a retry/restore
   * prompt; a false "pristine" silently loses data.
   *
   * @param missingFileName The file that came back `missing` — excluded from the
   *                        sibling scan so its own absence does not count.
   */
  private async hasEvidenceOfRealData(
    missingFileName: string,
  ): Promise<boolean> {
    // Evidence #1: any backup present. Backups never exist on a pristine
    // first-run, so a single backup is unambiguous evidence of real prior data.
    if ((await this.listBackups()).length > 0) {
      return true;
    }
    // Evidence #2: any OTHER record file (subscriptions/categories) that holds at
    // least one record. `settings.json` is intentionally excluded — its default
    // form is non-empty, so it cannot distinguish pristine-init from real data.
    const recordFiles = [fileNames.subscriptions, fileNames.categories].filter(
      (name) => name !== missingFileName,
    );
    for (const name of recordFiles) {
      if (await this.recordFileIsPopulated(name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Read a sibling record file and decide whether it holds **at least one
   * record** (AD-31 evidence check) versus being absent or a freshly-stamped
   * empty-defaults file written moments ago by first-run init.
   *
   * Returns `false` for an absent file and for a file whose record list is empty.
   * Returns `true` for a populated list. A present-but-unreadable/unparseable
   * file is treated as `true` (ambiguous → favor guarding, per the conservative
   * bias): it is on disk, so it is not a pristine-folder signal.
   */
  private async recordFileIsPopulated(fileName: string): Promise<boolean> {
    const result = await safeReadJson<unknown>(
      join(this.dataDir, fileName),
      (data) => data,
    );
    if (!result.ok) {
      // `missing` → no evidence from this sibling. `malformed` (present but not
      // valid JSON / unreadable) → ambiguous, treat as evidence (not pristine).
      return result.reason !== "missing";
    }
    const value = result.value;
    if (typeof value !== "object" || value === null) {
      return true; // present with an odd shape → ambiguous → evidence.
    }
    const obj = value as Record<string, unknown>;
    const list = Array.isArray(obj.subscriptions)
      ? obj.subscriptions
      : Array.isArray(obj.categories)
        ? obj.categories
        : null;
    if (list === null) {
      // Present record file with neither list key → odd shape → evidence.
      return true;
    }
    return list.length > 0;
  }

  /**
   * The single source of the AD-31 guardrail rule (Story 1.7), called by every
   * recreate-on-missing site so the rule lives in exactly one place.
   *
   * When the active data folder is a synced cloud path AND there is evidence of
   * real data to protect, a `missing` read is a MID-SYNC transient loss: this
   * throws {@link StorageTransientMissingError} so the caller does NOT recreate
   * the file with empty defaults (which would clobber the user's real data once
   * sync completes). Otherwise it returns normally and the caller proceeds with
   * ordinary recreate-on-missing.
   *
   * **`settings.json` is exempt and never reaches this helper** — see the call
   * sites. Settings has no backup stream, so a guarded (retry-only) settings loss
   * could never self-heal; it must always recreate-on-missing. Only files with a
   * recovery path (subscriptions: restore-from-backup; categories: reset) are
   * guarded.
   *
   * Inert under the default `isCloudPath` predicate (`() => false`): the first
   * clause short-circuits, `hasEvidenceOfRealData` is never called, and behavior
   * is byte-identical to before this story.
   *
   * @param fileName         The file that came back `missing`.
   * @param canRestoreBackup Whether a backup is available to restore from —
   *                         carried onto the error so the UI can offer restore.
   */
  private async guardTransientMissingInCloud(
    fileName: string,
    canRestoreBackup: boolean,
  ): Promise<void> {
    if (
      this.isCloudPath(this.dataDir) &&
      (await this.hasEvidenceOfRealData(fileName))
    ) {
      throw new StorageTransientMissingError(
        fileName,
        this.dataDir,
        canRestoreBackup,
      );
    }
  }

  // --- Version-gated read path (AD-15) ---------------------------------------

  /**
   * The migrate-before-validate read path (AD-15 / FR-29) for a versioned data
   * file, parameterized per file. It detects the on-disk `version` and branches:
   *
   *   - `missing`      → normally recreate defaults at `current` and return them
   *                      (the existing recreate-on-missing behavior; Req 1.5,
   *                      19.3). **AD-31 cloud guardrail (Story 1.7):** when the
   *                      active data folder is a cloud path AND there is evidence
   *                      of real data (a backup, or a sibling data file), the file
   *                      is treated as *transiently* missing mid-sync and is NOT
   *                      recreated-empty — a {@link StorageTransientMissingError}
   *                      is surfaced instead. A pristine cloud folder (no data, no
   *                      backups) still initializes normally.
   *   - `< current`    → take a **pre-migration backup** (AD-16, before any
   *                      write-back), run the pure `core/migrations.migrate`,
   *                      **validate** the result against the current-version
   *                      schema, **atomically write it back**, and return it. A
   *                      migrate/validate failure surfaces a typed error and the
   *                      original file is left untouched (no write-back happened
   *                      and the pre-migration backup survives).
   *   - `== current`   → validate against the current-version schema and return
   *                      as-is with **no** write-back (the common/live case).
   *   - `> current`    → **refuse** with {@link StorageNewerVersionError}; the
   *                      file is left untouched on disk (never downgrade-
   *                      overwrite).
   *
   * A file whose `version` is *older* than current is therefore never classified
   * `corrupt` — it is migrated. `corrupt`/`malformed` classification still
   * applies to genuinely bad bytes/shape at the *target* (current) version.
   *
   * The migrator stays pure: this adapter owns all I/O (the backup, the
   * validate, the atomic write-back). The `migrateFile` callback adapts the
   * variadic `core/migrations.migrate` overloads to a single typed call per file
   * so the pure migrator is unaware of storage.
   *
   * @param config Per-file read configuration.
   * @returns The validated current-version file object.
   */
  private async readVersioned<TCurrent extends { version: number }>(config: {
    path: string;
    fileName: string;
    /** Validate a parsed object against the **current-version** schema. */
    validateCurrent: (data: unknown) => TCurrent;
    /** Build the default file (stamped at `current`) when the file is missing. */
    buildDefaults: () => TCurrent;
    /** Migrate a parsed older-version object to the current version (pure). */
    migrateFile: (data: Record<string, unknown>, fromVersion: number) => TCurrent;
    /**
     * Take a pre-migration backup of the **raw** (pre-migration) parsed file,
     * before any migrate/write-back (AD-16). Omit for files without a backup
     * stream (settings/categories).
     */
    preMigrationBackup?: (raw: Record<string, unknown>) => Promise<void>;
    /** Resolve `canRestoreBackup` for a corrupt/malformed classification. */
    canRestoreBackup: () => Promise<boolean>;
    /**
     * Apply the AD-31 cloud guardrail to a `missing` read of this file (Story
     * 1.7). Set only for files with a recovery path (subscriptions). Omitted/
     * `false` for settings so it always recreate-on-missing — a guarded settings
     * loss (no backup stream) would be an unrecoverable retry-only dead-end.
     */
    guardMissingInCloud?: boolean;
  }): Promise<TCurrent> {
    await this.ensureTree();

    const detected = await safeReadVersionedJson(config.path);

    if (!detected.ok) {
      if (detected.reason === "missing") {
        // AD-31 cloud guardrail (Story 1.7), applied via the single shared rule.
        // Only files flagged `guardMissingInCloud` (those with a recovery path,
        // e.g. subscriptions) are guarded; settings opts OUT so it can always
        // recreate-on-missing (it has no backup stream to recover from). A
        // PRISTINE cloud folder still falls through to normal init. Inert under
        // the default `() => false` predicate.
        if (config.guardMissingInCloud === true) {
          await this.guardTransientMissingInCloud(
            config.fileName,
            await config.canRestoreBackup(),
          );
        }
        // Recreate-on-missing (Req 1.5, 19.3). Guard the write: a disk error
        // here must surface as a typed storage error, not crash a read that must
        // never throw (Req 19). "malformed" is the least-surprising mapping — the
        // adapter could not establish a valid data file at this path.
        const defaults = config.buildDefaults();
        try {
          await writeJsonAtomic(config.path, defaults);
        } catch {
          throw new StorageCorruptError(
            config.fileName,
            "malformed",
            await config.canRestoreBackup(),
          );
        }
        return defaults;
      }
      // malformed: not valid JSON / not an object / no usable version. Do not
      // overwrite; surface a restorable error (Req 19.1).
      throw new StorageCorruptError(
        config.fileName,
        detected.reason,
        await config.canRestoreBackup(),
      );
    }

    const { value, version } = detected;

    // `> current`: refuse, never downgrade-overwrite (file left untouched).
    if (version > this.current) {
      throw new StorageNewerVersionError(config.fileName, version, this.current);
    }

    // `== current`: validate at the current version; return as-is, no write-back.
    if (version === this.current) {
      try {
        return config.validateCurrent(value);
      } catch {
        // Valid JSON but fails the current schema → corrupt. Do not overwrite.
        throw new StorageCorruptError(
          config.fileName,
          "corrupt",
          await config.canRestoreBackup(),
        );
      }
    }

    // `< current`: migrate-before-validate. Every step of this branch — the
    // pre-migration backup, the migrate, the validate, and the atomic
    // write-back — runs inside one error-guarded region so ANY failure surfaces
    // as a typed StorageMigrationError and a read never throws raw (Req 19). The
    // backup is still taken FIRST (AD-16), from the RAW pre-migration file, so
    // the original survives even if a later step fails and so a same-run backup
    // can never shadow it (collision-proof naming is Story 1.5). Because write-
    // back is the last step, a failure before it means the original file is
    // untouched on disk.
    try {
      if (config.preMigrationBackup !== undefined) {
        await config.preMigrationBackup(value);
      }
      const result = config.migrateFile(value, version);
      // Validate the migrated result against the current-version schema before
      // trusting it. The migrator already validates internally, but re-asserting
      // here keeps the adapter's "only ever write back a schema-valid file"
      // guarantee independent of the migrator.
      const migrated = config.validateCurrent(result);
      // Atomic write-back of the validated, migrated file.
      await writeJsonAtomic(config.path, migrated);
      return migrated;
    } catch (err) {
      // Any failure in the <current branch: the original file is untouched (the
      // write-back is the last step and did not complete) and the pre-migration
      // backup exists. Surface a typed error rather than crashing the read.
      if (isStorageCorruptError(err) || isStorageNewerVersionError(err)) {
        throw err;
      }
      throw new StorageMigrationError(config.fileName, version, this.current, err);
    }
  }

  // --- Subscriptions ---------------------------------------------------------

  async readSubscriptions(): Promise<SubscriptionV2[]> {
    const file = await this.readVersioned<SubscriptionsFileV2>({
      path: this.subscriptionsPath,
      fileName: fileNames.subscriptions,
      // The live app is v2 (`current = 2`): validate with the v2 schema. A test
      // adapter pinned to `current = 1` still validates with the v1 schema.
      validateCurrent: (data) =>
        this.current >= 2
          ? subscriptionsFileV2Schema.parse(data)
          : (subscriptionsFileSchema.parse(data) as unknown as SubscriptionsFileV2),
      buildDefaults: () => this.defaultSubscriptionsFile(),
      migrateFile: (data, fromVersion) =>
        migrate(
          data as unknown as Parameters<typeof migrate>[0],
          fromVersion,
        ) as unknown as SubscriptionsFileV2,
      // Pre-migration backup of the RAW v1 file (AD-16). `assembleBackupPayload`
      // preserves the file's own `version`, so the backup is a faithful v1
      // snapshot — never a re-migrated one.
      preMigrationBackup: async (raw) => {
        await this.writeBackupPayload(
          assembleBackupPayload(raw as unknown as SubscriptionsFileV2),
        );
      },
      canRestoreBackup: async () => (await this.listBackups()).length > 0,
      // AD-31 cloud guardrail applies to subscriptions: it has a recovery path
      // (restore-from-backup), so a mid-sync transient loss is recoverable.
      guardMissingInCloud: true,
    });
    return file.subscriptions;
  }

  async writeSubscriptions(subs: SubscriptionV2[]): Promise<void> {
    await this.ensureTree();
    // Stamp the adapter's own `current` — the single version source the read
    // gate and the default-builders also use — so flipping CURRENT_VERSION (or
    // injecting a different `current`) is a genuine one-source change and a
    // write-then-read round-trips at that version with no spurious re-migrate.
    const file: SubscriptionsFileV2 = {
      version: this.current as 2,
      subscriptions: subs,
    };
    await writeJsonAtomic(this.subscriptionsPath, file);
  }

  // --- Settings --------------------------------------------------------------

  async readSettings(): Promise<SettingsV2> {
    // SettingsFileV2 structurally satisfies SettingsV2 (the extra `version` is
    // benign and rewritten on the next write).
    const file = await this.readVersioned<SettingsFileV2>({
      path: this.settingsPath,
      fileName: fileNames.settings,
      validateCurrent: (data) =>
        this.current >= 2
          ? settingsFileV2Schema.parse(data)
          : (settingsFileSchema.parse(data) as unknown as SettingsFileV2),
      buildDefaults: () => this.defaultSettingsFile() as SettingsFileV2,
      migrateFile: (data, fromVersion) =>
        migrate(
          data as unknown as Parameters<typeof migrate>[0],
          fromVersion,
        ) as unknown as SettingsFileV2,
      // Settings has no backup stream, so no pre-migration backup is taken and a
      // corrupt classification is never restorable (reset-to-defaults instead).
      canRestoreBackup: async () => false,
    });
    return file;
  }

  async writeSettings(settings: SettingsV2): Promise<void> {
    await this.ensureTree();
    const file = { version: this.current, ...settings };
    await writeJsonAtomic(this.settingsPath, file);
  }

  // --- Categories ------------------------------------------------------------

  async readCategories(): Promise<Category[]> {
    await this.ensureTree();
    const result = await safeReadJson(
      this.categoriesPath,
      (data) => categoriesFileSchema.parse(data),
    );

    if (result.ok) {
      return result.value.categories;
    }
    if (result.reason === "missing") {
      // AD-31 cloud guardrail (Story 1.7) via the single shared rule. Categories
      // has no backup stream, so `canRestoreBackup` is false (retry/reset is the
      // recovery). Inert under the default `() => false` predicate.
      await this.guardTransientMissingInCloud(fileNames.categories, false);
      const defaults = this.defaultCategoriesFile();
      await writeJsonAtomic(this.categoriesPath, defaults);
      return defaults.categories;
    }
    throw new StorageCorruptError(fileNames.categories, result.reason, false);
  }

  async writeCategories(categories: Category[]): Promise<void> {
    await this.ensureTree();
    const file = { version: this.current, categories };
    await writeJsonAtomic(this.categoriesPath, file);
  }

  // --- Backups (Req 18.1, 18.2) ----------------------------------------------

  /**
   * Write the current subscriptions to a collision-proof backup file and return
   * its name (Req 18.1, AD-16).
   *
   * The `reason` argument is part of the port contract for caller intent
   * (e.g. "pre-delete", "pre-import", "pre-restore"); it is not currently
   * embedded in the payload and is reserved for future backup metadata.
   */
  async createBackup(_reason: string): Promise<string> {
    await this.ensureTree();
    const subs = await this.readSubscriptions();
    return this.writeBackupPayload(assembleBackupPayload(subs));
  }

  /**
   * Write an already-assembled backup payload to a **collision-proof,
   * never-overwrite** backup file and return the name (Req 18.1, AD-16). The
   * single low-level backup-write seam, shared by {@link createBackup} and the
   * migrate-before-validate pre-migration backup (Story 1.4). Separating this
   * from {@link createBackup} is what lets the pre-migration path back up the
   * **raw pre-migration file** directly instead of re-reading subscriptions
   * through the version-gated path — re-reading mid-migration would re-enter the
   * migrate branch and recurse.
   *
   * Collision-proof + never-overwrite (AD-16): the adapter is the one place that
   * reads the real clock and the monotonic counter (keeping the pure
   * `core/backupFileName` free of `Date.now()`/entropy per AD-1). It stamps the
   * name with `new Date()` plus an injected, ever-increasing `seq`, so two
   * backups taken in the same clock-minute — even the same millisecond — get
   * distinct, prefix-sortable names. The pre-migration safety backup from Story
   * 1.4 can therefore never be clobbered by a same-minute scheduled or
   * pre-destructive backup. On top of the unique name, the write uses an
   * **exclusive** placement ({@link writeJsonExclusive}): if the resolved path
   * somehow already exists, it bumps `seq` and retries rather than overwriting;
   * only after exhausting a bounded number of attempts does it fail loudly —
   * never a silent clobber.
   *
   * The disambiguating `seq` is **loop-local** and reset per captured instant: it
   * starts at 0 for each `writeBackupPayload` call and only needs to distinguish
   * backups that resolve to the *same* `now` millisecond (the retry path). It is
   * never an accumulating instance counter — that would eventually exceed the
   * 4-digit `seq` segment (`...-9999.json` vs `...-10000.json` sorts WRONG because
   * `'1' < '9'`). Scoping `seq` to a single same-instant burst keeps the segment
   * width-stable (≤ `MAX_ATTEMPTS` ≪ 10000) and sort-correct.
   */
  private async writeBackupPayload(payload: {
    version: number;
    subscriptions: unknown[];
  }): Promise<string> {
    await this.ensureTree();

    // Read the clock once per backup; sub-minute precision (seconds + millis)
    // disambiguates across milliseconds, and the loop-local `seq` disambiguates
    // within one millisecond.
    const now = new Date();

    // A small retry budget: in practice the first attempt always succeeds. The
    // loop only matters when a resolved name is somehow already on disk (a
    // pre-existing file). `seq` resets to 0 here and increments only on a
    // collision, so it stays well under the 4-digit cap (10000) and the name
    // segment never widens. Bounding the loop keeps a never-overwrite failure
    // *loud* instead of spinning forever.
    const MAX_ATTEMPTS = 1000;
    let lastName = "";
    for (let seq = 0; seq < MAX_ATTEMPTS; seq += 1) {
      const name = backupFileName(now, { seq });
      lastName = name;
      try {
        await writeJsonExclusive(join(this.backupDir, name), payload);
        return name;
      } catch (err) {
        // The resolved name already existed: bump `seq` (loop increment) and
        // retry with a fresh name. Any other write error is a genuine I/O fault
        // and propagates.
        if (isFileExistsError(err)) {
          continue;
        }
        throw err;
      }
    }

    // Exhausted the retry budget without finding a free name: fail loudly rather
    // than overwrite an existing backup (AD-16 "never silently clobber"). Name
    // the directory and the last attempted file so the failure is diagnostic.
    throw new Error(
      `Could not write a collision-free backup in "${this.backupDir}" after ` +
        `${MAX_ATTEMPTS} attempts (last tried "${lastName}", seq ` +
        `${MAX_ATTEMPTS - 1}); the backup directory may be in an unexpected state.`,
    );
  }

  /**
   * List backup file names (`.json` only) newest-first (Req 18.2). Because the
   * names are zero-padded timestamps, descending lexicographic order is also
   * descending chronological order.
   */
  async listBackups(): Promise<string[]> {
    await this.ensureTree();
    let entries: string[];
    try {
      entries = await readdir(this.backupDir);
    } catch {
      // Directory unreadable/absent despite ensureTree: treat as empty rather
      // than crash (Req 19).
      return [];
    }
    return entries
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort((a, b) => b.localeCompare(a));
  }

  /**
   * Read and validate a backup file, returning its {@link SubscriptionsFile}
   * (Req 18.2). The name is reduced to its base name to prevent path traversal
   * outside the `backup/` directory.
   */
  async readBackup(name: string): Promise<SubscriptionsFileV2> {
    await this.ensureTree();
    const safeName = basename(name);
    const file = join(this.backupDir, safeName);
    // A backup may be a v2 snapshot (the live format) OR a v1 snapshot — the
    // pre-migration backup is a faithful RAW v1 file (AD-16), and legacy backups
    // predate the cutover. Accept EITHER shape so a round-trip stays valid and a
    // pre-migration v1 backup still reads back as its untouched v1 version; the
    // caller's write-back re-stamps at the current version. The parsed value is
    // typed as the port's `SubscriptionsFileV2` (its structural subset is enough
    // for `restoreBackup`, which reads only `version` + `subscriptions`).
    const result = await safeReadJson(file, (data) => {
      const v2 = subscriptionsFileV2Schema.safeParse(data);
      if (v2.success) return v2.data as unknown as SubscriptionsFileV2;
      return subscriptionsFileSchema.parse(data) as unknown as SubscriptionsFileV2;
    });

    if (result.ok) {
      return result.value;
    }
    if (result.reason === "missing") {
      throw new Error(`Backup not found: ${safeName}`);
    }
    // A corrupt backup cannot itself be restored from another backup.
    throw new StorageCorruptError(safeName, result.reason, false);
  }

  // --- Data folder (Req 15.3) ------------------------------------------------

  /** Return the resolved active data directory. */
  getDataFolder(): string {
    return this.dataDir;
  }

  /**
   * Update the data-folder override and ensure the tree exists at the new
   * location so subsequent file operations target it (Req 15.3). Passing
   * `null` reverts to the default `userData` directory.
   */
  async setDataFolder(path: string | null): Promise<void> {
    this.dataFolder = path;
    await this.ensureTree();
  }
}
