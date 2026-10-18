import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonFileStorage,
  StorageTransientMissingError,
  isStorageTransientMissingError,
} from "../electron/storage/jsonFileStorage";
import {
  defaultIsCloudPath,
  fileNames,
  type CloudPathPredicate,
} from "../electron/storage/paths";
import { SYNCED_FOLDER_CAVEAT, createAppContext } from "../electron/appWiring";
import type { Subscription, SubscriptionV2 } from "core/models/subscription";

/**
 * Integration tests for the cloud-folder safe-read guardrail (Story 1.7 /
 * AD-31 / FR-16, FR-20).
 *
 * The guardrail *behavior* and the injection *seam* are exercised by driving the
 * `isCloudPath` predicate directly (true/false) over a real temp dir. NO real
 * cloud-path detection is asserted — that is the deferred PRD-Q7 heuristic. Every
 * row of the story's I/O & Edge-Case Matrix is covered:
 *
 *   - default (no predicate)      → recreate-on-missing exactly as today
 *   - cloud + transient missing   → NOT recreated; typed recoverable error; data intact
 *   - cloud + pristine first-run  → defaults initialize normally
 *   - non-cloud missing           → recreate-on-missing as today
 *   - relocation honored / cancelled unchanged
 *   - caveat surfaced (string available, not hidden)
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

/** A predicate that treats the whole given dir (and nothing else) as cloud. */
const alwaysCloud: CloudPathPredicate = () => true;

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-cloud-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

// --- the injection seam defaults safe (AD-31) --------------------------------

describe("defaultIsCloudPath (safe-default seam)", () => {
  it("classifies NO path as a cloud path (never guards by default)", () => {
    expect(defaultIsCloudPath("/anything")).toBe(false);
    expect(defaultIsCloudPath("/Users/me/Library/Mobile Documents/foo")).toBe(false);
    expect(defaultIsCloudPath("")).toBe(false);
  });

  it("is the adapter's default: unspecified predicate behaves as never-cloud", async () => {
    // No predicate injected → default. A missing file recreates (no guard),
    // even though the folder would otherwise look like a cloud path.
    const storage = new JsonFileStorage(userData, null, 1);
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
    expect(await readFile(join(userData, fileNames.subscriptions), "utf8")).toContain(
      '"version": 1',
    );
  });
});

// --- default predicate: recreate-on-missing is byte-identical to today -------

describe("default predicate (() => false): recreate-on-missing unchanged", () => {
  it("missing subscriptions file is recreated with empty defaults, even with backups present", async () => {
    const storage = new JsonFileStorage(userData, null, 1); // default predicate
    // Create a backup first (so there IS evidence of real data), then delete the
    // live file. Under the default predicate the guardrail must stay INERT: the
    // file recreates exactly as today.
    await storage.writeSubscriptions([v1Subscription()] as unknown as SubscriptionV2[]);
    await storage.createBackup("test");
    await rm(join(userData, fileNames.subscriptions), { force: true });

    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]); // recreated empty — today's behavior
    const raw = await readFile(join(userData, fileNames.subscriptions), "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, subscriptions: [] });
  });
});

// --- cloud + transient missing: GUARD (do not recreate-empty) ----------------

describe("cloud + transient missing: guardrail refuses empty-recreate", () => {
  it("missing subscriptions file with a backup present → StorageTransientMissingError, data NOT recreated", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // Real data existed and a backup was taken; then the live file vanishes
    // (mid-sync). The backup is the evidence of real data to protect.
    await storage.writeSubscriptions([v1Subscription({ id: "live" })] as unknown as SubscriptionV2[]);
    await storage.createBackup("test");
    await rm(join(userData, fileNames.subscriptions), { force: true });

    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StorageTransientMissingError);
    expect(isStorageTransientMissingError(caught)).toBe(true);
    const error = caught as StorageTransientMissingError;
    expect(error.file).toBe(fileNames.subscriptions);
    expect(error.canRestoreBackup).toBe(true);
    expect(error.recoverable).toBe(true);

    // The file was NOT recreated — the gap is left for sync to fill (data intact).
    const entries = await readdir(userData);
    expect(entries).not.toContain(fileNames.subscriptions);

    // The backup is untouched and still present. Inspect the backup FILE ON DISK
    // rather than via `readBackup`: this backup was assembled from a bare v1
    // array, so `assembleBackupPayload` stamped it the current BACKUP_SCHEMA_
    // VERSION (2) while holding v1-shaped records — an internally mixed shape a
    // `current = 1` adapter's `readBackup` (which refuses a newer-than-current
    // stamp since Story 7.4) will not load. The raw bytes prove the backup
    // captured the data and survived the guarded (non-recreating) read.
    const backups = await storage.listBackups();
    expect(backups.length).toBeGreaterThan(0);
    const backup = JSON.parse(
      await readFile(join(userData, fileNames.backupDir, backups[0]), "utf8"),
    ) as { subscriptions: unknown[] };
    expect(backup.subscriptions).toEqual([v1Subscription({ id: "live" })]);
  });

  it("missing subscriptions file with a POPULATED sibling categories file (no backup) → guarded", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // A categories.json holding real records = evidence of real data, no backup.
    await writeFile(
      join(userData, fileNames.categories),
      JSON.stringify({
        version: 1,
        categories: [{ id: "c1", name: "Streaming", isDefault: true }],
      }),
      "utf8",
    );

    let caught: unknown;
    try {
      await storage.readSubscriptions();
    } catch (err) {
      caught = err;
    }
    expect(isStorageTransientMissingError(caught)).toBe(true);
    const error = caught as StorageTransientMissingError;
    // No backup stream yet → not restorable from backup; retry is the recovery.
    expect(error.canRestoreBackup).toBe(false);
    expect(await readdir(userData)).not.toContain(fileNames.subscriptions);
  });

  it("missing categories file in a cloud folder with a POPULATED subscriptions sibling → guarded", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // subscriptions.json holding a record = sibling evidence (no backup).
    await writeFile(
      join(userData, fileNames.subscriptions),
      JSON.stringify({ version: 1, subscriptions: [v1Subscription()] }),
      "utf8",
    );

    let caught: unknown;
    try {
      await storage.readCategories();
    } catch (err) {
      caught = err;
    }
    expect(isStorageTransientMissingError(caught)).toBe(true);
    const error = caught as StorageTransientMissingError;
    expect(error.file).toBe(fileNames.categories);
    expect(error.canRestoreBackup).toBe(false);
    expect(await readdir(userData)).not.toContain(fileNames.categories);
  });

  it("an EMPTY sibling record file is NOT evidence (first-run init artifact) → not guarded", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // A just-recreated empty subscriptions file must not make categories look
    // like a transient loss (otherwise sequential first-run init would brick).
    await writeFile(
      join(userData, fileNames.subscriptions),
      JSON.stringify({ version: 1, subscriptions: [] }),
      "utf8",
    );
    const categories = await storage.readCategories();
    expect(Array.isArray(categories)).toBe(true);
    expect(await readdir(userData)).toContain(fileNames.categories);
  });

  it("default settings.json alone is NOT evidence (cannot discriminate) → not guarded", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // Initialize settings (full default keys), then read a missing subscriptions
    // file. Settings is deliberately excluded from the evidence check, so this
    // must still initialize rather than guard.
    await storage.readSettings();
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
    expect(await readdir(userData)).toContain(fileNames.subscriptions);
  });

  it("settings.json is EXEMPT: a missing settings file in a cloud folder recreates even with strong evidence present", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // Create strong evidence of real data: a backup AND a populated record file.
    // settings has NO backup stream, so guarding it would be an unrecoverable
    // retry-only dead-end — it must ALWAYS recreate-on-missing regardless of
    // isCloudPath. Delete settings; confirm it is recreated with defaults.
    await storage.writeSubscriptions([v1Subscription()] as unknown as SubscriptionV2[]);
    await storage.createBackup("test");
    await rm(join(userData, fileNames.settings), { force: true });

    const settings = await storage.readSettings();
    expect(settings).toBeTypeOf("object");
    // Recreated on disk (not a transient-missing dead-end).
    expect(await readdir(userData)).toContain(fileNames.settings);
    const raw = JSON.parse(await readFile(join(userData, fileNames.settings), "utf8"));
    expect(raw.version).toBe(1);
  });
});

// --- cloud + pristine first-run: ALLOW init ----------------------------------

describe("cloud + pristine first-run: still initializes (not a transient loss)", () => {
  it("empty cloud folder, no files, no backups → defaults initialize normally", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // Nothing exists → pristine. The guardrail must NOT fire; init proceeds.
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
    const raw = await readFile(join(userData, fileNames.subscriptions), "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, subscriptions: [] });
  });

  it("pristine cloud folder initializes settings and categories too", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    const settings = await storage.readSettings();
    expect(settings).toBeTypeOf("object");
    const categories = await storage.readCategories();
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);
  });

  it("a lone empty backup/ dir (no backup files, no data) is still pristine → init allowed", async () => {
    const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
    // ensureTree creates backup/ but it holds no backup files; no data files
    // exist. listBackups() returns [] and no siblings are present → pristine.
    await storage.ensureTree();
    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]);
  });
});

// --- non-cloud missing: recreate-on-missing as today -------------------------

describe("non-cloud missing: recreate unchanged (isCloudPath → false)", () => {
  it("missing file with backups present but predicate false → recreated empty (today's behavior)", async () => {
    const neverCloud: CloudPathPredicate = () => false;
    const storage = new JsonFileStorage(userData, null, 1, neverCloud);
    await storage.writeSubscriptions([v1Subscription()] as unknown as SubscriptionV2[]);
    await storage.createBackup("test");
    await rm(join(userData, fileNames.subscriptions), { force: true });

    const subs = await storage.readSubscriptions();
    expect(subs).toEqual([]); // recreated — not guarded, because not a cloud path
    expect(await readdir(userData)).toContain(fileNames.subscriptions);
  });
});

// --- relocation still honored (and the caveat surfaced) ----------------------

describe("relocation honored; synced-folder caveat available", () => {
  it("setDataFolder switches the active dir for subsequent I/O; null reverts", async () => {
    const other = await mkdtemp(join(tmpdir(), "subby-cloud-other-"));
    try {
      const storage = new JsonFileStorage(userData, null, 1, alwaysCloud);
      // Pristine → init works in the default dir.
      await storage.writeSubscriptions([v1Subscription({ id: "in-default" })] as unknown as SubscriptionV2[]);
      expect(storage.getDataFolder()).toBe(userData);

      // Relocate: subsequent I/O targets `other`.
      await storage.setDataFolder(other);
      expect(storage.getDataFolder()).toBe(other);
      await storage.writeSubscriptions([v1Subscription({ id: "in-other" })] as unknown as SubscriptionV2[]);
      const inOther = await storage.readSubscriptions();
      expect(inOther[0]?.id).toBe("in-other");
      expect(await readdir(other)).toContain(fileNames.subscriptions);

      // Revert to default: the earlier file is still there.
      await storage.setDataFolder(null);
      expect(storage.getDataFolder()).toBe(userData);
      const inDefault = await storage.readSubscriptions();
      expect(inDefault[0]?.id).toBe("in-default");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("the single-machine caveat is a non-empty stance string, available (not hidden)", () => {
    expect(typeof SYNCED_FOLDER_CAVEAT).toBe("string");
    expect(SYNCED_FOLDER_CAVEAT.length).toBeGreaterThan(0);
    // It states the single-machine stance and does NOT advertise multi-device sync.
    expect(SYNCED_FOLDER_CAVEAT.toLowerCase()).toContain("single machine");
    expect(SYNCED_FOLDER_CAVEAT.toLowerCase()).toContain("does not provide multi-device sync");
  });
});

// --- wiring: createAppContext threads the (defaulted) predicate --------------

describe("createAppContext wiring", () => {
  it("defaults to the inert predicate (production behavior unchanged)", async () => {
    // No predicate passed → defaultIsCloudPath. A missing file recreates.
    const { services } = createAppContext(userData);
    const subs = await services.listSubscriptions();
    expect(subs).toEqual([]);
    expect(await readdir(userData)).toContain(fileNames.subscriptions);
  });

  it("an injected predicate reaches the storage adapter's guardrail", async () => {
    // Inject alwaysCloud + pre-seed a populated record sibling as evidence.
    await writeFile(
      join(userData, fileNames.categories),
      JSON.stringify({
        version: 1,
        categories: [{ id: "c1", name: "Streaming", isDefault: true }],
      }),
      "utf8",
    );
    const { services } = createAppContext(userData, null, alwaysCloud);
    await expect(services.listSubscriptions()).rejects.toSatisfy((err) =>
      isStorageTransientMissingError(err),
    );
    // Not recreated.
    expect(await readdir(userData)).not.toContain(fileNames.subscriptions);
  });
});
