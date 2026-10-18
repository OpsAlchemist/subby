import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  setSubby,
  toAppError,
  SubbyError,
} from "@/api/subby";
import {
  initStores,
  reloadAll,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  backupsStore,
  errorStore,
} from "@/stores";

import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit tests for client store reactivity (Task 17.2, Req 8.6, 19.4).
 *
 * The stores (`src/stores`) are framework-light plain TS, so they are tested
 * here WITHOUT a DOM. We install a fake {@link SubbyApi} through `setSubby(...)`
 * (the seam exposed by `src/api/subby.ts`) whose `onDataChanged` / `onError`
 * subscriptions CAPTURE their callbacks so the test can fire them manually, and
 * whose `list*` / `get*` methods return controllable {@link IpcResult} data from
 * mutable state the test changes between reloads.
 *
 * Covered:
 *   - 8.6  : `onDataChanged` reloads every store to the current data.
 *   - 19.4 : `onError` surfaces a system error into `errorStore`; a failed
 *            `load()` records the error on the store's own `error` field.
 */

// --- Fake SubbyApi facade -----------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}
function fail<T>(error: AppError): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error });
}

interface FakeApi extends SubbyApi {
  /** Mutable backing data the test changes between reloads. */
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
    backups: string[];
  };
  /** When set, the corresponding `list`/`get` resolves to a failure result. */
  failures: {
    subscriptions: AppError | null;
    categories: AppError | null;
    settings: AppError | null;
  };
  /** Callbacks captured from `onDataChanged` / `onError`. */
  dataChangedListeners: Array<() => void>;
  errorListeners: Array<(error: AppError) => void>;
  /** Fire the captured listeners (simulates a main → renderer broadcast). */
  emitDataChanged(): void;
  emitError(error: AppError): void;
}

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

function makeCategory(overrides: Partial<Category> = {}): Category {
  return { id: "cat-1", name: "Streaming", isDefault: true, ...overrides };
}

function createFakeApi(): FakeApi {
  const fake: FakeApi = {
    state: {
      subscriptions: [makeSubscription({ id: "sub-1", name: "Netflix" })],
      categories: [makeCategory({ id: "cat-1", name: "Streaming" })],
      settings: { ...DEFAULT_SETTINGS_V2 },
      backups: [],
    },
    failures: { subscriptions: null, categories: null, settings: null },
    dataChangedListeners: [],
    errorListeners: [],

    emitDataChanged() {
      for (const cb of this.dataChangedListeners) cb();
    },
    emitError(error) {
      for (const cb of this.errorListeners) cb(error);
    },

    // --- Subscriptions ---
    listSubscriptions: () =>
      fake.failures.subscriptions
        ? fail<SubscriptionV2[]>(fake.failures.subscriptions)
        : ok(fake.state.subscriptions),
    createSubscription: () => ok(fake.state.subscriptions),
    updateSubscription: () => ok(fake.state.subscriptions),
    deleteSubscription: () => ok(fake.state.subscriptions),
    setState: () => ok(fake.state.subscriptions),

    // --- Categories ---
    listCategories: () =>
      fake.failures.categories
        ? fail<Category[]>(fake.failures.categories)
        : ok(fake.state.categories),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    updateCategory: () => ok(fake.state.categories),
    deleteCategory: () => ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: () =>
      fake.failures.settings
        ? fail<SettingsV2>(fake.failures.settings)
        : ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    // --- Suggested price (Story 5.4): default fake returns no suggestion ---
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

    // --- FX snapshot (Story 6.1): not exercised here — a rebased INR snapshot ---
    getFxSnapshot: ((_home: string) =>
      ok({ asOf: new Date().toISOString().slice(0, 10), rates: { INR: "1" } })) as SubbyApi["getFxSnapshot"],

    // --- Logo Pack (Story 8.3): empty pack → every row uses the lettered fallback ---
    getLogoPack: (() =>
      ok({ version: 1, generatedAt: "", note: "", icons: {} })) as SubbyApi["getLogoPack"],

    // --- Logo blob cache + enrichment (Story 8.4): empty cache; enqueue acks ---
    getLogoCache: (() => ok<Record<string, string>>({})) as SubbyApi["getLogoCache"],
    enqueueEnrichment: (() => ok(null)) as SubbyApi["enqueueEnrichment"],

    // --- Data ---
    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>(fake.state.backups),
    restoreBackup: () => ok(fake.state.subscriptions),
    createBackup: () => ok("2026-01-01-00-00-00-000.json"),

    // --- Events: capture the callbacks so the test can fire them ---
    onDataChanged(cb: () => void): Unsubscribe {
      fake.dataChangedListeners.push(cb);
      return () => {
        fake.dataChangedListeners = fake.dataChangedListeners.filter((c) => c !== cb);
      };
    },
    onError(cb: (error: AppError) => void): Unsubscribe {
      fake.errorListeners.push(cb);
      return () => {
        fake.errorListeners = fake.errorListeners.filter((c) => c !== cb);
      };
    },
  };
  return fake;
}

/**
 * Flush pending microtasks until `predicate` holds (or we run out of tries).
 * Store loads are microtask-only (no timers), so awaiting resolved promises is
 * enough to let `load()` -> fetcher -> setState settle deterministically.
 */
async function waitUntil(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

// --- Fixture ------------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

beforeEach(() => {
  fake = createFakeApi();
  setSubby(fake);
});

afterEach(() => {
  teardown?.();
  setSubby(null);
  subscriptionsStore.reset();
  categoriesStore.reset();
  settingsStore.reset();
  backupsStore.reset();
  errorStore.clear();
});

// --- Tests --------------------------------------------------------------------

describe("initStores initial load (Req 8.6)", () => {
  it("populates every data store from the fake facade", async () => {
    teardown = initStores();

    await waitUntil(() => subscriptionsStore.getSnapshot().loaded);
    await waitUntil(() => categoriesStore.getSnapshot().loaded);
    await waitUntil(() => settingsStore.getSnapshot().loaded);

    expect(subscriptionsStore.getSnapshot().data).toEqual(fake.state.subscriptions);
    expect(categoriesStore.getSnapshot().data).toEqual(fake.state.categories);
    expect(settingsStore.getSnapshot().data).toEqual(fake.state.settings);

    // Healthy load: no error, loaded flag set, not loading.
    const snap = subscriptionsStore.getSnapshot();
    expect(snap.error).toBeNull();
    expect(snap.loading).toBe(false);
    expect(snap.loaded).toBe(true);
  });

  it("registers exactly one onDataChanged and one onError listener", () => {
    teardown = initStores();
    expect(fake.dataChangedListeners).toHaveLength(1);
    expect(fake.errorListeners).toHaveLength(1);
  });
});

describe("onDataChanged reactivity (Req 8.6)", () => {
  it("reloads stores to the new data and changes the snapshot reference", async () => {
    teardown = initStores();
    await waitUntil(() => subscriptionsStore.getSnapshot().loaded);

    const before = subscriptionsStore.getSnapshot();
    expect(before.data.map((s) => s.name)).toEqual(["Netflix"]);

    // The main process mutated data, then broadcasts the change.
    fake.state.subscriptions = [
      makeSubscription({ id: "sub-1", name: "Netflix" }),
      makeSubscription({ id: "sub-2", name: "Spotify" }),
    ];
    fake.emitDataChanged();

    await waitUntil(() => subscriptionsStore.getSnapshot().data.length === 2);

    const after = subscriptionsStore.getSnapshot();
    expect(after.data.map((s) => s.name)).toEqual(["Netflix", "Spotify"]);
    // The reload produced a NEW snapshot reference (so React re-renders).
    expect(after).not.toBe(before);
  });

  it("notifies subscribers of a store on reload", async () => {
    teardown = initStores();
    await waitUntil(() => subscriptionsStore.getSnapshot().loaded);

    let notifications = 0;
    const unsubscribe = subscriptionsStore.subscribe(() => {
      notifications += 1;
    });

    fake.state.subscriptions = [makeSubscription({ id: "x", name: "Disney+" })];
    fake.emitDataChanged();
    await waitUntil(() => subscriptionsStore.getSnapshot().data[0]?.name === "Disney+");

    unsubscribe();
    // load() emits at least once (loading=true) then again on completion.
    expect(notifications).toBeGreaterThan(0);
  });

  it("reloads the backupsStore on onDataChanged (restore/back-up refreshes history, Story 7.4)", async () => {
    teardown = initStores();
    await waitUntil(() => backupsStore.getSnapshot().loaded);

    // Initial: empty history.
    expect(backupsStore.getSnapshot().data).toEqual([]);

    // A restore / "Back up now" wrote a backup, then broadcasts the change.
    fake.state.backups = [
      "2026-03-07-09-05-42-137-0000.json",
      "2026-03-06-08-00-00-000-0000.json",
    ];
    fake.emitDataChanged();

    await waitUntil(() => backupsStore.getSnapshot().data.length === 2);
    expect(backupsStore.getSnapshot().data).toEqual(fake.state.backups);
  });
});

describe("onError reactivity (Req 19.4)", () => {
  it("records the broadcast AppError as the latest error", async () => {
    teardown = initStores();
    await waitUntil(() => subscriptionsStore.getSnapshot().loaded);

    expect(errorStore.getSnapshot().latest).toBeNull();

    const appError: AppError = {
      code: "corrupt",
      message: "subscriptions.json is corrupt",
      file: "subscriptions.json",
      canRestoreBackup: true,
    };
    fake.emitError(appError);

    expect(errorStore.getSnapshot().latest).toBe(appError);
  });
});

describe("store load() failure surfaces to the store error field (Req 19.4)", () => {
  it("sets the store's error (via toAppError) without throwing", async () => {
    teardown = initStores();
    await waitUntil(() => subscriptionsStore.getSnapshot().loaded);

    const appError: AppError = {
      code: "io",
      message: "failed to read subscriptions",
      file: "subscriptions.json",
    };
    fake.failures.subscriptions = appError;

    // Reloading should NOT throw even though the fetch resolves to a failure.
    await expect(subscriptionsStore.load()).resolves.toBeUndefined();

    const snap = subscriptionsStore.getSnapshot();
    expect(snap.loading).toBe(false);
    // toAppError preserves the structured AppError from the SubbyError.
    expect(snap.error).toEqual(appError);
  });

  it("a failed reloadAll captures the error per-store without rejecting", async () => {
    teardown = initStores();
    await waitUntil(() => subscriptionsStore.getSnapshot().loaded);

    fake.failures.categories = {
      code: "unknown",
      message: "boom",
    };

    await expect(reloadAll()).resolves.toBeDefined();
    expect(categoriesStore.getSnapshot().error?.message).toBe("boom");
    // Other stores reloaded fine.
    expect(subscriptionsStore.getSnapshot().error).toBeNull();
  });
});

describe("toAppError normalization helper", () => {
  it("unwraps a SubbyError to its structured AppError", () => {
    const appError: AppError = { code: "validation", message: "bad", field: "name" };
    expect(toAppError(new SubbyError(appError))).toEqual(appError);
  });

  it("wraps an unknown thrown value as an unknown-coded error", () => {
    expect(toAppError(new Error("nope"))).toEqual({ code: "unknown", message: "nope" });
  });
});
