import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAppServices,
  runMigrationBarrier,
} from "../electron/appWiring";
import {
  JsonFileStorage,
  StorageMigrationError,
} from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import type { Settings, SettingsV2 } from "core/models/settings";
import type { Subscription, SubscriptionV2 } from "core/models/subscription";

/**
 * Launch-ordering tests for the migration barrier (Story 1.6 / AD-28).
 *
 * The barrier (`runMigrationBarrier`) must bring every mutable user-data file to
 * the current schema version BEFORE the scheduler or any handler reads user
 * data. These tests prove:
 *   - at the live `current = 1`, the barrier is a genuine no-op PASS (no backup,
 *     no write-back, no migration — launch *structure* changes, launch
 *     *behavior* does not);
 *   - at an injected `current = 2` with a v1 file on disk, the barrier migrates
 *     the file to completion so a simulated reader (scheduler/handler) that runs
 *     AFTER the barrier only ever observes migrated (v2) data;
 *   - a migration fault surfaces a typed error (so the launch sequence can
 *     degrade and NOT start the scheduler on un-migrated state).
 */

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

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-barrier-"));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("migration barrier at current = 1 (inert no-op pass; live behavior unchanged)", () => {
  it("a barrier over already-current files does NOT migrate, write back, or back up", async () => {
    const storage = new JsonFileStorage(userData, null, 1); // live current = 1
    const subs = [v1Subscription({ id: "a" }), v1Subscription({ id: "b", isActive: false })];
    await storage.writeSubscriptions(subs as unknown as SubscriptionV2[]);
    await storage.writeSettings(v1Settings() as unknown as SettingsV2);

    const subsPath = join(userData, fileNames.subscriptions);
    const settingsPath = join(userData, fileNames.settings);
    const subsBefore = await readFile(subsPath, "utf8");
    const settingsBefore = await readFile(settingsPath, "utf8");
    const backupsBefore = await storage.listBackups();

    await runMigrationBarrier(storage);

    // No-op pass: files are byte-identical (no write-back), still v1, no backup.
    expect(await readFile(subsPath, "utf8")).toBe(subsBefore);
    expect(await readFile(settingsPath, "utf8")).toBe(settingsBefore);
    expect((await readJson(subsPath)).version).toBe(1);
    expect((await readJson(settingsPath)).version).toBe(1);
    expect(await storage.listBackups()).toEqual(backupsBefore);
  });

  it("on a fresh install the barrier recreates defaults (bootstrap), still a pass", async () => {
    const storage = new JsonFileStorage(userData, null, 1);
    await runMigrationBarrier(storage);

    // Default files were created at version 1 — no migration occurred.
    expect((await readJson(join(userData, fileNames.subscriptions))).version).toBe(1);
    expect((await readJson(join(userData, fileNames.settings))).version).toBe(1);
    // No pre-migration backup (nothing was migrated).
    expect(await storage.listBackups()).toEqual([]);
  });

  it("the barrier completes before a simulated scheduler/handler read observes data", async () => {
    const storage = new JsonFileStorage(userData, null, 1);
    await storage.writeSubscriptions([v1Subscription({ id: "a" })] as unknown as SubscriptionV2[]);

    // Model the launch ordering: a reader (scheduler catch-up / handler) is only
    // allowed to touch user data AFTER the barrier resolves. We assert the
    // sequencing explicitly with a shared marker.
    const order: string[] = [];
    await runMigrationBarrier(storage).then(() => order.push("barrier-done"));
    const services = buildAppServices(storage);
    const read = await services.listSubscriptions();
    order.push("reader-ran");

    expect(order).toEqual(["barrier-done", "reader-ran"]);
    expect(read.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("migration barrier at injected current = 2 (load-bearing; migrates before readers)", () => {
  it("a v1 file is migrated to completion by the barrier before any reader observes it", async () => {
    // Write a genuine v1 file with a current=1 adapter.
    const writer = new JsonFileStorage(userData, null, 1);
    const v1Subs = [
      v1Subscription({ id: "a", amount: 499, currency: "INR", isActive: true }),
      v1Subscription({ id: "b", amount: 9.99, currency: "USD", isActive: false }),
    ];
    await writer.writeSubscriptions(v1Subs as unknown as SubscriptionV2[]);
    await writer.writeSettings(v1Settings({ defaultCurrency: "EUR" }) as unknown as SettingsV2);

    const subsPath = join(userData, fileNames.subscriptions);
    const settingsPath = join(userData, fileNames.settings);
    expect((await readJson(subsPath)).version).toBe(1);
    expect((await readJson(settingsPath)).version).toBe(1);

    // The launch sequence constructs the adapter at current = 2 (Epic 3 flip).
    const migrator = new JsonFileStorage(userData, null, 2);

    // The barrier runs the migration to completion.
    await runMigrationBarrier(migrator);

    // After the barrier (and BEFORE any reader below), the files are v2 on disk.
    expect((await readJson(subsPath)).version).toBe(2);
    expect((await readJson(settingsPath)).version).toBe(2);

    // A reader that runs AFTER the barrier sees migrated (v2) data — never a
    // half-migrated v1 shape. This is the scheduler/handler read, modeled with
    // the real services over the same adapter.
    const services = buildAppServices(migrator);
    const subs = (await services.listSubscriptions()) as unknown as Array<Record<string, unknown>>;
    expect(subs[0]).toMatchObject({ id: "a", amountMinor: 49900, state: "Active" });
    expect(subs[1]).toMatchObject({ id: "b", amountMinor: 999, state: "Paused" });
    const settings = (await services.getSettings()) as unknown as Record<string, unknown>;
    expect(settings.homeCurrency).toBe("EUR");
    expect(settings.online).toEqual({ liveLogoFetch: false, fxRefresh: false });

    // A pre-migration backup of the RAW v1 subscriptions survives (AD-16).
    // Inspect the backup FILE ON DISK: `readBackup` migrates-on-restore since
    // Story 7.4, so it would hand back a v2 file — the raw bytes are the faithful
    // v1 snapshot this assertion verifies.
    const backups = await migrator.listBackups();
    expect(backups.length).toBeGreaterThan(0);
    const backup = await readJson(join(userData, fileNames.backupDir, backups[0]));
    expect(backup.version).toBe(1);
    expect(backup.subscriptions).toEqual(v1Subs);
  });

  it("a second launch (barrier re-run) sees already-migrated data and does not re-migrate", async () => {
    const writer = new JsonFileStorage(userData, null, 1);
    await writer.writeSubscriptions([v1Subscription({ id: "a" })] as unknown as SubscriptionV2[]);
    // Seed a genuine v1 settings file so the barrier migrates REAL settings into
    // valid v2 (rather than recreating defaults, whose v2 shape is an Epic-3
    // concern not covered by scope-A defaults).
    await writer.writeSettings(v1Settings() as unknown as SettingsV2);

    const migrator = new JsonFileStorage(userData, null, 2);
    await runMigrationBarrier(migrator); // first launch migrates

    const subsPath = join(userData, fileNames.subscriptions);
    const settingsPath = join(userData, fileNames.settings);
    const subsAfterFirst = await readFile(subsPath, "utf8");
    const settingsAfterFirst = await readFile(settingsPath, "utf8");
    const backupsAfterFirst = (await migrator.listBackups()).length;

    // Second launch: barrier is now a no-op pass (== current), no re-migrate,
    // no new backup, bytes unchanged.
    await runMigrationBarrier(migrator);
    expect(await readFile(subsPath, "utf8")).toBe(subsAfterFirst);
    expect(await readFile(settingsPath, "utf8")).toBe(settingsAfterFirst);
    expect((await migrator.listBackups()).length).toBe(backupsAfterFirst);
  });

  it("a migration fault surfaces a typed error so the launch can degrade (no reader on bad state)", async () => {
    // A v1 subscription with an unknown currency cannot be migrated.
    const subsPath = join(userData, fileNames.subscriptions);
    const v1File = {
      version: 1,
      subscriptions: [v1Subscription({ id: "x", currency: "ZZZ", amount: 10 })],
    };
    await writeFile(subsPath, JSON.stringify(v1File), "utf8");
    const before = await readFile(subsPath, "utf8");

    const migrator = new JsonFileStorage(userData, null, 2);

    // The barrier propagates the typed storage error. The caller (main.ts launch
    // sequence) catches this, degrades to evt:error, and does NOT start the
    // scheduler on un-migrated state.
    await expect(runMigrationBarrier(migrator)).rejects.toBeInstanceOf(
      StorageMigrationError,
    );

    // The original file is untouched (no write-back happened) and the
    // pre-migration backup survives.
    expect(await readFile(subsPath, "utf8")).toBe(before);
    expect((await readJson(subsPath)).version).toBe(1);
    const backups = await migrator.listBackups();
    expect(backups.length).toBeGreaterThan(0);
  });
});
