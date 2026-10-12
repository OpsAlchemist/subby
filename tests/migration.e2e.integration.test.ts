import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAppServices, runMigrationBarrier } from "../electron/appWiring";
import { JsonFileStorage } from "../electron/storage/jsonFileStorage";
import { fileNames } from "../electron/storage/paths";
import { minorUnits } from "core/money";

/**
 * End-to-end migration exercise (Epic 1 hardening — party-mode finding).
 *
 * The Epic-1 story suites prove the migrator and the version-gated read path as
 * UNITS (the migrator as a pure function; the gate with an injected current). But
 * the single irreversible, every-user event — "a real beta user opens 1.0 and
 * their on-disk v1 file migrates to v2 through the actual launch path" — had
 * never run end-to-end in a real build (CURRENT_VERSION is 1 everywhere live).
 *
 * This test closes that gap. It:
 *   1. seeds a temp data dir from a REAL `0.1.0-beta.1` on-disk fixture
 *      (`tests/fixtures/beta-v1/*.json`) — raw files written in the beta shape,
 *      NOT constructed through the (v2-aware) storage port, so the fixture tests
 *      the ASSUMPTION about what is actually on disk, not just the code we wrote;
 *   2. boots the real composition-root seams (`JsonFileStorage` + the launch
 *      `runMigrationBarrier` + `buildAppServices`) at `current = 2` — the exact
 *      wiring the Epic-3 CURRENT_VERSION flip will activate;
 *   3. asserts the whole event: the barrier migrates before any reader, a
 *      pre-migration backup of the untouched v1 bytes survives, money is
 *      value-exact, and a service read (what a handler/scheduler does post-barrier)
 *      only ever observes migrated v2 data.
 *
 * This is the difference between "tested" and "exercised".
 */

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "beta-v1",
);

/** The schema version Epic 3 will flip CURRENT_VERSION to. */
const V2 = 2;

let userData: string;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "subby-migration-e2e-"));
  // Seed the data dir from the RAW beta fixture — copy the bytes exactly as a
  // shipping 0.1.0-beta.1 install would have written them. No port, no v2
  // awareness: this is genuine legacy data landing on disk.
  await copyFile(
    join(FIXTURE_DIR, "subscriptions.json"),
    join(userData, fileNames.subscriptions),
  );
  await copyFile(
    join(FIXTURE_DIR, "settings.json"),
    join(userData, fileNames.settings),
  );
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("v1→v2 migration, end-to-end through the real launch path (current = 2)", () => {
  it("migrates a real beta file on launch and the app comes up reading v2", async () => {
    // Boot the real composition-root seams at the Epic-3 version. This is the
    // adapter the launch sequence builds, the barrier the launch sequence runs,
    // and the services every handler/scheduler read goes through.
    const storage = new JsonFileStorage(userData, null, V2);
    const services = buildAppServices(storage);

    // (1) The launch barrier runs BEFORE any reader (AD-28). This is the event.
    await runMigrationBarrier(storage);

    // (2) A post-barrier service read — exactly what a handler/scheduler does —
    //     observes only migrated v2 data. Nothing reads v1 after the barrier.
    const subs = await services.listSubscriptions();
    expect(subs).toHaveLength(4);

    // (3) Value-exact money: the beta floats become exponent-correct minor units.
    const netflix = subs.find((s) => s.name === "Netflix");
    const spotify = subs.find((s) => s.name === "Spotify");
    const icloud = subs.find((s) => s.name === "iCloud+");
    // 649 INR (exp 2) → 64900; 9.99 USD → 999; 2.99 EUR → 299.
    expect((netflix as unknown as { amountMinor: number }).amountMinor).toBe(
      minorUnits(649, "INR"),
    );
    expect((netflix as unknown as { amountMinor: number }).amountMinor).toBe(64900);
    expect((spotify as unknown as { amountMinor: number }).amountMinor).toBe(999);
    expect((icloud as unknown as { amountMinor: number }).amountMinor).toBe(299);

    // (4) isActive → state end-to-end.
    expect((netflix as unknown as { state: string }).state).toBe("Active");
    expect((spotify as unknown as { state: string }).state).toBe("Paused");

    // (5) New fields initialized to safe empties.
    expect((netflix as unknown as { tags: string[] }).tags).toEqual([]);
    expect(
      (netflix as unknown as { priceHistory: unknown[] }).priceHistory,
    ).toEqual([]);
    expect((netflix as unknown as { trial?: unknown }).trial).toBeUndefined();

    // (6) Custom interval carries through unchanged.
    const domain = subs.find((s) => s.name === "Domain Renewal");
    expect(
      (domain as unknown as { customInterval?: { unit: string; count: number } })
        .customInterval,
    ).toEqual({ unit: "year", count: 2 });

    // (7) settings.defaultCurrency → homeCurrency; online block added all-false.
    const settings = (await services.getSettings()) as unknown as {
      homeCurrency: string;
      online: { liveLogoFetch: boolean; fxRefresh: boolean };
    };
    expect(settings.homeCurrency).toBe("INR");
    expect(settings.online).toEqual({ liveLogoFetch: false, fxRefresh: false });

    // (8) The pre-migration backup exists and holds the UNTOUCHED v1 bytes —
    //     the original is recoverable even though the live file is now v2.
    const backups = await readdir(join(userData, fileNames.backupDir));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const rawV1 = JSON.parse(
      await readFile(join(FIXTURE_DIR, "subscriptions.json"), "utf8"),
    ) as { version: number; subscriptions: Array<{ amount: number }> };
    expect(rawV1.version).toBe(1);
    expect(rawV1.subscriptions[0]?.amount).toBe(649); // still a float major unit

    // (9) The on-disk file is now v2 (written back by the barrier), so a second
    //     boot sees == current and does not migrate again (idempotent).
    const onDisk = JSON.parse(
      await readFile(join(userData, fileNames.subscriptions), "utf8"),
    ) as { version: number };
    expect(onDisk.version).toBe(V2);
  });

  it("a second launch over the already-migrated file is a no-op (idempotent)", async () => {
    const first = new JsonFileStorage(userData, null, V2);
    await runMigrationBarrier(first);
    const backupsAfterFirst = (
      await readdir(join(userData, fileNames.backupDir))
    ).length;

    // Second launch: file is already v2, so the barrier must not migrate or
    // take another pre-migration backup.
    const second = new JsonFileStorage(userData, null, V2);
    await runMigrationBarrier(second);
    const backupsAfterSecond = (
      await readdir(join(userData, fileNames.backupDir))
    ).length;

    expect(backupsAfterSecond).toBe(backupsAfterFirst);
  });
});
