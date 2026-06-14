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
  subscriptionsFileSchema,
} from "core/models/schema";
import { assembleBackupPayload, backupFileName } from "core/backup";
import type { Category } from "core/models/category";
import type { Settings } from "core/models/settings";
import type {
  Subscription,
  SubscriptionsFile,
} from "core/models/subscription";
import type { StoragePort } from "core/ports/storagePort";

import { fileNames, resolveDataDir } from "./paths";
import { safeReadJson, writeJsonAtomic } from "./safeJson";

/**
 * On-disk schema version stamped into newly written files. Matches the
 * `version` field of the root file shapes validated in `core/models/schema`.
 */
const FILE_SCHEMA_VERSION = 1;

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
 * Local JSON file implementation of {@link StoragePort} for the Electron main
 * process.
 */
export class JsonFileStorage implements StoragePort {
  private readonly defaultUserData: string;
  private dataFolder: string | null;

  /**
   * @param defaultUserData The platform `userData` directory (typically
   *                        `app.getPath('userData')`). Used whenever no data
   *                        folder override is configured (Req 1.1).
   * @param dataFolder      Optional initial data-folder override from
   *                        `settings.dataFolder` (Req 15.3). `null`/omitted
   *                        means "use the default".
   */
  constructor(defaultUserData: string, dataFolder: string | null = null) {
    this.defaultUserData = defaultUserData;
    this.dataFolder = dataFolder;
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

  private defaultSubscriptionsFile(): SubscriptionsFile {
    return { version: FILE_SCHEMA_VERSION, subscriptions: [] };
  }

  private defaultSettingsFile(): Settings & { version: number } {
    return { version: FILE_SCHEMA_VERSION, ...DEFAULT_SETTINGS };
  }

  private defaultCategoriesFile(): { version: number; categories: Category[] } {
    const categories: Category[] = DEFAULT_CATEGORIES.map((name) => ({
      id: randomUUID(),
      name,
      isDefault: true,
    }));
    return { version: FILE_SCHEMA_VERSION, categories };
  }

  // --- Subscriptions ---------------------------------------------------------

  async readSubscriptions(): Promise<Subscription[]> {
    await this.ensureTree();
    const result = await safeReadJson(
      this.subscriptionsPath,
      (data) => subscriptionsFileSchema.parse(data),
    );

    if (result.ok) {
      return result.value.subscriptions;
    }
    if (result.reason === "missing") {
      // Lazily create with valid defaults and return them (Req 1.5, 19.3).
      const defaults = this.defaultSubscriptionsFile();
      await writeJsonAtomic(this.subscriptionsPath, defaults);
      return defaults.subscriptions;
    }
    // malformed/corrupt: do not overwrite; surface a restorable error (Req 19.1, 19.2).
    const canRestore = (await this.listBackups()).length > 0;
    throw new StorageCorruptError(
      fileNames.subscriptions,
      result.reason,
      canRestore,
    );
  }

  async writeSubscriptions(subs: Subscription[]): Promise<void> {
    await this.ensureTree();
    const file: SubscriptionsFile = {
      version: FILE_SCHEMA_VERSION,
      subscriptions: subs,
    };
    await writeJsonAtomic(this.subscriptionsPath, file);
  }

  // --- Settings --------------------------------------------------------------

  async readSettings(): Promise<Settings> {
    await this.ensureTree();
    const result = await safeReadJson(
      this.settingsPath,
      (data) => settingsFileSchema.parse(data),
    );

    if (result.ok) {
      // SettingsFile structurally satisfies Settings (extra `version` is benign
      // and is rewritten on the next write).
      return result.value;
    }
    if (result.reason === "missing") {
      const defaults = this.defaultSettingsFile();
      await writeJsonAtomic(this.settingsPath, defaults);
      return defaults;
    }
    // No settings backup stream exists, so a restore cannot recover settings.
    throw new StorageCorruptError(fileNames.settings, result.reason, false);
  }

  async writeSettings(settings: Settings): Promise<void> {
    await this.ensureTree();
    const file = { version: FILE_SCHEMA_VERSION, ...settings };
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
    const file = { version: FILE_SCHEMA_VERSION, categories };
    await writeJsonAtomic(this.categoriesPath, file);
  }

  // --- Backups (Req 18.1, 18.2) ----------------------------------------------

  /**
   * Write the current subscriptions to `backup/<YYYY-MM-DD-HH-MM>.json` and
   * return the backup file name (Req 18.1).
   *
   * The `reason` argument is part of the port contract for caller intent
   * (e.g. "pre-delete", "pre-import", "pre-restore"); it is not currently
   * embedded in the payload and is reserved for future backup metadata.
   */
  async createBackup(_reason: string): Promise<string> {
    await this.ensureTree();
    const subs = await this.readSubscriptions();
    const payload = assembleBackupPayload(subs);
    const name = backupFileName(new Date());
    await writeJsonAtomic(join(this.backupDir, name), payload);
    return name;
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
