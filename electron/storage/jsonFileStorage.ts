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
  settingsFileSchema,
  settingsFileV2Schema,
  subscriptionsFileSchema,
  subscriptionsFileV2Schema,
} from "core/models/schema";
import { assembleBackupPayload, backupFileName } from "core/backup";
import { migrate } from "core/migrations";
import type { Category } from "core/models/category";
import type { Settings, SettingsFile } from "core/models/settings";
import type {
  Subscription,
  SubscriptionsFile,
} from "core/models/subscription";
import type { StoragePort } from "core/ports/storagePort";

import { fileNames, resolveDataDir } from "./paths";
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
 * Epic-1 compatibility window (scope A): this stays **1**. The running app still
 * reads/writes v1 files; v1↔v2 coexist until Epic 3 makes the app v2-aware. The
 * version-gated read path below is built and fully tested now (including the
 * v1→v2 migrate branch, exercised in tests against a synthetic lower `current`),
 * so FR-29 is proven-ready. Epic 3 activates live migration by flipping this one
 * constant to 2 — no other change in the gating logic is required (AD-15).
 */
export const CURRENT_VERSION = 1;

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
   */
  constructor(
    defaultUserData: string,
    dataFolder: string | null = null,
    current: number = CURRENT_VERSION,
  ) {
    this.defaultUserData = defaultUserData;
    this.dataFolder = dataFolder;
    this.current = current;
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

  private defaultSubscriptionsFile(): SubscriptionsFile {
    return { version: this.current, subscriptions: [] };
  }

  private defaultSettingsFile(): Settings & { version: number } {
    return { version: this.current, ...DEFAULT_SETTINGS };
  }

  private defaultCategoriesFile(): { version: number; categories: Category[] } {
    const categories: Category[] = DEFAULT_CATEGORIES.map((name) => ({
      id: randomUUID(),
      name,
      isDefault: true,
    }));
    return { version: this.current, categories };
  }

  // --- Version-gated read path (AD-15) ---------------------------------------

  /**
   * The migrate-before-validate read path (AD-15 / FR-29) for a versioned data
   * file, parameterized per file. It detects the on-disk `version` and branches:
   *
   *   - `missing`      → recreate defaults at `current` and return them (the
   *                      existing recreate-on-missing behavior; Req 1.5, 19.3).
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
  }): Promise<TCurrent> {
    await this.ensureTree();

    const detected = await safeReadVersionedJson(config.path);

    if (!detected.ok) {
      if (detected.reason === "missing") {
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

  async readSubscriptions(): Promise<Subscription[]> {
    const file = await this.readVersioned<SubscriptionsFile>({
      path: this.subscriptionsPath,
      fileName: fileNames.subscriptions,
      // At the current version the live app validates with the v1 schema; a
      // `current = 2` adapter (tests / Epic 3) validates with the v2 schema.
      validateCurrent: (data) =>
        this.current >= 2
          ? (subscriptionsFileV2Schema.parse(data) as unknown as SubscriptionsFile)
          : subscriptionsFileSchema.parse(data),
      buildDefaults: () => this.defaultSubscriptionsFile(),
      migrateFile: (data, fromVersion) =>
        migrate(
          data as unknown as SubscriptionsFile,
          fromVersion,
        ) as unknown as SubscriptionsFile,
      // Pre-migration backup of the RAW v1 file (AD-16). `assembleBackupPayload`
      // preserves the file's own `version`, so the backup is a faithful v1
      // snapshot — never a re-migrated one.
      preMigrationBackup: async (raw) => {
        await this.writeBackupPayload(
          assembleBackupPayload(raw as unknown as SubscriptionsFile),
        );
      },
      canRestoreBackup: async () => (await this.listBackups()).length > 0,
    });
    return file.subscriptions;
  }

  async writeSubscriptions(subs: Subscription[]): Promise<void> {
    await this.ensureTree();
    // Stamp the adapter's own `current` — the single version source the read
    // gate and the default-builders also use — so flipping CURRENT_VERSION (or
    // injecting a different `current`) is a genuine one-source change and a
    // write-then-read round-trips at that version with no spurious re-migrate.
    const file: SubscriptionsFile = {
      version: this.current,
      subscriptions: subs,
    };
    await writeJsonAtomic(this.subscriptionsPath, file);
  }

  // --- Settings --------------------------------------------------------------

  async readSettings(): Promise<Settings> {
    // SettingsFile structurally satisfies Settings (the extra `version` is
    // benign and rewritten on the next write).
    const file = await this.readVersioned<SettingsFile>({
      path: this.settingsPath,
      fileName: fileNames.settings,
      validateCurrent: (data) =>
        this.current >= 2
          ? (settingsFileV2Schema.parse(data) as unknown as SettingsFile)
          : settingsFileSchema.parse(data),
      buildDefaults: () => this.defaultSettingsFile(),
      migrateFile: (data, fromVersion) =>
        migrate(
          data as unknown as SettingsFile,
          fromVersion,
        ) as unknown as SettingsFile,
      // Settings has no backup stream, so no pre-migration backup is taken and a
      // corrupt classification is never restorable (reset-to-defaults instead).
      canRestoreBackup: async () => false,
    });
    return file;
  }

  async writeSettings(settings: Settings): Promise<void> {
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
  private async writeBackupPayload(payload: SubscriptionsFile): Promise<string> {
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
  async readBackup(name: string): Promise<SubscriptionsFile> {
    await this.ensureTree();
    const safeName = basename(name);
    const file = join(this.backupDir, safeName);
    const result = await safeReadJson(
      file,
      (data) => subscriptionsFileSchema.parse(data),
    );

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
