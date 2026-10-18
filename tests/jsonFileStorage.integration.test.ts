import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonFileStorage,
  StorageCorruptError,
  StorageNewerVersionError,
  isStorageCorruptError,
} from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_CATEGORY_COLORS,
  DEFAULT_SETTINGS,
} from "core/models/schema";
import type { Subscription, SubscriptionV2 } from "core/models/subscription";

/**
 * Integration tests for storage bootstrap (Task 12.2).
 *
 * Exercises `JsonFileStorage` against a real, fresh temporary `userData`
 * directory (created via `os.tmpdir()` + `fs.mkdtemp`, removed afterEach) so
 * the directory-tree creation, lazy default-file creation, corrupt-file
 * recovery offers, and backup round-trip are all verified end-to-end on disk.
 *
 * Requirements covered:
 *   - 1.4  : App_Data_Directory and required files auto-created on start.
 *   - 1.5  : Missing required files created with valid default content.
 *   - 19.2 : Corrupt data file offers restore (canRestoreBackup) when possible.
 *   - 19.3 : Missing file recreated with valid defaults.
 */

/** True when a path exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when a path exists and is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Build a complete, schema-valid subscription for backup round-trip tests. */
function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amount: 499,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#E50914",
    icon: "netflix",
    isActive: true,
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a complete, schema-valid v2 subscription (Story 7.4 round-trip). */
function makeV2Subscription(
  overrides: Partial<SubscriptionV2> = {},
): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMinor: 49900,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#E50914",
    icon: "netflix",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let userData: string;
let storage: JsonFileStorage;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-storage-"));
  storage = new JsonFileStorage(userData, null, 1);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("JsonFileStorage bootstrap (Req 1.4, 1.5, 19.3)", () => {
  it("creates the App_Data_Directory and backup/ subdir on first read (Req 1.4)", async () => {
    await storage.readSubscriptions();

    expect(await isDirectory(userData)).toBe(true);
    expect(await isDirectory(join(userData, fileNames.backupDir))).toBe(true);
    expect(storage.getDataFolder()).toBe(userData);
  });

  it("lazily creates the missing JSON files initialized with valid defaults (Req 1.5, 19.3)", async () => {
    const subs = await storage.readSubscriptions();
    const settings = await storage.readSettings();
    const categories = await storage.readCategories();

    // subscriptions: empty array
    expect(subs).toEqual([]);

    // settings: DEFAULT_SETTINGS (the on-disk file additionally carries a version field)
    expect(settings).toMatchObject(DEFAULT_SETTINGS);

    // categories: the 11 DEFAULT_CATEGORIES, each marked isDefault: true
    expect(categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(categories.map((c) => c.name)).toEqual([...DEFAULT_CATEGORIES]);
    expect(categories.every((c) => c.isDefault === true)).toBe(true);

    // The files now exist on disk.
    expect(await isFile(join(userData, fileNames.subscriptions))).toBe(true);
    expect(await isFile(join(userData, fileNames.settings))).toBe(true);
    expect(await isFile(join(userData, fileNames.categories))).toBe(true);
  });

  it("re-reading after bootstrap returns the same defaults (Req 1.5)", async () => {
    const subs1 = await storage.readSubscriptions();
    const settings1 = await storage.readSettings();
    const cats1 = await storage.readCategories();

    const subs2 = await storage.readSubscriptions();
    const settings2 = await storage.readSettings();
    const cats2 = await storage.readCategories();

    expect(subs2).toEqual(subs1);
    expect(settings2).toEqual(settings1);
    expect(cats2).toEqual(cats1);
  });

  it("recreates a deleted file with defaults on the next read (Req 19.3)", async () => {
    // Bootstrap creates all three files.
    await storage.readSubscriptions();
    await storage.readSettings();
    await storage.readCategories();

    const subsPath = join(userData, fileNames.subscriptions);
    await rm(subsPath);
    expect(await isFile(subsPath)).toBe(false);

    // Reading recreates it with valid defaults.
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
    expect(await isFile(subsPath)).toBe(true);
  });
});

describe("JsonFileStorage category color one-time seed/backfill (Story 3.4)", () => {
  const catPath = () => join(userData, fileNames.categories);

  /** Read the raw categories file off disk. */
  async function readRawCategoriesFile(): Promise<{
    version: number;
    colorsSeeded?: boolean;
    categories: { name: string; color?: string }[];
  }> {
    return JSON.parse(await readFile(catPath(), "utf8"));
  }

  it("fresh install stamps the seeded palette colors AND colorsSeeded:true", async () => {
    const categories = await storage.readCategories();

    // Every default category now carries its seeded palette color.
    for (const name of DEFAULT_CATEGORIES) {
      const cat = categories.find((c) => c.name === name)!;
      expect(cat.color).toBe(DEFAULT_CATEGORY_COLORS[name]);
    }

    // The on-disk file is marked seeded so later reads never re-backfill.
    const raw = await readRawCategoriesFile();
    expect(raw.colorsSeeded).toBe(true);
  });

  it("backfills an unseeded colorless file ONCE, marks it seeded, and a second read writes nothing", async () => {
    // Simulate an upgrade: a pre-3.4 categories file with default names, NO
    // colors, and NO colorsSeeded marker.
    await writeFile(
      catPath(),
      JSON.stringify({
        version: 1,
        categories: [
          { id: "c1", name: "Streaming", isDefault: true },
          { id: "c2", name: "AI", isDefault: true },
          { id: "c3", name: "My Custom", isDefault: false },
        ],
      }),
      "utf8",
    );

    // First read backfills the default names and marks the file seeded.
    const first = await storage.readCategories();
    expect(first.find((c) => c.name === "Streaming")!.color).toBe(
      DEFAULT_CATEGORY_COLORS["Streaming"],
    );
    expect(first.find((c) => c.name === "AI")!.color).toBe(
      DEFAULT_CATEGORY_COLORS["AI"],
    );
    // The custom category is never touched.
    expect(first.find((c) => c.name === "My Custom")!.color).toBeUndefined();

    const afterFirst = await readRawCategoriesFile();
    expect(afterFirst.colorsSeeded).toBe(true);

    // The second read must NOT write (steady state): capture the file's mtime
    // and confirm it is unchanged across the read.
    const mtimeBefore = (await stat(catPath())).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const second = await storage.readCategories();
    const mtimeAfter = (await stat(catPath())).mtimeMs;

    expect(mtimeAfter).toBe(mtimeBefore);
    expect(second).toEqual(first);
  });

  it("a user-CLEARED default color on a colorsSeeded:true file STAYS cleared (seed never resurrects — finding A)", async () => {
    // A seeded file where a default-named category ("Streaming") has NO color —
    // i.e. the user deliberately cleared it after the one-time seed.
    await writeFile(
      catPath(),
      JSON.stringify({
        version: 1,
        colorsSeeded: true,
        categories: [
          { id: "c1", name: "Streaming", isDefault: true }, // cleared, no color
          { id: "c2", name: "AI", isDefault: true, color: "#059669" },
        ],
      }),
      "utf8",
    );

    const mtimeBefore = (await stat(catPath())).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const categories = await storage.readCategories();
    const mtimeAfter = (await stat(catPath())).mtimeMs;

    // The cleared default is returned STILL colorless (the seed did not refill
    // it), and no write-back occurred.
    expect(categories.find((c) => c.name === "Streaming")!.color).toBeUndefined();
    expect(categories.find((c) => c.name === "AI")!.color).toBe("#059669");
    expect(mtimeAfter).toBe(mtimeBefore);

    // On disk, Streaming is still colorless.
    const raw = await readRawCategoriesFile();
    expect(raw.categories.find((c) => c.name === "Streaming")!.color).toBeUndefined();
  });

  it("writeCategories keeps colorsSeeded:true sticky", async () => {
    await storage.readCategories(); // seeds
    await storage.writeCategories([
      { id: "c1", name: "Streaming", isDefault: true },
    ]);
    const raw = await readRawCategoriesFile();
    expect(raw.colorsSeeded).toBe(true);
  });
});

describe("JsonFileStorage corrupt-file recovery (Req 19.2)", () => {
  it("throws StorageCorruptError for a malformed subscriptions.json with canRestoreBackup=true when a backup exists", async () => {
    // Bootstrap valid data, then create a backup so a restore is possible.
    await storage.readSubscriptions();
    await storage.createBackup("test");
    expect((await storage.listBackups()).length).toBeGreaterThan(0);

    // Corrupt the subscriptions file with malformed JSON.
    await writeFile(join(userData, fileNames.subscriptions), "{not json", "utf8");

    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }

    expect(isStorageCorruptError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(StorageCorruptError);
    const error = caught as StorageCorruptError;
    expect(error.file).toBe("subscriptions.json");
    expect(error.canRestoreBackup).toBe(true);
  });

  it("reports canRestoreBackup=false for a malformed subscriptions.json when no backup exists", async () => {
    await writeFile(join(userData, fileNames.subscriptions), "{not json", "utf8");

    await expect(storage.readSubscriptions()).rejects.toSatisfy(
      (err) =>
        isStorageCorruptError(err) &&
        (err as StorageCorruptError).file === "subscriptions.json" &&
        (err as StorageCorruptError).canRestoreBackup === false,
    );
  });

  it("throws StorageCorruptError for corrupt settings.json with canRestoreBackup=false (Req 19.2)", async () => {
    // Even with a subscription backup present, settings has no backup stream.
    await storage.readSubscriptions();
    await storage.createBackup("test");

    await writeFile(join(userData, fileNames.settings), "{not json", "utf8");

    let caught: unknown;
    try {
      await storage.readSettings();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StorageCorruptError);
    const error = caught as StorageCorruptError;
    expect(error.file).toBe("settings.json");
    expect(error.canRestoreBackup).toBe(false);
  });

  it("throws StorageCorruptError for corrupt categories.json with canRestoreBackup=false (Req 19.2)", async () => {
    await storage.readSubscriptions();
    await storage.createBackup("test");

    // Valid JSON but failing the schema (wrong shape) -> corrupt.
    await writeFile(
      join(userData, fileNames.categories),
      JSON.stringify({ version: 1, categories: "not-an-array" }),
      "utf8",
    );

    let caught: unknown;
    try {
      await storage.readCategories();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StorageCorruptError);
    const error = caught as StorageCorruptError;
    expect(error.file).toBe("categories.json");
    expect(error.canRestoreBackup).toBe(false);
  });
});

describe("JsonFileStorage backup round-trip (Req 18.1, 18.2)", () => {
  it("writeSubscriptions -> createBackup -> listBackups -> readBackup reproduces the data", async () => {
    // Round-trip at the LIVE schema version (`current = 2`, as production runs):
    // genuine v2 records → `createBackup` stamps `version: 2` → the version-gated
    // `readBackup` (Story 7.4) takes the `== current` branch, validates with the
    // v2 schema, and returns the set unchanged. (A `current = 1` round-trip is
    // internally inconsistent — the bare-array `assembleBackupPayload` always
    // stamps the LIVE BACKUP_SCHEMA_VERSION (2) over the v1-shaped records — which
    // is exactly the mixed-shape the fixed `readBackup` now refuses to mis-read.)
    const v2Storage = new JsonFileStorage(userData, null, 2);
    const subs: SubscriptionV2[] = [
      makeV2Subscription({ id: "sub-1", name: "Netflix" }),
      makeV2Subscription({ id: "sub-2", name: "Spotify", category: "Music" }),
    ];
    await v2Storage.writeSubscriptions(subs);

    const backupName = await v2Storage.createBackup("test-backup");
    expect(backupName).toMatch(/\.json$/);

    const backups = await v2Storage.listBackups();
    expect(backups).toContain(backupName);

    const restored = await v2Storage.readBackup(backupName);
    expect(restored.version).toBe(2);
    expect(restored.subscriptions).toEqual(subs);
  });

  it("readBackup MIGRATES a v1 backup to v2 (migrate-on-restore) — no corruption (Story 7.4)", async () => {
    // Seed a genuine RAW v1 backup on disk (`version: 1` + a major `amount`) —
    // the data-corruption bug's trigger. Written directly rather than via
    // `createBackup`, whose bare-array `assembleBackupPayload` always stamps the
    // LIVE BACKUP_SCHEMA_VERSION (2); a true v1 pre-migration backup is a
    // version-preserving snapshot of a `{ version: 1, ... }` file.
    const migrator = new JsonFileStorage(userData, null, 2);
    await migrator.ensureTree();
    const v1BackupName = "2025-03-07-09-05-42-137-0000.json";
    await writeFile(
      join(userData, fileNames.backupDir, v1BackupName),
      JSON.stringify({
        version: 1,
        subscriptions: [
          makeSubscription({ id: "a", name: "Netflix", amount: 9.99, currency: "USD" }),
        ],
      }),
      "utf8",
    );
    // Confirm the on-disk backup is genuinely v1-shaped before reading it back.
    const rawBackup = JSON.parse(
      await readFile(join(userData, fileNames.backupDir, v1BackupName), "utf8"),
    ) as { version: number; subscriptions: Array<Record<string, unknown>> };
    expect(rawBackup.version).toBe(1);
    expect(rawBackup.subscriptions[0]).toMatchObject({ amount: 9.99 });

    // Read it through a `current = 2` adapter: `readBackup` runs it through the
    // REAL `core/migrations` path (v1 `amount: 9.99` USD → integer
    // `amountMinor: 999`) and returns a validated v2 file.
    const restored = await migrator.readBackup(v1BackupName);
    expect(restored.version).toBe(2);
    expect(restored.subscriptions).toHaveLength(1);
    expect(restored.subscriptions[0]).toMatchObject({
      id: "a",
      amountMinor: 999, // 9.99 USD (exp 2), via migrateSubscriptionsFileV1toV2
      currency: "USD",
      state: "Active",
    });

    // The migrated set is v2-schema-valid, so writing it back and re-reading it
    // succeeds (NOT corrupt) — the end-to-end no-corruption proof.
    await migrator.writeSubscriptions(restored.subscriptions);
    const reread = await migrator.readSubscriptions();
    expect(reread).toEqual(restored.subscriptions);
  });

  it("readBackup REFUSES a backup newer than current (Story 7.4)", async () => {
    const storage2 = new JsonFileStorage(userData, null, 2);
    await storage2.ensureTree();
    const name = "2030-01-01-00-00-00-000-0000.json";
    await writeFile(
      join(userData, fileNames.backupDir, name),
      JSON.stringify({ version: 3, subscriptions: [] }),
      "utf8",
    );
    await expect(storage2.readBackup(name)).rejects.toBeInstanceOf(
      StorageNewerVersionError,
    );
  });

  it("readBackup preserves the loud missing + corrupt failures (Story 7.4)", async () => {
    const storage2 = new JsonFileStorage(userData, null, 2);
    await storage2.ensureTree();
    // Missing → "Backup not found".
    await expect(storage2.readBackup("nope.json")).rejects.toThrow(
      /Backup not found/,
    );
    // Corrupt (malformed JSON) → StorageCorruptError.
    const corruptName = "2029-01-01-00-00-00-000-0000.json";
    await writeFile(
      join(userData, fileNames.backupDir, corruptName),
      "{not json",
      "utf8",
    );
    await expect(storage2.readBackup(corruptName)).rejects.toBeInstanceOf(
      StorageCorruptError,
    );
  });
});
