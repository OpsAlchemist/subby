import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonFileStorage,
  StorageCorruptError,
  StorageMigrationError,
  StorageNewerVersionError,
  isStorageCorruptError,
  isStorageMigrationError,
  isStorageNewerVersionError,
} from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import { safeReadVersionedJson } from "../electron/storage/safeJson";
import { migrateSubscriptionV1toV2 } from "core/migrations";
import type { Subscription } from "core/models/subscription";
import type { Settings } from "core/models/settings";

/**
 * Integration tests for the migrate-before-validate version-gated read path
 * (Story 1.4 / AD-15 / FR-29).
 *
 * Every row of the story's I/O & Edge-Case Matrix is exercised against a real
 * temp directory, at BOTH a real `current = 1` (today's live behavior must be
 * byte-identical) AND a synthetic/injected `current = 2` (proving the
 * `< current` migrate-before-validate branch and the `> current` refuse branch
 * end-to-end against the Story 1.3 migrator and the v2 zod schemas).
 *
 * Scope A is honored: the live app constructs the adapter at `current = 1`, so
 * no live on-disk format change happens. Only tests inject `current = 2`.
 */

/** A complete, schema-valid v1 subscription. */
function v1Subscription(overrides: Partial<Subscription> = {}): Subscription {
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

/** A complete, schema-valid v1 settings object. */
function v1Settings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultCurrency: "INR",
    notification: { enabled: true, leadTimes: ["same-day", "one-day"] },
    backupFrequency: "weekly",
    theme: "dark",
    accentColor: "#7C5CFF",
    trayMode: false,
    dataFolder: null,
    ...overrides,
  };
}

/** Read a JSON file from the temp dir and return the parsed object. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-vergate-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

// --- safeReadVersionedJson seam (AD-15) --------------------------------------

describe("safeReadVersionedJson (version-detection seam)", () => {
  it("returns the parsed object + detected version for a well-formed versioned file", async () => {
    const path = join(userData, "x.json");
    await writeFile(path, JSON.stringify({ version: 2, subscriptions: [] }), "utf8");

    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(2);
      expect(result.value).toMatchObject({ version: 2, subscriptions: [] });
    }
  });

  it("classifies a missing file as 'missing' (never throws)", async () => {
    const result = await safeReadVersionedJson(join(userData, "nope.json"));
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("classifies non-JSON bytes as 'malformed' (never throws)", async () => {
    const path = join(userData, "bad.json");
    await writeFile(path, "{not json", "utf8");
    const result = await safeReadVersionedJson(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("classifies a JSON array / primitive / version-less object as 'malformed'", async () => {
    const arr = join(userData, "arr.json");
    await writeFile(arr, JSON.stringify([1, 2, 3]), "utf8");
    expect((await safeReadVersionedJson(arr)).ok).toBe(false);

    const prim = join(userData, "prim.json");
    await writeFile(prim, JSON.stringify(42), "utf8");
    expect((await safeReadVersionedJson(prim)).ok).toBe(false);

    const noVer = join(userData, "nover.json");
    await writeFile(noVer, JSON.stringify({ subscriptions: [] }), "utf8");
    expect((await safeReadVersionedJson(noVer)).ok).toBe(false);

    const badVer = join(userData, "badver.json");
    await writeFile(badVer, JSON.stringify({ version: "1", subscriptions: [] }), "utf8");
    expect((await safeReadVersionedJson(badVer)).ok).toBe(false);
  });
});

// --- current = 1 : today's behavior is preserved -----------------------------

describe("version gating at current = 1 (live scope-A behavior preserved)", () => {
  it("equal version: a v1 file validates and returns unchanged with NO write-back", async () => {
    const storage = new JsonFileStorage(userData); // default current = 1
    const subs = [v1Subscription({ id: "a" }), v1Subscription({ id: "b", isActive: false })];
    await storage.writeSubscriptions(subs);

    const subsPath = join(userData, fileNames.subscriptions);
    const before = await readFile(subsPath, "utf8");

    const read = await storage.readSubscriptions();
    expect(read).toEqual(subs);

    // No write-back: the file bytes are untouched.
    const after = await readFile(subsPath, "utf8");
    expect(after).toBe(before);
    // Still version 1 on disk.
    expect((await readJson(subsPath)).version).toBe(1);
  });

  it("equal version: a v1 settings file reads back unchanged, no write-back", async () => {
    const storage = new JsonFileStorage(userData);
    await storage.writeSettings(v1Settings());
    const settingsPath = join(userData, fileNames.settings);
    const before = await readFile(settingsPath, "utf8");

    const read = await storage.readSettings();
    expect(read).toMatchObject(v1Settings());
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("missing file: recreates defaults at version 1", async () => {
    const storage = new JsonFileStorage(userData);
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
    expect((await readJson(join(userData, fileNames.subscriptions))).version).toBe(1);
  });

  it("newer version: a v2 file against current = 1 is REFUSED and left untouched", async () => {
    const storage = new JsonFileStorage(userData);
    const subsPath = join(userData, fileNames.subscriptions);
    const v2File = { version: 2, subscriptions: [] };
    await writeFile(subsPath, JSON.stringify(v2File), "utf8");
    const before = await readFile(subsPath, "utf8");

    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageNewerVersionError);
    expect(isStorageNewerVersionError(caught)).toBe(true);
    const error = caught as StorageNewerVersionError;
    expect(error.file).toBe(fileNames.subscriptions);
    expect(error.fileVersion).toBe(2);
    expect(error.currentVersion).toBe(1);

    // File left untouched on disk (never downgrade-overwrite).
    expect(await readFile(subsPath, "utf8")).toBe(before);
  });

  it("malformed/corrupt at target: still a StorageCorruptError, not overwritten", async () => {
    const storage = new JsonFileStorage(userData);
    await storage.writeSubscriptions([v1Subscription()]);
    await storage.createBackup("test"); // so canRestoreBackup can be true

    const subsPath = join(userData, fileNames.subscriptions);
    await writeFile(subsPath, "{not json", "utf8");

    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }
    expect(isStorageCorruptError(caught)).toBe(true);
    const error = caught as StorageCorruptError;
    expect(error.file).toBe(fileNames.subscriptions);
    expect(error.canRestoreBackup).toBe(true);
    // Not overwritten.
    expect(await readFile(subsPath, "utf8")).toBe("{not json");
  });

  it("corrupt at target (valid JSON, bad shape at v1): StorageCorruptError", async () => {
    const storage = new JsonFileStorage(userData);
    const subsPath = join(userData, fileNames.subscriptions);
    // version 1, but subscriptions is the wrong type -> fails the v1 schema.
    await writeFile(subsPath, JSON.stringify({ version: 1, subscriptions: "nope" }), "utf8");

    await expect(storage.readSubscriptions()).rejects.toSatisfy(
      (err) =>
        isStorageCorruptError(err) &&
        (err as StorageCorruptError).reason === "corrupt",
    );
  });
});

// --- current = 2 : migrate-before-validate + refuse-newer end-to-end ---------

describe("version gating at injected current = 2 (migrate-before-validate)", () => {
  it("older version: v1 subscriptions -> pre-migration backup, migrate, validate v2, write back, return", async () => {
    // Write a v1 file via a current=1 adapter so the on-disk file is genuine v1.
    const writer = new JsonFileStorage(userData); // current = 1
    const v1Subs = [
      v1Subscription({ id: "a", amount: 499, currency: "INR", isActive: true }),
      v1Subscription({ id: "b", amount: 9.99, currency: "USD", isActive: false }),
    ];
    await writer.writeSubscriptions(v1Subs);

    const subsPath = join(userData, fileNames.subscriptions);
    const rawBeforeMigration = await readJson(subsPath);
    expect(rawBeforeMigration.version).toBe(1);

    // Now read through a current=2 adapter: the migrate branch runs.
    const migrator = new JsonFileStorage(userData, null, 2);
    const migratedSubs = (await migrator.readSubscriptions()) as unknown as Array<
      Record<string, unknown>
    >;

    // The returned subscriptions are v2-shaped and value-exact per the Story 1.3
    // migrator (amount float-major -> amountMinor int-minor; isActive -> state).
    expect(migratedSubs).toHaveLength(2);
    expect(migratedSubs[0]).toMatchObject({
      id: "a",
      amountMinor: 49900, // 499 INR (exp 2)
      currency: "INR",
      state: "Active",
      priceHistory: [],
      tags: [],
    });
    expect(migratedSubs[1]).toMatchObject({
      id: "b",
      amountMinor: 999, // 9.99 USD (exp 2)
      currency: "USD",
      state: "Paused",
    });
    // Independently cross-check against the pure migrator.
    expect(migratedSubs[0]).toEqual(migrateSubscriptionV1toV2(v1Subs[0]));
    expect(migratedSubs[1]).toEqual(migrateSubscriptionV1toV2(v1Subs[1]));

    // The file was atomically written back as v2.
    const rawAfter = await readJson(subsPath);
    expect(rawAfter.version).toBe(2);

    // A pre-migration backup was taken, capturing the RAW v1 file (version 1).
    const backups = await migrator.listBackups();
    expect(backups.length).toBeGreaterThan(0);
    const backup = await migrator.readBackup(backups[0]);
    expect(backup.version).toBe(1);
    expect(backup.subscriptions).toEqual(v1Subs);

    // Idempotent: a second read sees == current and does NOT migrate again
    // (no new backup, file unchanged).
    const rawAfterText = await readFile(subsPath, "utf8");
    const backupCountBefore = (await migrator.listBackups()).length;
    const secondRead = (await migrator.readSubscriptions()) as unknown as Array<
      Record<string, unknown>
    >;
    expect(secondRead).toEqual(migratedSubs);
    expect(await readFile(subsPath, "utf8")).toBe(rawAfterText);
    expect((await migrator.listBackups()).length).toBe(backupCountBefore);
  });

  it("older version: v1 settings migrate to v2 (homeCurrency + online), write back", async () => {
    const writer = new JsonFileStorage(userData); // current = 1
    await writer.writeSettings(v1Settings({ defaultCurrency: "EUR" }));
    const settingsPath = join(userData, fileNames.settings);
    expect((await readJson(settingsPath)).version).toBe(1);

    const migrator = new JsonFileStorage(userData, null, 2);
    const migrated = (await migrator.readSettings()) as unknown as Record<string, unknown>;

    expect(migrated.homeCurrency).toBe("EUR");
    expect(migrated).not.toHaveProperty("defaultCurrency");
    expect(migrated.online).toEqual({ liveLogoFetch: false, fxRefresh: false });

    const rawAfter = await readJson(settingsPath);
    expect(rawAfter.version).toBe(2);
    expect(rawAfter.homeCurrency).toBe("EUR");

    // Settings has no backup stream: no pre-migration backup was taken.
    expect(await migrator.listBackups()).toEqual([]);
  });

  it("equal version: a genuine v2 file against current = 2 validates with NO write-back", async () => {
    const subsPath = join(userData, fileNames.subscriptions);
    const v2File = {
      version: 2,
      subscriptions: [
        {
          id: "a",
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
        },
      ],
    };
    await writeFile(subsPath, JSON.stringify(v2File), "utf8");
    const before = await readFile(subsPath, "utf8");

    const storage = new JsonFileStorage(userData, null, 2);
    const read = (await storage.readSubscriptions()) as unknown as Array<Record<string, unknown>>;
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: "a", amountMinor: 49900, state: "Active" });

    // No write-back for an equal-version file; no backup taken.
    expect(await readFile(subsPath, "utf8")).toBe(before);
    expect(await storage.listBackups()).toEqual([]);
  });

  it("newer version: a version-3 file against current = 2 is REFUSED, untouched", async () => {
    const subsPath = join(userData, fileNames.subscriptions);
    await writeFile(subsPath, JSON.stringify({ version: 3, subscriptions: [] }), "utf8");
    const before = await readFile(subsPath, "utf8");

    const storage = new JsonFileStorage(userData, null, 2);
    await expect(storage.readSubscriptions()).rejects.toBeInstanceOf(StorageNewerVersionError);
    expect(await readFile(subsPath, "utf8")).toBe(before);
  });

  it("migrate failure: an unmigratable v1 record surfaces a typed error; original file + backup survive", async () => {
    // A v1 subscription with an unknown currency cannot be migrated (money.ts
    // throws UnknownCurrencyError), which the migrator wraps in a MigrationError.
    const subsPath = join(userData, fileNames.subscriptions);
    const v1File = {
      version: 1,
      subscriptions: [v1Subscription({ id: "x", currency: "ZZZ", amount: 10 })],
    };
    await writeFile(subsPath, JSON.stringify(v1File), "utf8");
    const before = await readFile(subsPath, "utf8");

    const storage = new JsonFileStorage(userData, null, 2);
    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageMigrationError);
    expect(isStorageMigrationError(caught)).toBe(true);
    const error = caught as StorageMigrationError;
    expect(error.file).toBe(fileNames.subscriptions);
    expect(error.fromVersion).toBe(1);
    expect(error.currentVersion).toBe(2);

    // The original file is NOT corrupted (no write-back happened).
    expect(await readFile(subsPath, "utf8")).toBe(before);
    expect((await readJson(subsPath)).version).toBe(1);

    // The pre-migration backup was taken BEFORE the failing migrate and survives.
    const backups = await storage.listBackups();
    expect(backups.length).toBeGreaterThan(0);
    const backup = await storage.readBackup(backups[0]);
    expect(backup.version).toBe(1);
    expect(backup.subscriptions).toEqual(v1File.subscriptions);
  });

  it("missing file at current = 2: recreates defaults stamped at version 2", async () => {
    const storage = new JsonFileStorage(userData, null, 2);
    // Default v2 subscriptions file is an empty list; it validates against the
    // v2 schema (version literal 2, empty subscriptions array).
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
    expect((await readJson(join(userData, fileNames.subscriptions))).version).toBe(2);
  });

  it("<current branch never throws raw: a bad-shape v1 file surfaces StorageMigrationError, file intact", async () => {
    // version:1 (so version < current) with NO `subscriptions` field. This makes
    // the pre-migration backup's assembleBackupPayload spread (`[...undefined]`)
    // throw a raw TypeError. The read must still surface a typed
    // StorageMigrationError (Req 19: a read never throws raw), with the original
    // file left untouched.
    const subsPath = join(userData, fileNames.subscriptions);
    await writeFile(subsPath, JSON.stringify({ version: 1 }), "utf8");
    const before = await readFile(subsPath, "utf8");

    const storage = new JsonFileStorage(userData, null, 2);
    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageMigrationError);
    expect(isStorageMigrationError(caught)).toBe(true);
    // Original file untouched (no write-back happened).
    expect(await readFile(subsPath, "utf8")).toBe(before);
    expect((await readJson(subsPath)).version).toBe(1);
  });

  it("write-then-read round-trips at the injected version with no spurious re-migrate", async () => {
    // At current = 2 the write methods must stamp version 2 (the same source the
    // read gate uses), so a subsequent read sees == current and does NOT migrate.
    const storage = new JsonFileStorage(userData, null, 2);

    // A v2-shaped subscription (amountMinor/state), cast through unknown because
    // the public write signature is the v1 Subscription type (scope-A seam).
    const v2Sub = {
      id: "a",
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
    };
    await storage.writeSubscriptions([v2Sub] as unknown as Subscription[]);

    const subsPath = join(userData, fileNames.subscriptions);
    // The written file is stamped at the injected current (2), not 1.
    expect((await readJson(subsPath)).version).toBe(2);
    const afterWrite = await readFile(subsPath, "utf8");

    // Reading back sees == current: validates against v2, returns as-is, and
    // does NOT migrate (no write-back, no backup, bytes unchanged).
    const read = (await storage.readSubscriptions()) as unknown as Array<Record<string, unknown>>;
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: "a", amountMinor: 49900, state: "Active" });
    expect(await readFile(subsPath, "utf8")).toBe(afterWrite);
    expect(await storage.listBackups()).toEqual([]);

    // Settings round-trips at the injected version too (write v2 -> read == current).
    await storage.writeSettings({
      homeCurrency: "EUR",
      notification: { enabled: true, leadTimes: ["same-day"] },
      backupFrequency: "weekly",
      theme: "dark",
      accentColor: "#7C5CFF",
      trayMode: false,
      dataFolder: null,
      online: { liveLogoFetch: false, fxRefresh: false },
    } as unknown as Settings);
    const settingsPath = join(userData, fileNames.settings);
    expect((await readJson(settingsPath)).version).toBe(2);
    const settingsBytes = await readFile(settingsPath, "utf8");
    const readSettings = (await storage.readSettings()) as unknown as Record<string, unknown>;
    expect(readSettings.homeCurrency).toBe("EUR");
    expect(await readFile(settingsPath, "utf8")).toBe(settingsBytes); // no re-migrate
  });
});
