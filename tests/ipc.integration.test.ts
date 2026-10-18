import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A fake `ipcMain` whose `handle`/`removeHandler` back a plain Map so the real
 * `registerIpcHandlers` can be driven and a channel invoked directly (Story 7.3
 * `backup:create` round-trip). `webContents.send` on the fake window records
 * broadcasts so `evt:dataChanged` emission can be asserted. The rest of this
 * suite imports `buildAppServices`/`JsonFileStorage` which only touch `electron`
 * via a degrade-to-null `app` path, so this mock keeps every existing test green.
 */
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const sentChannels: string[] = [];
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
  },
  BrowserWindow: class {},
}));

import { buildAppServices, type AppServices } from "../electron/appWiring";
import { JsonFileStorage } from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import { parsePriceSeed, type PriceSeed } from "core/priceSeed";
import { parseBundledSnapshot, type BundledFxSnapshot } from "core/fxSnapshot";
import { parseLogoPack, type LogoPack } from "core/logo";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { SubscriptionInput } from "shared/types";
import type { SubbyApi } from "shared/subbyApi";

/**
 * Integration tests for IPC round-trips and destructive-op sequencing (Task 13.4).
 *
 * Mocking the full Electron `ipcMain`/`ipcRenderer` transport is heavy and adds
 * little: the IPC handlers (`electron/ipc/handlers.ts`) are a THIN wrapper that
 * forwards each channel to a single {@link AppServices} method and wraps the
 * result in an `IpcResult`. The valuable, robust integration boundary is the
 * `AppServices` + {@link StoragePort} layer that the handlers wrap. These tests
 * exercise that layer end-to-end against a REAL {@link JsonFileStorage} backed
 * by a fresh temp directory (`os.tmpdir()` + `fs.mkdtemp`, removed afterEach).
 *
 * Two additional source-level checks document the renderer↔main contract that
 * cannot be exercised in a Node test env (no Electron runtime):
 *   - the preload facade forwards ONLY via centralized channel constants, and
 *   - the renderer (`src/`) never imports `fs`/`path`/`electron` directly.
 *
 * Requirements covered:
 *   - 2.3 : Electron main performs all JSON file I/O (every op round-trips
 *           through the storage adapter the handlers wrap).
 *   - 2.4 : Renderer requests data operations over the typed bridge facade.
 *   - 2.5 : Renderer accesses the filesystem only through the main process.
 *   - 3.3 : Delete backs up before removing.
 *   - 16.4: Import backs up before applying.
 *   - 18.1: Backups are timestamped files.
 *   - 18.2: Restore replaces current subscriptions from a selected backup.
 *   - 18.3: Restore backs up current data before applying.
 */

/** Build a complete, schema-valid v2 subscription for direct storage seeding. */
function makeSubscription(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
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

/** Build a user-supplied v2 subscription input (no system-managed fields). */
function makeInput(overrides: Partial<SubscriptionInput> = {}): SubscriptionInput {
  return {
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMajor: "499",
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
    ...overrides,
  };
}

let userData: string;
let storage: JsonFileStorage;
let services: AppServices;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-ipc-"));
  storage = new JsonFileStorage(userData);
  // Pin BOTH bundled loaders to null (no price seed, no FX snapshot). Before
  // Story 7.3 this file didn't mock `electron`, so the default loaders threw on
  // an undefined `app` and silently yielded null. The new `vi.mock("electron")`
  // (needed to drive `registerIpcHandlers` for the backup:create round-trip)
  // supplies a working `app`, which would otherwise re-point the DEFAULT loaders
  // at the real shipped resources/ files — a hidden coupling for this suite,
  // whose price/FX tests always pass explicit seeds. Keep the default-param
  // services seed-free so this suite stays isolated from resources/ contents.
  services = buildAppServices(storage, null, null);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(userData, { recursive: true, force: true });
});

describe("AppServices subscription round-trips (Req 2.3)", () => {
  it("create -> list reflects the new subscription", async () => {
    const before = await services.listSubscriptions();
    expect(before).toEqual([]);

    const next = await services.createSubscription(makeInput({ name: "Spotify" }));
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe("Spotify");
    expect(next[0].id).toBeTruthy();
    // createdAt === updatedAt on creation.
    expect(next[0].createdAt).toBe(next[0].updatedAt);

    // Persisted: a fresh read through the adapter returns the same data.
    const listed = await services.listSubscriptions();
    expect(listed).toEqual(next);
  });

  it("update changes fields and advances updatedAt", async () => {
    const created = await services.createSubscription(makeInput({ name: "Spotify" }));
    const id = created[0].id;
    const originalUpdatedAt = created[0].updatedAt;

    // Ensure a strictly later wall-clock instant for updatedAt.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(originalUpdatedAt) + 60_000));

    const updated = await services.updateSubscription(id, { name: "Spotify Family", amountMinor: 19900 });
    vi.useRealTimers();

    const target = updated.find((s) => s.id === id)!;
    expect(target.name).toBe("Spotify Family");
    expect(target.amountMinor).toBe(19900);
    expect(Date.parse(target.updatedAt)).toBeGreaterThan(Date.parse(originalUpdatedAt));

    const listed = await services.listSubscriptions();
    expect(listed.find((s) => s.id === id)!.name).toBe("Spotify Family");
  });

  it("Trial→Active convert round-trips: persists state Active with NO trial key (Story 5.1)", async () => {
    // Seed a Trial subscription directly (schema-valid: trial present iff Trial).
    await storage.writeSubscriptions([
      makeSubscription({
        id: "t1",
        name: "Notion",
        state: "Trial",
        amountMinor: 0,
        trial: { endDate: "2026-12-31", postAmountMinor: 2000 },
      }),
    ]);

    // The live convert path: `subs:update` with Active + the post amount + a
    // cleared trial (exactly the patch the List "Convert to Active" sends).
    const updated = await services.updateSubscription("t1", {
      state: "Active",
      amountMinor: 2000,
      trial: undefined,
    });
    const target = updated.find((s) => s.id === "t1")!;
    expect(target.state).toBe("Active");
    expect(target.amountMinor).toBe(2000);
    // In-memory, the patch's explicit `trial: undefined` clears the value (the
    // key may still exist with value undefined — it is dropped on serialize).
    expect(target.trial).toBeUndefined();

    // Re-read through the adapter: the persisted record is Active and carries
    // NO `trial` key (the invariant "trial absent unless state Trial" holds —
    // `JSON.stringify` drops the `undefined` key on write).
    const listed = await services.listSubscriptions();
    const persisted = listed.find((s) => s.id === "t1")!;
    expect(persisted.state).toBe("Active");
    expect(persisted.amountMinor).toBe(2000);
    expect("trial" in persisted).toBe(false);
    expect(persisted.trial).toBeUndefined();

    // The on-disk JSON itself has no `trial` key for the converted record.
    const raw = JSON.parse(
      await readFile(join(userData, "subscriptions.json"), "utf8"),
    ) as { subscriptions: Array<Record<string, unknown>> };
    const diskRecord = raw.subscriptions.find((s) => s.id === "t1")!;
    expect("trial" in diskRecord).toBe(false);
  });

  it("setState changes the state and persists", async () => {
    const created = await services.createSubscription(makeInput({ state: "Active" }));
    const id = created[0].id;

    const toggled = await services.setState(id, "Paused");
    expect(toggled.find((s) => s.id === id)!.state).toBe("Paused");

    const listed = await services.listSubscriptions();
    expect(listed.find((s) => s.id === id)!.state).toBe("Paused");
  });

  it("delete removes exactly the targeted subscription", async () => {
    await storage.writeSubscriptions([
      makeSubscription({ id: "a", name: "A" }),
      makeSubscription({ id: "b", name: "B" }),
    ]);

    const next = await services.deleteSubscription("a");
    expect(next.map((s) => s.id)).toEqual(["b"]);

    const listed = await services.listSubscriptions();
    expect(listed.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("AppServices category round-trips (Req 2.3)", () => {
  it("createCategory -> listCategories includes it; deleteCategory removes it", async () => {
    const before = await services.listCategories();
    expect(before.length).toBeGreaterThan(0); // default categories bootstrapped

    const created = await services.createCategory("Newsletters");
    expect(created.ok).toBe(true);

    const afterCreate = await services.listCategories();
    expect(afterCreate.map((c) => c.name)).toContain("Newsletters");

    // The new category is not assigned to any subscription, so deletion needs
    // no confirmation.
    const newCat = afterCreate.find((c) => c.name === "Newsletters")!;
    const outcome = await services.deleteCategory(newCat.id);
    expect(outcome.ok).toBe(true);

    const afterDelete = await services.listCategories();
    expect(afterDelete.map((c) => c.name)).not.toContain("Newsletters");
  });

  it("createCategory rejects a duplicate name", async () => {
    const cats = await services.listCategories();
    const existingName = cats[0].name;

    const result = await services.createCategory(existingName);
    expect(result.ok).toBe(false);
  });
});

describe("AppServices settings round-trips (Req 2.3)", () => {
  it("getSettings returns defaults; updateSettings persists the patch", async () => {
    const settings = await services.getSettings();
    expect(settings).toMatchObject(DEFAULT_SETTINGS_V2);

    const merged = await services.updateSettings({ theme: "light", accentColor: "#00FF00" });
    expect(merged.theme).toBe("light");
    expect(merged.accentColor).toBe("#00FF00");

    const reread = await services.getSettings();
    expect(reread.theme).toBe("light");
    expect(reread.accentColor).toBe("#00FF00");
  });
});

describe("AppServices suggested-price lookup (FR-13, Story 5.4)", () => {
  /** A tiny valid seed for the lookup-only service. */
  function makeSeed(): PriceSeed {
    return parsePriceSeed({
      schemaVersion: 1,
      asOf: "2026-10-01",
      disclaimer: "Approximate typical prices, verify your own plan.",
      services: {
        netflix: { amountMinor: 1549, currency: "USD", billingCycle: "Monthly" },
        spotify: { amountMinor: 1199, currency: "USD", billingCycle: "Monthly" },
      },
    });
  }

  it("a known name returns the suggestion (entry + seed asOf); normalized trim/case", () => {
    const svc = buildAppServices(storage, makeSeed());
    expect(svc.getPriceSuggestion("  Netflix ")).toEqual({
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly",
      asOf: "2026-10-01",
    });
    expect(svc.getPriceSuggestion("SPOTIFY")!.amountMinor).toBe(1199);
  });

  it("an unknown name returns null (silent miss, no fuzzy)", () => {
    const svc = buildAppServices(storage, makeSeed());
    expect(svc.getPriceSuggestion("MyCustomThing")).toBeNull();
    expect(svc.getPriceSuggestion("net")).toBeNull();
  });

  it("a missing/corrupt seed (null) returns null for ANY name without throwing", () => {
    // Simulate the main-process degrade-off: the loader yielded null (seed
    // missing/corrupt). Every lookup is a quiet null — the feature is off, Add
    // works normally.
    const svc = buildAppServices(storage, null);
    expect(svc.getPriceSuggestion("Netflix")).toBeNull();
    expect(svc.getPriceSuggestion("")).toBeNull();
    expect(() => svc.getPriceSuggestion("anything")).not.toThrow();
  });
});

describe("AppServices FX snapshot (Story 6.1)", () => {
  /** A tiny valid EUR-based bundled snapshot (USD, EUR, INR). */
  function makeSnapshot(): BundledFxSnapshot {
    return parseBundledSnapshot({
      schemaVersion: 1,
      asOf: "2026-10-01",
      base: "EUR",
      attribution: "Test ECB reference rates, bundled offline, read-only.",
      rates: { EUR: "1", USD: "1.0950", INR: "91.350" },
    });
  }

  it("a Home currency returns the rebased snapshot (Home → 1), carrying asOf", () => {
    const svc = buildAppServices(storage, null, makeSnapshot());
    const snap = svc.getFxSnapshot("USD");
    expect(snap).not.toBeNull();
    // Home anchor: USD → exactly "1".
    expect(snap!.rates.USD).toBe("1");
    expect(snap!.asOf).toBe("2026-10-01");
    // EUR in USD major units = eurRate[USD] / eurRate[EUR] = 1.0950 / 1 = 1.0950…
    expect(Number(snap!.rates.EUR)).toBeCloseTo(1.095, 4);
    // INR in USD = 1.0950 / 91.350 ≈ 0.011987…
    expect(Number(snap!.rates.INR)).toBeCloseTo(1.095 / 91.35, 6);
  });

  it("an unknown/absent Home Currency returns null without throwing (degrade)", () => {
    const svc = buildAppServices(storage, null, makeSnapshot());
    // GBP is a known currency but absent from this snapshot's rates.
    expect(svc.getFxSnapshot("GBP")).toBeNull();
    // A currency not in the exponent table at all.
    expect(() => svc.getFxSnapshot("ZZZ")).not.toThrow();
    expect(svc.getFxSnapshot("ZZZ")).toBeNull();
  });

  it("a missing/corrupt bundle (null) returns null for ANY Home without throwing", () => {
    // Simulate the main-process degrade-off: the loader yielded null.
    const svc = buildAppServices(storage, null, null);
    expect(svc.getFxSnapshot("USD")).toBeNull();
    expect(svc.getFxSnapshot("INR")).toBeNull();
    expect(() => svc.getFxSnapshot("anything")).not.toThrow();
  });

  it("`fx:snapshot` is a registered read-only channel constant", async () => {
    const { CH } = await import("../electron/ipc/channels");
    expect(CH.fx.snapshot).toBe("fx:snapshot");
  });
});

describe("AppServices Logo Pack (Story 8.3)", () => {
  /** A tiny valid Logo Pack fixture (one bundled brand). */
  function makePack(): LogoPack {
    return parseLogoPack({
      version: 1,
      generatedAt: "2026-10-18T00:00:00.000Z",
      note: "test fixture pack",
      icons: {
        "netflix.com": { title: "Netflix", hex: "E50914", path: "M0 0h24v24H0z" },
      },
    });
  }

  it("getLogoPack() returns the injected pack verbatim (lock-free, read-only)", () => {
    const pack = makePack();
    const svc = buildAppServices(storage, null, null, pack);
    expect(svc.getLogoPack()).toBe(pack);
    expect(svc.getLogoPack().icons["netflix.com"].title).toBe("Netflix");
  });

  it("`logos:pack` handler returns { ok: true, data: pack } (no broadcast)", async () => {
    const { registerIpcHandlers } = await import("../electron/ipc/handlers");
    const { CH } = await import("../electron/ipc/channels");

    ipcHandlers.clear();
    sentChannels.length = 0;

    const pack = makePack();
    const svc = buildAppServices(storage, null, null, pack);
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: (channel: string) => sentChannels.push(channel) },
    };
    registerIpcHandlers(svc, () => fakeWin as never);

    expect(CH.logos.pack).toBe("logos:pack");
    const listener = ipcHandlers.get(CH.logos.pack);
    expect(listener).toBeTypeOf("function");

    const result = (await listener!({} as never)) as {
      ok: boolean;
      data?: LogoPack;
    };
    expect(result.ok).toBe(true);
    expect(result.data).toBe(pack);
    // READ-ONLY: a read never broadcasts evt:dataChanged.
    expect(sentChannels).not.toContain(CH.events.dataChanged);
  });
});

describe("AppServices export / import round-trips (Req 2.3)", () => {
  it("exportData('json') returns an importer-compatible string", async () => {
    await services.createSubscription(makeInput({ name: "Disney+" }));

    const json = await services.exportData("json");
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json) as { subscriptions: SubscriptionV2[]; settings: SettingsV2 };
    expect(parsed.subscriptions.map((s) => s.name)).toContain("Disney+");
    expect(parsed.settings).toMatchObject(DEFAULT_SETTINGS_V2);
  });

  it("exportData('csv') returns a CSV string with a header row", async () => {
    await services.createSubscription(makeInput({ name: "Disney+" }));
    const csv = await services.exportData("csv");
    expect(csv.split("\r\n")[0]).toContain("name");
    expect(csv).toContain("Disney+");
  });

  it("applyImport applies a new subscription from a JSON payload", async () => {
    const incoming = makeSubscription({ id: "imp-1", name: "HBO Max" });
    const raw = JSON.stringify({
      version: 1,
      subscriptions: [incoming],
      settings: DEFAULT_SETTINGS,
    });

    const outcome = await services.applyImport(raw, "json", "Replace");
    expect(outcome.imported).toBe(1);
    expect(outcome.rejected).toEqual([]);

    const listed = await services.listSubscriptions();
    expect(listed.map((s) => s.id)).toContain("imp-1");
  });
});

describe("AppServices backup list / restore round-trips (Req 18.2)", () => {
  it("restoreBackup replaces current subscriptions with the selected backup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T10:00:00.000Z"));

    const snapshot = [
      makeSubscription({ id: "a", name: "A" }),
      makeSubscription({ id: "b", name: "B" }),
    ];
    await storage.writeSubscriptions(snapshot);
    const snapshotName = await storage.createBackup("snapshot"); // 2025-01-01-10-00.json

    // Mutate current data to a different state.
    vi.setSystemTime(new Date("2025-01-01T10:05:00.000Z"));
    await storage.writeSubscriptions([makeSubscription({ id: "a", name: "A" })]);

    const backups = await services.listBackups();
    expect(backups).toContain(snapshotName);

    // Restoring brings back the snapshot's two subscriptions.
    const restored = await services.restoreBackup(snapshotName);
    vi.useRealTimers();

    expect(restored.map((s) => s.id).sort()).toEqual(["a", "b"]);
    const listed = await services.listSubscriptions();
    expect(listed.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("restoreBackup of a v1 backup migrates it to v2 end-to-end — follow-up read is clean, no corruption (Story 7.4)", async () => {
    // Seed CURRENT (v2) data so a pre-restore backup is distinguishable, then
    // seed a genuine RAW v1 backup on disk (major `amount`) — the exact file the
    // old `readBackup` would have restored un-migrated, corrupting the live file.
    await storage.writeSubscriptions([makeSubscription({ id: "current", name: "Current" })]);
    await storage.ensureTree();

    const v1BackupName = "2025-03-07-09-05-42-137-0000.json";
    await writeFile(
      join(userData, fileNames.backupDir, v1BackupName),
      JSON.stringify({
        version: 1,
        subscriptions: [
          {
            id: "legacy",
            name: "Spotify",
            provider: "Spotify AB",
            category: "Music",
            amount: 9.99, // v1 MAJOR float — must become amountMinor: 999
            currency: "USD",
            billingCycle: "Monthly",
            nextRenewal: "2025-02-01",
            startDate: "2024-01-01",
            paymentMethod: "Card",
            website: "https://spotify.com",
            notes: "",
            color: "#1DB954",
            icon: "spotify",
            isActive: true,
            autoRenew: true,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const backupsBefore = await services.listBackups();

    // Restore the v1 backup: it is migrated v1→v2 (amount 9.99 USD → 999 minor)
    // and written back as a valid v2 set.
    const restored = await services.restoreBackup(v1BackupName);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: "legacy",
      amountMinor: 999,
      currency: "USD",
      state: "Active",
    });

    // THE no-corruption proof: a follow-up read succeeds (does NOT throw a
    // corrupt error) and reflects the migrated set exactly.
    const listed = await services.listSubscriptions();
    expect(listed).toEqual(restored);

    // The on-disk live file is a genuine v2 file (version 2 + integer amountMinor).
    const liveRaw = JSON.parse(
      await readFile(join(userData, fileNames.subscriptions), "utf8"),
    ) as { version: number; subscriptions: Array<Record<string, unknown>> };
    expect(liveRaw.version).toBe(2);
    expect(liveRaw.subscriptions[0]).toMatchObject({ amountMinor: 999 });

    // A pre-restore backup of CURRENT data was taken FIRST (reversible) and now
    // appears in the history (one more backup than before, capturing "current").
    const backupsAfter = await services.listBackups();
    expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    const newest = backupsAfter[0]; // newest = the pre-restore backup
    expect(newest).not.toBe(v1BackupName);
    const preRestore = JSON.parse(
      await readFile(join(userData, fileNames.backupDir, newest), "utf8"),
    ) as { subscriptions: Array<Record<string, unknown>> };
    expect(preRestore.subscriptions.map((s) => s.id)).toEqual(["current"]);
  });
});

describe("backup-before-destructive sequencing (Req 3.3, 16.4, 18.1, 18.3)", () => {
  it("deleteSubscription creates a backup BEFORE writing, capturing pre-delete state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-07T09:05:00.000Z"));

    await storage.writeSubscriptions([
      makeSubscription({ id: "a", name: "A" }),
      makeSubscription({ id: "b", name: "B" }),
    ]);
    const backupsBefore = await storage.listBackups();

    const backupSpy = vi.spyOn(storage, "createBackup");
    const writeSpy = vi.spyOn(storage, "writeSubscriptions");

    await services.deleteSubscription("a");

    // Ordering: backup happened before the destructive write.
    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(backupSpy.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[0],
    );

    // Backup count increased.
    const backupsAfter = await storage.listBackups();
    expect(backupsAfter.length).toBe(backupsBefore.length + 1);

    // Pre-destructive backups do NOT stamp `lastBackupAt` — it tracks ONLY
    // routine (scheduled/manual) backups via `backupNow` (Story 7.3 "Never"
    // boundary). A delete going through `storage.createBackup` directly must
    // leave it untouched, so an unrelated delete can never defer the scheduled
    // cadence.
    expect((await services.getSettings()).lastBackupAt ?? null).toBeNull();

    // The newest backup captured the PRE-delete state ([a, b]).
    const newest = backupsAfter[0];
    const captured = await storage.readBackup(newest);
    vi.useRealTimers();
    expect(captured.subscriptions.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("applyImport creates a backup BEFORE writing, capturing pre-import state (Req 16.4)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-07T11:00:00.000Z"));

    await storage.writeSubscriptions([makeSubscription({ id: "existing", name: "Existing" })]);
    const backupsBefore = await storage.listBackups();

    const backupSpy = vi.spyOn(storage, "createBackup");
    const writeSpy = vi.spyOn(storage, "writeSubscriptions");

    const raw = JSON.stringify({
      version: 1,
      subscriptions: [makeSubscription({ id: "imported", name: "Imported" })],
      settings: DEFAULT_SETTINGS,
    });
    await services.applyImport(raw, "json", "Replace");

    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(backupSpy.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[0],
    );

    const backupsAfter = await storage.listBackups();
    expect(backupsAfter.length).toBe(backupsBefore.length + 1);

    // Pre-import backup does NOT stamp `lastBackupAt` (routine-only; Story 7.3).
    expect((await services.getSettings()).lastBackupAt ?? null).toBeNull();

    const captured = await storage.readBackup(backupsAfter[0]);
    vi.useRealTimers();
    // Pre-import state had only "existing".
    expect(captured.subscriptions.map((s) => s.id)).toEqual(["existing"]);
  });

  it("restoreBackup creates a backup of current data BEFORE applying the restore (Req 18.3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-07T12:00:00.000Z"));

    // Seed a snapshot to restore later.
    await storage.writeSubscriptions([
      makeSubscription({ id: "x", name: "X" }),
      makeSubscription({ id: "y", name: "Y" }),
    ]);
    const snapshotName = await storage.createBackup("snapshot"); // 12-00

    // Change current data so the pre-restore backup is distinguishable.
    vi.setSystemTime(new Date("2025-03-07T12:10:00.000Z"));
    await storage.writeSubscriptions([makeSubscription({ id: "current", name: "Current" })]);
    const backupsBefore = await storage.listBackups();

    const backupSpy = vi.spyOn(storage, "createBackup");
    const writeSpy = vi.spyOn(storage, "writeSubscriptions");

    await services.restoreBackup(snapshotName);

    // Ordering: pre-restore backup before the restoring write.
    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(backupSpy.mock.invocationCallOrder[0]).toBeLessThan(
      writeSpy.mock.invocationCallOrder[0],
    );

    // A new (pre-restore) backup was added that captured the CURRENT state.
    const backupsAfter = await storage.listBackups();
    expect(backupsAfter.length).toBe(backupsBefore.length + 1);
    const preRestore = backupsAfter[0]; // newest = pre-restore backup (12-10)
    const captured = await storage.readBackup(preRestore);
    // Pre-restore backup does NOT stamp `lastBackupAt` (routine-only; Story 7.3).
    expect((await services.getSettings()).lastBackupAt ?? null).toBeNull();
    vi.useRealTimers();
    expect(captured.subscriptions.map((s) => s.id)).toEqual(["current"]);
  });
});

describe("backup:create IPC round-trip (Story 7.3)", () => {
  it("backup:create → backupNow('manual'): writes a backup, stamps lastBackupAt, broadcasts evt:dataChanged, returns IpcResult<string>", async () => {
    const { registerIpcHandlers } = await import("../electron/ipc/handlers");
    const { CH } = await import("../electron/ipc/channels");

    ipcHandlers.clear();
    sentChannels.length = 0;

    // A fake window whose webContents.send records the broadcast channel.
    const fakeWin = {
      isDestroyed: () => false,
      webContents: { send: (channel: string) => sentChannels.push(channel) },
    };
    // Spy so we can assert the handler invokes the ROUTINE path with the
    // "manual" reason (not "scheduled" / a pre-destructive reason) — the reason
    // string is what distinguishes routine from incidental backups.
    const backupNowSpy = vi.spyOn(services, "backupNow");
    registerIpcHandlers(services, () => fakeWin as never);

    // The channel is registered.
    const listener = ipcHandlers.get(CH.data.createBackup);
    expect(CH.data.createBackup).toBe("backup:create");
    expect(listener).toBeTypeOf("function");

    const before = await services.getSettings();
    expect(before.lastBackupAt ?? null).toBeNull();

    // Invoke the handler exactly as ipcMain would (event, ...args).
    const result = (await listener!({} as never)) as {
      ok: boolean;
      data?: string;
    };

    // IpcResult<string>: ok with the new backup's name.
    expect(result.ok).toBe(true);
    expect(typeof result.data).toBe("string");
    expect(result.data).toMatch(/\.json$/);

    // The handler took the ROUTINE manual path (reason "manual"), not scheduled.
    expect(backupNowSpy).toHaveBeenCalledWith("manual");

    // The mutation broadcast fired so every view refreshes (Req 8.6 wiring).
    expect(sentChannels).toContain(CH.events.dataChanged);

    // The backup was taken and lastBackupAt stamped (via backupNow("manual")).
    const backups = await services.listBackups();
    expect(backups).toContain(result.data);
    const after = await services.getSettings();
    expect(after.lastBackupAt).toBeTruthy();
  });

  it("backup:create is in the unregister list (torn down cleanly)", async () => {
    const { registerIpcHandlers, unregisterIpcHandlers } = await import(
      "../electron/ipc/handlers"
    );
    const { CH } = await import("../electron/ipc/channels");

    ipcHandlers.clear();
    registerIpcHandlers(services, () => null);
    expect(ipcHandlers.has(CH.data.createBackup)).toBe(true);

    unregisterIpcHandlers();
    expect(ipcHandlers.has(CH.data.createBackup)).toBe(false);
  });
});

describe("settings:update onSettingsMutated hook (Story 8.1 — CSP-refresh trigger)", () => {
  it("fires the hook exactly once on a successful settings:update", async () => {
    const { registerIpcHandlers } = await import("../electron/ipc/handlers");
    const { CH } = await import("../electron/ipc/channels");

    ipcHandlers.clear();
    sentChannels.length = 0;
    const onSettingsMutated = vi.fn();
    registerIpcHandlers(services, () => null, onSettingsMutated);

    const listener = ipcHandlers.get(CH.settings.update);
    expect(listener).toBeTypeOf("function");

    // A real successful patch over the live services (toggle an online feature).
    const result = (await listener!({} as never, {
      online: { liveLogoFetch: true, fxRefresh: false },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(onSettingsMutated).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the hook when updateSettings fails (result.ok === false)", async () => {
    const { registerIpcHandlers } = await import("../electron/ipc/handlers");
    const { CH } = await import("../electron/ipc/channels");

    ipcHandlers.clear();
    const onSettingsMutated = vi.fn();
    // A services stub whose updateSettings rejects — only this channel is driven.
    const failing = {
      ...services,
      updateSettings: vi.fn(async () => {
        throw new Error("disk full");
      }),
    } as unknown as AppServices;
    registerIpcHandlers(failing, () => null, onSettingsMutated);

    const listener = ipcHandlers.get(CH.settings.update);
    const result = (await listener!({} as never, { trayMode: true })) as {
      ok: boolean;
    };

    expect(result.ok).toBe(false);
    expect(onSettingsMutated).not.toHaveBeenCalled();
  });

  it("still resolves ok:true when the hook itself throws (throw is swallowed)", async () => {
    const { registerIpcHandlers } = await import("../electron/ipc/handlers");
    const { CH } = await import("../electron/ipc/channels");

    ipcHandlers.clear();
    const onSettingsMutated = vi.fn(() => {
      throw new Error("hook boom");
    });
    registerIpcHandlers(services, () => null, onSettingsMutated);

    const listener = ipcHandlers.get(CH.settings.update);
    // A successful patch; the hook throws but must not turn the IPC call into a
    // failure (the hook is a best-effort side effect).
    const result = (await listener!({} as never, { trayMode: true })) as {
      ok: boolean;
    };

    expect(onSettingsMutated).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("renderer↔main contract: typed bridge facade (Req 2.4, 2.5)", () => {
  // Type-level guarantee: every expected name is a real SubbyApi member.
  // If a name drifts from the facade type, the project typecheck fails.
  const EXPECTED_METHODS: readonly (keyof SubbyApi)[] = [
    "listSubscriptions",
    "createSubscription",
    "updateSubscription",
    "deleteSubscription",
    "setState",
    "listCategories",
    "createCategory",
    "updateCategory",
    "deleteCategory",
    "getSettings",
    "updateSettings",
    "chooseDataFolder",
    "getPriceSuggestion",
    "getFxSnapshot",
    "getLogoPack",
    "getLogoCache",
    "enqueueEnrichment",
    "importData",
    "exportData",
    "listBackups",
    "restoreBackup",
    "onDataChanged",
    "onError",
  ];

  it("the preload facade exposes exactly the SubbyApi methods, forwarding only via channel constants (Req 2.4)", async () => {
    const preloadPath = fileURLToPath(new URL("../electron/preload.ts", import.meta.url));
    const source = await readFile(preloadPath, "utf8");

    // Each expected facade method is implemented in the preload.
    for (const method of EXPECTED_METHODS) {
      expect(source).toContain(`${method}:`);
    }

    // Every IPC invocation forwards through the centralized CH.* constants.
    // No raw channel string literals (e.g. "subs:list") reach the renderer.
    const invokeArgs = [...source.matchAll(/ipcRenderer\.invoke\(\s*([^,)\s]+)/g)].map(
      (m) => m[1],
    );
    expect(invokeArgs.length).toBeGreaterThan(0);
    for (const arg of invokeArgs) {
      expect(arg.startsWith("CH.")).toBe(true);
    }

    // Event subscriptions also go through CH.events.* (no raw channel strings).
    const onArgs = [...source.matchAll(/ipcRenderer\.on\(\s*([^,)\s]+)/g)].map((m) => m[1]);
    for (const arg of onArgs) {
      expect(arg.startsWith("CH.events.")).toBe(true);
    }

    // The preload imports the channel-name pattern `subs:`/`cat:`/etc. ONLY via
    // the CH constants module, never as inline string literals in invoke calls.
    const inlineChannelLiteral = /invoke\(\s*["'][a-z]+:/i;
    expect(inlineChannelLiteral.test(source)).toBe(false);
  });

  it("the renderer (src/) never imports fs, path, or electron directly (Req 2.5)", async () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));

    async function collect(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collect(full)));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    }

    const files = await collect(srcDir);
    expect(files.length).toBeGreaterThan(0);

    // Match `import ... from 'fs'` / `require('electron')` style references to
    // forbidden platform modules anywhere in the renderer source.
    const forbidden = /(?:from|require\()\s*["'](?:node:)?(?:fs|path|electron)(?:\/[^"']*)?["']/;

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (forbidden.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
