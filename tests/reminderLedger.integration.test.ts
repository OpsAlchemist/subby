import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonFileStorage,
  StorageNewerVersionError,
  isStorageNewerVersionError,
} from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import { defaultReminderLedger } from "core/models/schema";
import type { ReminderLedger } from "core/models/reminder";

/**
 * Integration tests for the reminder-ledger storage round-trip and the AMENDED
 * recovery policy (Story 4.1 — AD-19). Exercised against a real temp data
 * directory, mirroring `tests/jsonFileStorage.integration.test.ts`.
 *
 * The ledger is the app's exactly-once dedupe memory, so the correctness crux is
 * that a MISSING file is distinguished from an UNREADABLE one:
 *   (1) MISSING (ENOENT, first run) → returns a fresh empty ledger AND writes it.
 *   (2) write-with-both-event-kinds → read-back is identical.
 *   (3) CONTENT-CORRUPT → returns empty IN MEMORY and the on-disk bytes are
 *       UNCHANGED (no clobber — asserted by reading the garbage back).
 *   (4) a populated-then-corrupted file → the corrupt read does NOT destroy it.
 *   (5) version > current → throws StorageNewerVersionError, file untouched.
 *
 * A true transient EACCES/EBUSY is hard to seed portably; `safeReadVersionedJson`
 * maps any non-ENOENT read error to `reason:"malformed"`, which is the SAME
 * "malformed → in-memory empty, no overwrite" branch exercised by (3)/(4). So the
 * no-clobber-on-transient behavior is covered by those rows.
 */

/** True when a path exists and is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

let userData: string;
let storage: JsonFileStorage;
let ledgerPath: string;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-ledger-"));
  storage = new JsonFileStorage(userData);
  ledgerPath = join(userData, fileNames.reminderLedger);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("reminder ledger: missing → fresh empty, written once (Story 4.1)", () => {
  it("returns the fresh empty ledger AND persists it to disk", async () => {
    expect(await isFile(ledgerPath)).toBe(false);

    const result = await storage.readReminderLedger();

    expect(result).toEqual(defaultReminderLedger());
    expect(result).toEqual({ version: 1, lastRunAt: null, fired: [] });
    // The ONE allowed read-path write happened: the file now exists on disk.
    expect(await isFile(ledgerPath)).toBe(true);
    const onDisk = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(onDisk).toEqual({ version: 1, lastRunAt: null, fired: [] });
  });

  it("defaultReminderLedger() returns a fresh array each call (no shared reference)", async () => {
    const a = await storage.readReminderLedger();
    a.fired.push({
      kind: "renewal",
      subscriptionId: "x",
      leadTime: "same-day",
      localDay: "2026-01-01",
    });
    // A fresh read is unaffected by mutating a prior result.
    const b = await storage.readReminderLedger();
    expect(b.fired).toEqual([]);
  });
});

describe("reminder ledger: round-trip with both event kinds (Story 4.1)", () => {
  it("writes a ledger with renewal + trial-end entries and reads it back identically", async () => {
    const written: ReminderLedger = {
      version: 1,
      lastRunAt: "2026-06-15T12:00:00.000Z",
      fired: [
        {
          kind: "renewal",
          subscriptionId: "sub-1",
          leadTime: "one-day",
          localDay: "2026-06-14",
        },
        {
          kind: "trial-end",
          subscriptionId: "sub-2",
          leadTime: "three-days",
          localDay: "2026-06-12",
        },
      ],
    };

    await storage.writeReminderLedger(written);
    const readBack = await storage.readReminderLedger();

    // Both event kinds and lastRunAt round-trip EXACTLY — proving the schema
    // carries both shapes without a later change (Epic 5 reuse).
    expect(readBack).toEqual(written);
  });
});

describe("reminder ledger: content-corrupt → in-memory empty, NO clobber (Story 4.1)", () => {
  it("returns a fresh empty ledger and leaves the garbage bytes on disk untouched", async () => {
    const garbage = "{this is : not json";
    await writeFile(ledgerPath, garbage, "utf8");

    const result = await storage.readReminderLedger();

    // Degrade-to-empty in memory, no throw.
    expect(result).toEqual(defaultReminderLedger());
    // CRITICAL: the on-disk file is NOT overwritten — the garbage survives,
    // proving a corrupt read never clobbers a possibly-recoverable file (and
    // never erases persisted fired-state on a transient hiccup, same branch).
    expect(await readFile(ledgerPath, "utf8")).toBe(garbage);
  });

  it("valid JSON but failing the ledger schema also degrades without a clobber", async () => {
    // version 1 but `fired` is the wrong type → fails reminderLedgerFileSchema.
    const badShape = JSON.stringify({ version: 1, lastRunAt: null, fired: "nope" });
    await writeFile(ledgerPath, badShape, "utf8");

    const result = await storage.readReminderLedger();

    expect(result).toEqual(defaultReminderLedger());
    expect(await readFile(ledgerPath, "utf8")).toBe(badShape);
  });
});

describe("reminder ledger: populated-then-corrupted → corrupt read does not destroy it (Story 4.1)", () => {
  it("a corrupt read of a previously-populated file does NOT overwrite the on-disk bytes", async () => {
    // First persist a real, populated ledger.
    const populated: ReminderLedger = {
      version: 1,
      lastRunAt: "2026-06-15T12:00:00.000Z",
      fired: [
        {
          kind: "renewal",
          subscriptionId: "sub-1",
          leadTime: "same-day",
          localDay: "2026-06-15",
        },
      ],
    };
    await storage.writeReminderLedger(populated);

    // Simulate the file getting corrupted (e.g. a mid-sync partial write).
    const corruptedBytes = "{ partial write ...";
    await writeFile(ledgerPath, corruptedBytes, "utf8");

    const result = await storage.readReminderLedger();

    // The read degrades to empty in memory...
    expect(result).toEqual(defaultReminderLedger());
    // ...but it does NOT clobber the (corrupt) file — a transient hiccup must
    // never erase persisted fired-state. The next real write (4.2) self-heals.
    expect(await readFile(ledgerPath, "utf8")).toBe(corruptedBytes);
  });
});

describe("reminder ledger: newer version → refuse, file untouched (Story 4.1)", () => {
  it("throws StorageNewerVersionError and leaves the file on disk untouched", async () => {
    const future = JSON.stringify({ version: 2, lastRunAt: null, fired: [] });
    await writeFile(ledgerPath, future, "utf8");
    const before = await readFile(ledgerPath, "utf8");

    let caught: unknown;
    try {
      await storage.readReminderLedger();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StorageNewerVersionError);
    expect(isStorageNewerVersionError(caught)).toBe(true);
    const error = caught as StorageNewerVersionError;
    expect(error.file).toBe(fileNames.reminderLedger);
    expect(error.fileVersion).toBe(2);
    expect(error.currentVersion).toBe(1);
    // Never downgrade-overwrite.
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
  });
});
