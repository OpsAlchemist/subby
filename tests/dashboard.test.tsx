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
import { trialsConvertFigure } from "core/trial";
import { activeSpendSubscriptionsV2 } from "core/subscriptionsV2";
import { exponentOf } from "core/money";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
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
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
  };
  dataChangedListeners: Array<() => void>;
  errorListeners: Array<(error: AppError) => void>;
  emitDataChanged(): void;
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

function createFakeApi(initial: SubscriptionV2[]): FakeApi {
  const fake: FakeApi = {
    state: {
      subscriptions: initial,
      categories: [makeCategory()],
      settings: { ...DEFAULT_SETTINGS_V2 },
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
    setState: () => ok(fake.state.subscriptions),

    // --- Categories ---
    listCategories: () => ok(fake.state.categories),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    updateCategory: () => ok(fake.state.categories),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

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

/** The currency formatter the Dashboard uses for the Home Currency (INR). */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: DEFAULT_SETTINGS_V2.homeCurrency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Mirror the Dashboard's `minorToMajorNumber`: the analytics totals are now
 * MINOR-unit sums, and the Dashboard renders them in Home-Currency major by
 * dividing by 10^exponent (INR exponent 2 → divide by 100).
 */
function minorToMajor(minor: number): number {
  return minor / 10 ** exponentOf(DEFAULT_SETTINGS_V2.homeCurrency);
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
    makeSubscription({ id: "sub-1", name: "Netflix", amountMinor: 49900 }),
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
    // The analytics totals are MINOR-unit sums; the Dashboard renders them in
    // Home-Currency major (divide by 10^exponent), so the expected display
    // values are `formatCurrency(minorToMajor(minorTotal))`.
    const initialActive = activeSpendSubscriptionsV2(fake.state.subscriptions);
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
      formatCurrency(minorToMajor(expectedInitialMonthly)),
    );
    expect(metricCardValue("Total Yearly Spend")).toBe(
      formatCurrency(minorToMajor(expectedInitialYearly)),
    );

    // --- Mutate the backing data: add a second active subscription, then ---
    // --- broadcast the change (simulating a main → renderer event).     ---
    fake.state.subscriptions = [
      makeSubscription({ id: "sub-1", name: "Netflix", amountMinor: 49900 }),
      makeSubscription({ id: "sub-2", name: "Spotify", amountMinor: 20000 }),
    ];
    fake.emitDataChanged();

    const updatedActive = activeSpendSubscriptionsV2(fake.state.subscriptions);
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
      formatCurrency(minorToMajor(expectedUpdatedMonthly)),
    );
    expect(metricCardValue("Total Yearly Spend")).toBe(
      formatCurrency(minorToMajor(expectedUpdatedYearly)),
    );
  });
});

// --- Trials-convert line (Story 5.1) -----------------------------------------

describe("trials-convert line (Story 5.1)", () => {
  it("renders '+ $X/mo when N trials convert' with the right figure/count when ≥1 Trial", async () => {
    // One Active + two Trials (monthly post 1000 minor, yearly post 12000 minor).
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "Netflix", state: "Active", amountMinor: 49900 }),
      makeSubscription({
        id: "t1",
        name: "Notion",
        state: "Trial",
        billingCycle: "Monthly",
        trial: { endDate: "2026-12-31", postAmountMinor: 1000 },
      }),
      makeSubscription({
        id: "t2",
        name: "Figma",
        state: "Trial",
        billingCycle: "Yearly",
        trial: { endDate: "2026-12-31", postAmountMinor: 12000 },
      }),
    ];
    fake = createFakeApi(subs);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    const figure = trialsConvertFigure(subs);
    expect(figure.count).toBe(2);
    // 1000 + 12000/12 = 2000 minor worth of monthly.
    expect(figure.monthlyMinor).toBe(2000);
    const expectedMoney = formatCurrency(minorToMajor(figure.monthlyMinor));

    // The muted secondary line names the figure and count (pluralized). The
    // text sits in a single leaf <span> (the sibling accent dot is a separate
    // node), so match the leaf whose own text content carries both the money
    // and the copy. `findByText` throws if it is absent (no jest-dom needed).
    await screen.findByText((_content, node) => {
      if (!node || node.children.length > 0) return false;
      const text = node.textContent ?? "";
      return (
        text.includes(expectedMoney) &&
        /\/mo when 2 trials convert/.test(text)
      );
    });
  });

  it("reads 'when 1 trial converts' (singular verb) for exactly one Trial", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "Netflix", state: "Active" }),
      makeSubscription({
        id: "t1",
        name: "Notion",
        state: "Trial",
        billingCycle: "Monthly",
        trial: { endDate: "2026-12-31", postAmountMinor: 1000 },
      }),
    ];
    fake = createFakeApi(subs);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    const figure = trialsConvertFigure(subs);
    expect(figure.count).toBe(1);
    const expectedMoney = formatCurrency(minorToMajor(figure.monthlyMinor));

    // Singular: "trial converts" (noun + verb both singular), not "trials
    // convert" and not the ungrammatical "trial convert".
    await screen.findByText((_content, node) => {
      if (!node || node.children.length > 0) return false;
      const text = node.textContent ?? "";
      return (
        text.includes(expectedMoney) &&
        /\/mo when 1 trial converts/.test(text) &&
        !/trials convert/.test(text)
      );
    });
  });

  it("renders NOTHING (line absent) when there are 0 Trials", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "Netflix", state: "Active" }),
      makeSubscription({ id: "p", name: "Hulu", state: "Paused" }),
    ];
    fake = createFakeApi(subs);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    // Let the stores load so the Dashboard reflects the (trial-free) data.
    await screen.findByText("Dashboard");
    await waitFor(() =>
      expect(metricCardValue("Active Subscriptions")).toBe("1"),
    );

    expect(screen.queryByText(/trials? convert/)).toBeNull();
  });
});
