import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileStorage } from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import {
  FileExistsError,
  isFileExistsError,
  writeJsonExclusive,
} from "../electron/storage/safeJson";
import { assembleBackupPayload } from "core/backup";
import type { Subscription, SubscriptionV2 } from "core/models/subscription";

/**
 * Collision-proof, never-overwrite backup tests (Story 1.5 / AD-16).
 *
 * Exercises the adapter's backup writer against a real temp directory with the
 * system clock pinned (fake timers) so that two backups genuinely land in the
 * same UTC minute — even the same millisecond — proving the monotonic-counter
 * tie-breaker and the fs-level exclusive-create guarantee make a silent clobber
 * impossible. Covers the story's I/O & Edge-Case Matrix:
 *   - two backups in the same minute -> two distinct files, both present
 *   - pre-migration backup + same-minute backup -> pre-migration survives
 *   - mixed old-format + new-format names -> listBackups newest-first
 *   - never-overwrite -> target already exists, writer resolves/fails loudly
 *   - legacy restore -> an old `YYYY-MM-DD-HH-MM.json` still lists + readBackup
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

/** List the raw backup directory entries (what is physically on disk). */
async function backupEntries(userData: string): Promise<string[]> {
  return readdir(join(userData, fileNames.backupDir));
}

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-backup-collision-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(userData, { recursive: true, force: true });
});

describe("collision-proof backups: same-minute uniqueness (AD-16)", () => {
  it("two createBackup calls within one UTC minute produce two distinct files, both present", async () => {
    // Pin the clock to a single instant so BOTH backups land in the same minute
    // AND the same millisecond — the only thing that can keep them distinct is
    // the adapter's injected monotonic counter.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T09:05:42.137Z"));

    const storage = new JsonFileStorage(userData, null, 1);
    await storage.writeSubscriptions([v1Subscription({ id: "a" })] as unknown as SubscriptionV2[]);

    const name1 = await storage.createBackup("scheduled");
    const name2 = await storage.createBackup("pre-delete");

    // Distinct names.
    expect(name1).not.toBe(name2);

    // Both physically present on disk (neither overwrote the other).
    const onDisk = await backupEntries(userData);
    expect(onDisk).toContain(name1);
    expect(onDisk).toContain(name2);
    expect(onDisk.filter((n) => n.endsWith(".json"))).toHaveLength(2);

    // Both share the same minute prefix (collision avoided purely by the suffix).
    const minutePrefix = "2026-03-07-09-05";
    expect(name1.startsWith(minutePrefix)).toBe(true);
    expect(name2.startsWith(minutePrefix)).toBe(true);
  });

  it("many same-millisecond backups are all distinct and all survive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T09:05:42.137Z"));

    const storage = new JsonFileStorage(userData, null, 1);
    await storage.writeSubscriptions([v1Subscription()] as unknown as SubscriptionV2[]);

    const names: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      names.push(await storage.createBackup(`burst-${i}`));
    }

    // All distinct.
    expect(new Set(names).size).toBe(names.length);
    // All on disk.
    const onDisk = (await backupEntries(userData)).filter((n) =>
      n.endsWith(".json"),
    );
    expect(onDisk).toHaveLength(10);
    for (const n of names) expect(onDisk).toContain(n);
  });

  it("a burst of backups across advancing time stays width-stable and orders newest-first", async () => {
    // Regression guard against an accumulating instance counter: the disambiguating
    // seq is loop-local (reset per captured instant), so a long run of backups never
    // widens the name past the 4-digit seq segment. (The full 0-9999 seq range is
    // exhaustively covered width-stable + sort-correct by the pure property test;
    // this confirms the end-to-end adapter path.) Advance the clock by one ms per
    // backup so each gets a fresh instant (seq 0) and names stay chronological.
    vi.useFakeTimers();
    const base = new Date("2026-03-07T09:05:42.137Z").getTime();

    const storage = new JsonFileStorage(userData, null, 1);
    await storage.writeSubscriptions([v1Subscription()] as unknown as SubscriptionV2[]);

    const COUNT = 50;
    const names: string[] = [];
    for (let i = 0; i < COUNT; i += 1) {
      vi.setSystemTime(new Date(base + i));
      names.push(await storage.createBackup(`burst-${i}`));
    }

    // Every name's seq segment is exactly 4 digits (never widened to 5).
    for (const n of names) {
      const seqSeg = n.split(".")[0].split("-").at(-1);
      expect(seqSeg).toHaveLength(4);
    }

    // listBackups returns newest-first: the reverse of creation order (creation
    // order is strictly ascending by instant). No off-by-one from a 5-digit seq.
    const listed = await storage.listBackups();
    expect(listed).toHaveLength(COUNT);
    expect(listed).toEqual([...names].reverse());
  });
});

describe("collision-proof backups: pre-migration survives a same-minute backup (AD-16)", () => {
  it("a pre-migration backup is not clobbered by a same-minute scheduled/pre-destructive backup", async () => {
    // Pin the clock so the pre-migration backup (taken inside the migrate read
    // path) and a subsequent manual backup land in the exact same instant.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T09:05:42.137Z"));

    // Write a genuine v1 file via a current=1 adapter.
    const writer = new JsonFileStorage(userData, null, 1); // current = 1
    const v1Subs = [v1Subscription({ id: "a", amount: 499, currency: "INR" })];
    await writer.writeSubscriptions(v1Subs as unknown as SubscriptionV2[]);

    // Read through a current=2 adapter: the migrate branch takes a pre-migration
    // backup of the RAW v1 file FIRST (AD-16).
    const migrator = new JsonFileStorage(userData, null, 2);
    await migrator.readSubscriptions();

    const afterMigration = await migrator.listBackups();
    expect(afterMigration.length).toBe(1);
    const preMigrationName = afterMigration[0];

    // The pre-migration backup is a faithful v1 snapshot. Inspect the backup
    // FILE ON DISK, not via `readBackup`: since Story 7.4, `readBackup`
    // migrates-on-restore a `< current` backup, so it would return a v2 file —
    // the raw bytes are the faithful v1 snapshot this assertion is about.
    const preMigrationBackup = JSON.parse(
      await readFile(join(userData, fileNames.backupDir, preMigrationName), "utf8"),
    ) as { version: number; subscriptions: unknown[] };
    expect(preMigrationBackup.version).toBe(1);
    expect(preMigrationBackup.subscriptions).toEqual(v1Subs);

    // Now take a same-minute (same-instant, clock still pinned) scheduled backup.
    const scheduledName = await migrator.createBackup("scheduled");

    // Distinct names, both present: the pre-migration backup survives.
    expect(scheduledName).not.toBe(preMigrationName);
    const all = await migrator.listBackups();
    expect(all).toContain(preMigrationName);
    expect(all).toContain(scheduledName);

    // The pre-migration backup still reads back as the untouched v1 snapshot
    // (inspected on disk — `readBackup` would migrate it, per the note above).
    const stillThere = JSON.parse(
      await readFile(join(userData, fileNames.backupDir, preMigrationName), "utf8"),
    ) as { version: number; subscriptions: unknown[] };
    expect(stillThere.version).toBe(1);
    expect(stillThere.subscriptions).toEqual(v1Subs);
  });
});

describe("collision-proof backups: mixed old/new ordering + legacy restore (Req 18.2, AD-27)", () => {
  it("listBackups returns mixed old-format and new-format names newest-first", async () => {
    const storage = new JsonFileStorage(userData, null, 1);
    await storage.ensureTree();

    const backupDir = join(userData, fileNames.backupDir);
    const payload = assembleBackupPayload([v1Subscription()]);

    // Hand-seed a spread of names: two legacy minute-only, two new-format.
    const legacyOld = "2025-01-01-08-00.json"; // oldest
    const legacyNew = "2025-06-15-12-30.json";
    const newFmtA = "2026-03-07-09-05-42-137-0000.json";
    const newFmtB = "2026-03-07-09-05-42-900-0001.json"; // newest (later millis)

    for (const name of [legacyOld, legacyNew, newFmtA, newFmtB]) {
      await writeFile(
        join(backupDir, name),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
    }

    const listed = await storage.listBackups();
    // Newest-first (descending lexicographic == descending chronological).
    expect(listed).toEqual([newFmtB, newFmtA, legacyNew, legacyOld]);
  });

  it("a legacy YYYY-MM-DD-HH-MM.json backup still lists and readBackup-restores it", async () => {
    const storage = new JsonFileStorage(userData, null, 1);
    await storage.ensureTree();

    const legacyName = "2025-01-01-08-00.json";
    const subs = [
      v1Subscription({ id: "legacy-a", name: "Spotify" }),
      v1Subscription({ id: "legacy-b", name: "Disney+" }),
    ];
    // A legacy backup written by a `current = 1`-era build is a genuine v1 file
    // (`version: 1` + v1-shaped records). Seed it that way so the `current = 1`
    // adapter's version-gated `readBackup` (Story 7.4) validates it with the v1
    // schema and returns it unchanged — the `== current` branch. (The bare-array
    // `assembleBackupPayload` helper always stamps the LIVE BACKUP_SCHEMA_VERSION
    // (2), which would mismatch a v1-shaped record under a v1 adapter.)
    const payload = { version: 1 as const, subscriptions: subs };
    await writeFile(
      join(userData, fileNames.backupDir, legacyName),
      JSON.stringify(payload, null, 2),
      "utf8",
    );

    // It lists.
    expect(await storage.listBackups()).toContain(legacyName);
    // It restores value-exact (validated at == current = 1, returned unchanged).
    const restored = await storage.readBackup(legacyName);
    expect(restored.version).toBe(payload.version);
    expect(restored.subscriptions).toEqual(subs);
  });

  it("readBackup for a missing legacy name throws a not-found error (never silent)", async () => {
    const storage = new JsonFileStorage(userData, null, 1);
    await storage.ensureTree();
    await expect(storage.readBackup("2000-01-01-00-00.json")).rejects.toThrow(
      /Backup not found/,
    );
  });
});

describe("collision-proof backups: never-overwrite (AD-16)", () => {
  it("createBackup resolves a fresh name when the first candidate already exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T09:05:42.137Z"));

    const storage = new JsonFileStorage(userData, null, 1);
    await storage.writeSubscriptions([v1Subscription()] as unknown as SubscriptionV2[]);
    await storage.ensureTree();

    // Pre-seed the exact name the next backup would otherwise choose (seq 0).
    const collidingName = "2026-03-07-09-05-42-137-0000.json";
    await writeFile(
      join(userData, fileNames.backupDir, collidingName),
      JSON.stringify({ version: 1, subscriptions: [], seeded: true }),
      "utf8",
    );

    const name = await storage.createBackup("scheduled");

    // The writer did NOT reuse the seeded name.
    expect(name).not.toBe(collidingName);

    // The seeded file is intact (never clobbered).
    const seeded = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(userData, fileNames.backupDir, collidingName),
        "utf8",
      ),
    ) as { seeded?: boolean };
    expect(seeded.seeded).toBe(true);

    // Both files are present.
    const onDisk = (await backupEntries(userData)).filter((n) =>
      n.endsWith(".json"),
    );
    expect(onDisk).toContain(collidingName);
    expect(onDisk).toContain(name);
  });

  it("writeJsonExclusive refuses to overwrite an existing file (loud FileExistsError)", async () => {
    const storage = new JsonFileStorage(userData, null, 1);
    await storage.ensureTree();
    const target = join(userData, fileNames.backupDir, "exclusive-target.json");

    // First write succeeds.
    await writeJsonExclusive(target, { version: 1, first: true });

    // Second write to the same path must fail loudly, not silently clobber.
    let caught: unknown;
    try {
      await writeJsonExclusive(target, { version: 1, second: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FileExistsError);
    expect(isFileExistsError(caught)).toBe(true);

    // The original content is intact.
    const content = JSON.parse(
      await (await import("node:fs/promises")).readFile(target, "utf8"),
    ) as { first?: boolean; second?: boolean };
    expect(content.first).toBe(true);
    expect(content.second).toBeUndefined();
  });
});
