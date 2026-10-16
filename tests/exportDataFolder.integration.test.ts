import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAppServices, type AppServices } from "../electron/appWiring";
import { JsonFileStorage } from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import type { ExportFile } from "core/export";
import { planImport } from "core/import";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";

/**
 * Integration tests for export-to-chosen-path and data-folder switching
 * (Task 30.1).
 *
 * Exercises the `AppServices` + {@link JsonFileStorage} layer against REAL,
 * fresh temporary directories (`os.tmpdir()` + `fs.mkdtemp`, removed
 * afterEach). Assertions are concrete on the filesystem: the export string is
 * written to a user-chosen path with `node:fs` and then stat/read/parsed back,
 * and the data-folder switch is verified by checking which directory the
 * `subscriptions.json` file physically appears in.
 *
 * Requirements covered:
 *   - 15.3 : Changing the data folder uses the new location for subsequent
 *            data file operations.
 *   - 17.1 : Export writes all subscriptions (and settings) to a chosen path.
 *   - 17.2 : Export honors the selected format (JSON or CSV).
 */

/** True when a path exists and is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Build a complete, schema-valid subscription for seeding. */
function makeSubscription(
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
let chosenDir: string;
let storage: JsonFileStorage;
let services: AppServices;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-export-userdata-"));
  chosenDir = await mkdtemp(join(tmpdir(), "subby-export-chosen-"));
  storage = new JsonFileStorage(userData, null, 2);
  services = buildAppServices(storage);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
  await rm(chosenDir, { recursive: true, force: true });
});

describe("Export to a chosen path (Req 17.1, 17.2)", () => {
  it("writes JSON export containing all subscriptions and settings to the chosen path", async () => {
    const subs = [
      makeSubscription({ id: "sub-1", name: "Netflix" }),
      makeSubscription({ id: "sub-2", name: "Spotify", category: "Music", amountMinor: 11900 }),
    ];
    await storage.writeSubscriptions(subs);

    // The renderer/main flow: get the serialized string, then write it to the
    // user-chosen location (Req 17.1, 17.2).
    const json = await services.exportData("json");
    const exportPath = join(chosenDir, "subby-export.json");
    await writeFile(exportPath, json, "utf8");

    // The file physically exists at the chosen path.
    expect(await isFile(exportPath)).toBe(true);

    // Its parsed contents carry every subscription and the settings (Req 17.1).
    const parsed = JSON.parse(await readFile(exportPath, "utf8")) as ExportFile;
    expect(parsed.subscriptions.map((s) => s.id).sort()).toEqual(["sub-1", "sub-2"]);
    expect(parsed.subscriptions.map((s) => s.name).sort()).toEqual(["Netflix", "Spotify"]);
    expect(parsed.settings).toMatchObject(DEFAULT_SETTINGS_V2);
  });

  it("the written JSON export round-trips value-exact through the REAL planImport (Req 17.3 / FR-17)", async () => {
    const subs = [
      makeSubscription({ id: "sub-1", name: "Netflix", amountMinor: 49900, currency: "INR" }),
      makeSubscription({ id: "sub-2", name: "Spotify", category: "Music", amountMinor: 11900, currency: "INR" }),
    ];
    await storage.writeSubscriptions(subs);

    const exportPath = join(chosenDir, "subby-export.json");
    await writeFile(exportPath, await services.exportData("json"), "utf8");

    // The written file is still a MAJOR-decimal v3 export (e.g. 49900 INR →
    // "499.00") — assert that before proving the end-to-end round-trip.
    const file = JSON.parse(await readFile(exportPath, "utf8")) as ExportFile;
    const byId = new Map(file.subscriptions.map((r) => [r.id, r]));
    for (const sub of subs) {
      const r = byId.get(sub.id)!;
      expect(typeof r.amount).toBe("string");
      expect(r.amount).toContain(".");
    }

    // Story 7.2 restores the REAL end-to-end proof: read the written file back
    // through `planImport` (into an empty set, Replace). The importer
    // reconstructs integer minor units via `core/money.minorUnits`, so the
    // reconstructed set equals the originals value-exact.
    const raw = await readFile(exportPath, "utf8");
    const outcome = planImport([], raw, "json", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(subs.length);
    const reconById = new Map(outcome.applied.map((s) => [s.id, s]));
    for (const sub of subs) {
      expect(reconById.get(sub.id)).toEqual(sub);
    }
  });

  it("writes CSV export with a header row plus one row per subscription to the chosen path", async () => {
    const subs = [
      makeSubscription({ id: "sub-1", name: "Netflix" }),
      makeSubscription({ id: "sub-2", name: "Spotify", category: "Music", amountMinor: 11900 }),
      makeSubscription({ id: "sub-3", name: "Disney+", category: "Streaming", amountMinor: 29900 }),
    ];
    await storage.writeSubscriptions(subs);

    const csv = await services.exportData("csv");
    const exportPath = join(chosenDir, "subby-export.csv");
    await writeFile(exportPath, csv, "utf8");

    expect(await isFile(exportPath)).toBe(true);

    const fromDisk = await readFile(exportPath, "utf8");
    const lines = fromDisk.split("\r\n");

    // Header row + one row per subscription (Req 17.2).
    expect(lines).toHaveLength(subs.length + 1);
    expect(lines[0]).toContain("name");
    expect(lines[0]).toContain("amount");

    // Each subscription has a corresponding data row.
    for (const sub of subs) {
      expect(fromDisk).toContain(sub.name);
    }
  });

  it("the written CSV export round-trips value-exact through the REAL planImport (Req 17.3 / FR-17)", async () => {
    const subs = [
      makeSubscription({ id: "sub-1", name: "Netflix", amountMinor: 49900, currency: "INR" }),
      makeSubscription({ id: "sub-2", name: "Spotify", category: "Music", amountMinor: 11900, currency: "INR" }),
    ];
    await storage.writeSubscriptions(subs);

    const exportPath = join(chosenDir, "subby-export.csv");
    await writeFile(exportPath, await services.exportData("csv"), "utf8");

    const fromDisk = await readFile(exportPath, "utf8");
    const lines = fromDisk.split("\r\n");
    const header = lines[0].split(",");
    const amountCol = header.indexOf("amount");

    // The money column header is the human `amount` (renamed in place), and each
    // cell is a MAJOR decimal (49900 INR → "499.00", 11900 → "119.00").
    expect(amountCol).toBeGreaterThanOrEqual(0);
    expect(header).not.toContain("amountMinor");
    const idCol = header.indexOf("id");
    const byId = new Map(lines.slice(1).map((line) => {
      const cells = line.split(",");
      return [cells[idCol], cells] as const;
    }));
    expect(byId.get("sub-1")![amountCol]).toBe("499.00");
    expect(byId.get("sub-2")![amountCol]).toBe("119.00");

    // Story 7.2 restores the REAL end-to-end proof: read the written CSV back
    // through `planImport`, which reconstructs integer minor units via
    // `core/money.minorUnits`, so the reconstructed set equals the originals.
    const outcome = planImport([], fromDisk, "csv", "Replace");
    expect(outcome.rejected).toEqual([]);
    expect(outcome.imported).toBe(subs.length);
    const reconById = new Map(outcome.applied.map((s) => [s.id, s]));
    for (const sub of subs) {
      expect(reconById.get(sub.id)).toEqual(sub);
    }
  });
});

describe("Data folder switch uses the new location (Req 15.3)", () => {
  it("setDataFolder switches getDataFolder() and routes subsequent file ops to the new dir", async () => {
    // Start in dir A: seed subscriptions there.
    expect(storage.getDataFolder()).toBe(userData);
    await storage.writeSubscriptions([makeSubscription({ id: "a", name: "InA" })]);
    expect(await isFile(join(userData, fileNames.subscriptions))).toBe(true);

    // Switch to dir B (a second temp dir).
    await services.setDataFolder(chosenDir);
    expect(storage.getDataFolder()).toBe(chosenDir);

    // Subsequent writes land in dir B, not dir A.
    await storage.writeSubscriptions([makeSubscription({ id: "b", name: "InB" })]);
    expect(await isFile(join(chosenDir, fileNames.subscriptions))).toBe(true);

    // Reading now returns the data written to the NEW location, independent of A.
    const readBack = await storage.readSubscriptions();
    expect(readBack.map((s) => s.id)).toEqual(["b"]);

    // Dir A still holds its own, untouched copy ([a]).
    const aFile = JSON.parse(
      await readFile(join(userData, fileNames.subscriptions), "utf8"),
    ) as { subscriptions: SubscriptionV2[] };
    expect(aFile.subscriptions.map((s) => s.id)).toEqual(["a"]);
  });

  it("setDataFolder persists the dataFolder into settings at the new location", async () => {
    await services.setDataFolder(chosenDir);

    // The returned settings record the new folder.
    const merged = await services.getSettings();
    expect(merged.dataFolder).toBe(chosenDir);

    // And it is persisted to settings.json under the new directory (Req 15.2, 15.3).
    expect(await isFile(join(chosenDir, fileNames.settings))).toBe(true);
    const settingsFile = JSON.parse(
      await readFile(join(chosenDir, fileNames.settings), "utf8"),
    ) as SettingsV2;
    expect(settingsFile.dataFolder).toBe(chosenDir);
  });

  it("reading from the new location is independent of the old location's data", async () => {
    // Seed distinct data in A.
    await storage.writeSubscriptions([
      makeSubscription({ id: "old-1", name: "Old1" }),
      makeSubscription({ id: "old-2", name: "Old2" }),
    ]);

    // Switch to B and write a single, different subscription.
    await services.setDataFolder(chosenDir);
    await storage.writeSubscriptions([makeSubscription({ id: "new-1", name: "New1" })]);

    // Confirm B sees only its own data.
    expect((await storage.readSubscriptions()).map((s) => s.id)).toEqual(["new-1"]);

    // Switch back to A: its original two subscriptions are intact and unaffected.
    await services.setDataFolder(userData);
    expect(storage.getDataFolder()).toBe(userData);
    expect((await storage.readSubscriptions()).map((s) => s.id).sort()).toEqual([
      "old-1",
      "old-2",
    ]);
  });
});
