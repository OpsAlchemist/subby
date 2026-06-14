// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import Dashboard from "@/views/Dashboard";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import {
  activeCount,
  totalMonthly,
  totalYearly,
} from "core/analytics";
import { activeSubscriptions } from "core/subscriptions";
import { DEFAULT_SETTINGS } from "core/models/schema";
import type { Settings } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit test for Dashboard reactivity (Task 20.2, Req 8.6).
 *
 * The Dashboard reads the live `subscriptionsStore`/`settingsStore` via the
 * `useStoreData` (`useSyncExternalStore`) adapters. `initStores()` subscribes
 * to `onDataChanged` and reloads every store, so when the (fake) main process
 * mutates subscription data and fires `onDataChanged`, the displayed metrics
 * must update to reflect the current data (Req 8.6).
 *
 * We install a fake {@link SubbyApi} via `setSubby(...)` whose `list`/`get`
 * methods return controllable {@link IpcResult} data from mutable state, and
 * whose `onDataChanged` callback is captured so the test can fire it. Expected
 * figures are computed with the real `core/analytics` math (not hardcoded
 * formatting) so the assertions track the production derivation.
 */

// --- IpcResult helpers --------------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

// --- Fake SubbyApi facade -----------------------------------------------------

interface FakeApi extends SubbyApi {
  state: {
    subscriptions: Subscription[];
    categories: Category[];
    settings: Settings;
  };
  dataChangedListeners: Array<() => void>;
  errorListeners: Array<(error: AppError) => void>;
  emitDataChanged(): void;
}

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

function makeCategory(overrides: Partial<Category> = {}): Category {
  return { id: "cat-1", name: "Streaming", isDefault: true, ...overrides };
}

function createFakeApi(initial: Subscription[]): FakeApi {
  const fake: FakeApi = {
    state: {
      subscriptions: initial,
      categories: [makeCategory()],
      settings: { ...DEFAULT_SETTINGS },
    },
    dataChangedListeners: [],
    errorListeners: [],

    emitDataChanged() {
      for (const cb of this.dataChangedListeners) cb();
    },

    // --- Subscriptions ---
    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: () => ok(fake.state.subscriptions),
    updateSubscription: () => ok(fake.state.subscriptions),
    deleteSubscription: () => ok(fake.state.subscriptions),
    toggleActive: () => ok(fake.state.subscriptions),

    // --- Categories ---
    listCategories: () => ok(fake.state.categories),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<Settings | null>(fake.state.settings),

    // --- Data ---
    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok(fake.state.subscriptions),

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

// --- Expected-value helpers (real core/analytics math, no hardcoding) --------

/** The currency formatter the Dashboard uses for the default currency (INR). */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: DEFAULT_SETTINGS.defaultCurrency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Read the prominent value (`<p>`) of a metric card identified by its label. */
function metricCardValue(label: string): string {
  const card = screen.getByText(label).closest("div.rounded-lg");
  const value = card?.querySelector("p");
  return value?.textContent ?? "";
}

// --- Fixture ------------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

beforeEach(() => {
  fake = createFakeApi([
    makeSubscription({ id: "sub-1", name: "Netflix", amount: 499 }),
  ]);
  setSubby(fake);
});

afterEach(() => {
  teardown?.();
  cleanup();
  setSubby(null);
  subscriptionsStore.reset();
  categoriesStore.reset();
  settingsStore.reset();
  errorStore.clear();
});

// --- Test ---------------------------------------------------------------------

describe("Dashboard reactivity (Req 8.6)", () => {
  it("updates the displayed metrics when subscription data changes", async () => {
    render(<Dashboard />);
    // Subscribe stores to onDataChanged and kick off the initial load.
    teardown = initStores();

    // --- Initial metrics derived from the fake's initial subscriptions. ---
    const initialActive = activeSubscriptions(fake.state.subscriptions);
    const expectedInitialCount = activeCount(fake.state.subscriptions);
    const expectedInitialMonthly = totalMonthly(initialActive);
    const expectedInitialYearly = totalYearly(initialActive);

    await waitFor(() => {
      expect(metricCardValue("Active Subscriptions")).toBe(
        String(expectedInitialCount),
      );
    });
    expect(expectedInitialCount).toBe(1);
    expect(metricCardValue("Total Monthly Spend")).toBe(
      formatCurrency(expectedInitialMonthly),
    );
    expect(metricCardValue("Total Yearly Spend")).toBe(
      formatCurrency(expectedInitialYearly),
    );

    // --- Mutate the backing data: add a second active subscription, then ---
    // --- broadcast the change (simulating a main → renderer event).     ---
    fake.state.subscriptions = [
      makeSubscription({ id: "sub-1", name: "Netflix", amount: 499 }),
      makeSubscription({ id: "sub-2", name: "Spotify", amount: 200 }),
    ];
    fake.emitDataChanged();

    const updatedActive = activeSubscriptions(fake.state.subscriptions);
    const expectedUpdatedCount = activeCount(fake.state.subscriptions);
    const expectedUpdatedMonthly = totalMonthly(updatedActive);
    const expectedUpdatedYearly = totalYearly(updatedActive);

    // Active count incremented (Req 8.3, 8.6).
    await waitFor(() => {
      expect(metricCardValue("Active Subscriptions")).toBe(
        String(expectedUpdatedCount),
      );
    });
    expect(expectedUpdatedCount).toBe(2);

    // Monthly/yearly totals changed to reflect the new data (Req 8.1, 8.2, 8.6).
    expect(expectedUpdatedMonthly).toBeGreaterThan(expectedInitialMonthly);
    expect(metricCardValue("Total Monthly Spend")).toBe(
      formatCurrency(expectedUpdatedMonthly),
    );
    expect(metricCardValue("Total Yearly Spend")).toBe(
      formatCurrency(expectedUpdatedYearly),
    );
  });
});
