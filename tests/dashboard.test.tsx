// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import Dashboard from "@/views/Dashboard";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import { activeCount } from "core/analytics";
import { homeMonthlyTotal, homeYearlyTotal } from "core/totalsV2";
import { trialsConvertFigure } from "core/trial";
import { activeSpendSubscriptionsV2, trialSubscriptionsV2 } from "core/subscriptionsV2";
import { exponentOf, type RateSnapshot } from "core/money";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Dashboard tests (Story 6.1, Req 8.1–8.6).
 *
 * The Dashboard reads the live `subscriptionsStore`/`settingsStore` via the
 * `useStore`/`useStoreData` adapters, and fetches the bundled FX `RateSnapshot`
 * over the read-only `fx:snapshot` IPC. Its "This month"/"Per year" figures are
 * now the ONE honest Home-Currency convert-before-sum totals (`homeMonthlyTotal`
 * /`homeYearlyTotal`), guarded by `rateConfidence` for staleness. We install a
 * fake {@link SubbyApi} whose `getFxSnapshot` returns a controllable snapshot
 * (or an error), and compute expected figures with the real core math so the
 * assertions track the production derivation (never hardcoded formatting).
 *
 * Note on count-up: jsdom has no `matchMedia`, so `useReducedMotion` returns
 * `true` and `CountUp` renders the FINAL value SYNCHRONOUSLY — the figures are
 * assertable immediately with no rAF timers to flush.
 */

// --- IpcResult helpers --------------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

function errResult<T>(error: AppError): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error });
}

// --- Snapshots ----------------------------------------------------------------

/** An INR-based rebased snapshot (INR → 1); fresh relative to the test clock. */
const INR_SNAPSHOT: RateSnapshot = {
  asOf: todayMinusDays(10),
  rates: { INR: "1", USD: "91.350", EUR: "100.00" },
};

/** A stale INR-based snapshot (older than the 90-day threshold). */
const STALE_SNAPSHOT: RateSnapshot = {
  asOf: todayMinusDays(200),
  rates: { INR: "1", USD: "91.350", EUR: "100.00" },
};

/** `today` (UTC day) minus `n` days, as a `YYYY-MM-DD` string. */
function todayMinusDays(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// --- Fake SubbyApi facade -----------------------------------------------------

interface FakeApi extends SubbyApi {
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
  };
  fxSnapshot: RateSnapshot | null;
  /** When true, `getFxSnapshot` resolves to an error outcome ("rates unavailable"). */
  fxErrored: boolean;
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
    fxSnapshot: INR_SNAPSHOT,
    fxErrored: false,
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

    // --- Suggested price (Story 5.4): default fake returns no suggestion ---
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

    // --- FX snapshot (Story 6.1): controllable per-test ---
    getFxSnapshot: (() =>
      fake.fxErrored
        ? errResult<RateSnapshot>({ code: "not_found", message: "unavailable" })
        : ok(fake.fxSnapshot as RateSnapshot)) as SubbyApi["getFxSnapshot"],

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

// --- Expected-value helpers (real core math, no hardcoding) ------------------

/** The currency formatter the Dashboard uses for the Home Currency (INR). */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: DEFAULT_SETTINGS_V2.homeCurrency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Home minor units → Home major number (INR exponent 2 → divide by 100). */
function minorToMajor(minor: number): number {
  return minor / 10 ** exponentOf(DEFAULT_SETTINGS_V2.homeCurrency);
}

/** The expected displayed "This month" figure for a set over the given snapshot. */
function expectedMonthly(subs: SubscriptionV2[], snapshot: RateSnapshot): string {
  const active = activeSpendSubscriptionsV2(subs);
  const total = homeMonthlyTotal(active, snapshot, DEFAULT_SETTINGS_V2.homeCurrency);
  return formatCurrency(minorToMajor(total.totalMinor));
}

/** The expected displayed "Per year" figure for a set over the given snapshot. */
function expectedYearly(subs: SubscriptionV2[], snapshot: RateSnapshot): string {
  const active = activeSpendSubscriptionsV2(subs);
  const total = homeYearlyTotal(active, snapshot, DEFAULT_SETTINGS_V2.homeCurrency);
  return formatCurrency(minorToMajor(total.totalMinor));
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

// --- Reactivity (Req 8.6) -----------------------------------------------------

describe("Dashboard reactivity (Req 8.6)", () => {
  it("updates the displayed converted metrics when subscription data changes", async () => {
    render(<Dashboard />);
    teardown = initStores();

    // Initial metrics: convert-before-sum totals over the INR snapshot.
    await waitFor(() => {
      expect(metricCardValue("Active Subscriptions")).toBe("1");
    });
    expect(metricCardValue("Total Monthly Spend")).toBe(
      expectedMonthly(fake.state.subscriptions, INR_SNAPSHOT),
    );
    expect(metricCardValue("Total Yearly Spend")).toBe(
      expectedYearly(fake.state.subscriptions, INR_SNAPSHOT),
    );

    // Mutate the backing data: add a second active subscription, then broadcast.
    fake.state.subscriptions = [
      makeSubscription({ id: "sub-1", name: "Netflix", amountMinor: 49900 }),
      makeSubscription({ id: "sub-2", name: "Spotify", amountMinor: 20000 }),
    ];
    fake.emitDataChanged();

    const expectedUpdatedCount = activeCount(fake.state.subscriptions);
    await waitFor(() => {
      expect(metricCardValue("Active Subscriptions")).toBe(
        String(expectedUpdatedCount),
      );
    });
    expect(expectedUpdatedCount).toBe(2);
    expect(metricCardValue("Total Monthly Spend")).toBe(
      expectedMonthly(fake.state.subscriptions, INR_SNAPSHOT),
    );
    expect(metricCardValue("Total Yearly Spend")).toBe(
      expectedYearly(fake.state.subscriptions, INR_SNAPSHOT),
    );
  });
});

// --- Convert-before-sum, mixed currency (the naive-sum bug is gone) ----------

describe("mixed-currency Home total (Story 6.1)", () => {
  it("converts each line Native→Home before summing (NOT a naive minor-unit sum)", async () => {
    // 1000.00 USD + 1000.00 INR, Home INR, snapshot USD=91.35 INR / unit.
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "u", name: "USD sub", currency: "USD", amountMinor: 100000 }),
      makeSubscription({ id: "i", name: "INR sub", currency: "INR", amountMinor: 100000 }),
    ];
    fake = createFakeApi(subs);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    const displayed = expectedMonthly(subs, INR_SNAPSHOT);
    await waitFor(() => {
      expect(metricCardValue("Total Monthly Spend")).toBe(displayed);
    });

    // The honest converted total is NOT the naive minor sum (2000.00 "INR").
    const naive = formatCurrency(minorToMajor(100000 + 100000));
    expect(displayed).not.toBe(naive);
    // The USD line alone converts to 1000 × 91.35 = 91,350 INR, so the total is
    // far larger than the naive 2,000 — proving conversion happened.
    expect(metricCardValue("Total Monthly Spend")).not.toBe(naive);
  });
});

// --- Stale-rate guard ---------------------------------------------------------

describe("stale-rate guard (Story 2.4 / AD-12)", () => {
  it("shows a focusable 'rates are N months old' affordance instead of a confident total", async () => {
    fake = createFakeApi([makeSubscription({ id: "a", amountMinor: 49900 })]);
    fake.fxSnapshot = STALE_SNAPSHOT;
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    // The stale affordance is a focusable text NOTE (role="note", NOT an action
    // button that does nothing) conveying the age in TEXT.
    const affordance = await screen.findByRole("note");
    expect(affordance).toHaveTextContent(/exchange rates are about .* old/i);
    affordance.focus();
    expect(affordance).toHaveFocus();
    expect(affordance.tagName).not.toBe("BUTTON");

    // Frozen rule: on stale rates the cards show the affordance INSTEAD of a
    // confident single total. The confident figure is SUPPRESSED: the card value
    // is the muted "~approximate" form (`~<amount>`), NOT the plain confident
    // string, and NOT wrapped in a bold count-up span.
    const confidentMonthly = expectedMonthly(fake.state.subscriptions, STALE_SNAPSHOT);
    const monthlyValue = metricCardValue("Total Monthly Spend");
    expect(monthlyValue).toBe(`~${confidentMonthly}`);
    expect(monthlyValue).not.toBe(confidentMonthly);
    // The plain confident value does not appear verbatim anywhere.
    expect(screen.queryByText(confidentMonthly)).toBeNull();
  });

  it("shows the confident total (with 'as of' date) on a fresh snapshot", async () => {
    render(<Dashboard />);
    teardown = initStores();

    await waitFor(() => {
      expect(metricCardValue("Total Monthly Spend")).toBe(
        expectedMonthly(fake.state.subscriptions, INR_SNAPSHOT),
      );
    });
    // No stale affordance when fresh.
    expect(
      screen.queryByRole("note", { name: /exchange rates are about/i }),
    ).toBeNull();
    // The "as of" date is shown.
    expect(screen.getAllByText(/Rates as of/i).length).toBeGreaterThan(0);
  });
});

// --- Rates unavailable (IPC error) -------------------------------------------

describe("rates unavailable (IPC error degrade)", () => {
  it("shows a 'rates unavailable' state (never a wrong number) and does not crash", async () => {
    fake = createFakeApi([makeSubscription({ id: "a", amountMinor: 49900 })]);
    fake.fxErrored = true;
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    // The money cards degrade to a clear "Rates unavailable" label — never a
    // confident converted number.
    await waitFor(() => {
      expect(screen.getAllByText(/Rates unavailable/i).length).toBeGreaterThan(0);
    });
    // The Active count still renders (not money-dependent).
    expect(metricCardValue("Active Subscriptions")).toBe("1");
  });

  it("degrades to 'Rates unavailable' when a NON-null snapshot lacks a rate for a sub's currency", async () => {
    // A JPY subscription with an INR snapshot that has NO JPY rate: the snapshot
    // IS present (fxErrored=false), but `homeMonthlyTotal` throws MissingRateError
    // inside `computeFigures`, which catches it and degrades the money cards to
    // "Rates unavailable" — a DIFFERENT branch from the null-snapshot IPC error.
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "jp", name: "Niconico", currency: "JPY", amountMinor: 500 }),
    ];
    fake = createFakeApi(subs);
    fake.fxSnapshot = INR_SNAPSHOT; // present, but has no JPY rate
    fake.fxErrored = false;
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    await waitFor(() => {
      expect(screen.getAllByText(/Rates unavailable/i).length).toBeGreaterThan(0);
    });
    // Never a wrong confident number, and the Active count still renders.
    expect(metricCardValue("Active Subscriptions")).toBe("1");
  });
});

// --- Cold load skeletons ------------------------------------------------------

describe("cold load (Story 6.1)", () => {
  it("shows skeleton placeholders (not a spinner) before data+rates resolve", async () => {
    // Hold the subscriptions load open so the Dashboard stays cold on first paint.
    let release!: (subs: SubscriptionV2[]) => void;
    const pending = new Promise<SubscriptionV2[]>((resolve) => {
      release = resolve;
    });
    fake = createFakeApi([makeSubscription({ id: "a", amountMinor: 49900 })]);
    fake.listSubscriptions = () =>
      pending.then((subs) => ({ ok: true as const, data: subs }));
    setSubby(fake);

    const { container } = render(<Dashboard />);
    teardown = initStores();

    // Cold: the live-region announces loading, and skeleton blocks are present.
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    // No metric figure yet (cards are skeletons, not a value).
    expect(screen.queryByText("Total Monthly Spend")).toBeNull();

    // Resolve the data: skeletons give way to the real cards.
    release([makeSubscription({ id: "a", amountMinor: 49900 })]);
    await waitFor(() => {
      expect(screen.getByText("Total Monthly Spend")).toBeInTheDocument();
    });
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});

// --- Count-up snaps under (test-default) reduced motion ----------------------

describe("count-up (Story 6.1)", () => {
  it("snaps to the FINAL value under reduced motion so the figure is assertable", async () => {
    render(<Dashboard />);
    teardown = initStores();

    // jsdom has no matchMedia → useReducedMotion is true → CountUp renders the
    // final value synchronously. The displayed figure equals the computed total.
    await waitFor(() => {
      expect(metricCardValue("Total Monthly Spend")).toBe(
        expectedMonthly(fake.state.subscriptions, INR_SNAPSHOT),
      );
    });
    // The figure carries tabular-nums.
    const card = screen.getByText("Total Monthly Spend").closest("div.rounded-lg");
    expect(card?.querySelector(".tabular-nums")).not.toBeNull();
  });
});

// --- Empty state --------------------------------------------------------------

describe("empty state (Story 6.1)", () => {
  it("shows 'Nothing tracked yet' with cards reading 0 when there are no subs", async () => {
    fake = createFakeApi([]);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    await screen.findByText(/Nothing tracked yet/i);
    expect(metricCardValue("Active Subscriptions")).toBe("0");
    // 0 formatted in Home currency for the money cards.
    expect(metricCardValue("Total Monthly Spend")).toBe(formatCurrency(0));
    expect(metricCardValue("Total Yearly Spend")).toBe(formatCurrency(0));
  });
});

// --- Trials-convert line (Story 5.1, now convert-before-sum) -----------------

describe("trials-convert line (Story 5.1)", () => {
  it("renders '+ X/mo when N trials convert' with the FX-correct figure/count when ≥1 Trial", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "Netflix", state: "Active", amountMinor: 49900 }),
      makeSubscription({
        id: "t1",
        name: "Notion",
        state: "Trial",
        amountMinor: 0,
        billingCycle: "Monthly",
        trial: { endDate: "2026-12-31", postAmountMinor: 1000 },
      }),
      makeSubscription({
        id: "t2",
        name: "Figma",
        state: "Trial",
        amountMinor: 0,
        billingCycle: "Yearly",
        trial: { endDate: "2026-12-31", postAmountMinor: 12000 },
      }),
    ];
    fake = createFakeApi(subs);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    // The FX-correct trials-convert figure: a convert-before-sum Home monthly
    // total over the Trial subset's POST-trial amounts (all INR here, so it
    // equals the native figure — but computed through homeMonthlyTotal).
    const shadow = trialSubscriptionsV2(subs).map((s) => ({
      ...s,
      amountMinor: s.trial?.postAmountMinor ?? 0,
    }));
    const trialsTotal = homeMonthlyTotal(
      shadow,
      INR_SNAPSHOT,
      DEFAULT_SETTINGS_V2.homeCurrency,
    );
    const expectedMoney = formatCurrency(minorToMajor(trialsTotal.totalMinor));
    // Sanity vs the native figure (INR-only → equal).
    expect(trialsTotal.totalMinor).toBe(trialsConvertFigure(subs).monthlyMinor);

    await screen.findByText((_content, node) => {
      if (!node || node.children.length > 0) return false;
      const text = node.textContent ?? "";
      return (
        text.includes(expectedMoney) && /\/mo when 2 trials convert/.test(text)
      );
    });
  });

  it("reads 'when 1 trial converts' (singular) for exactly one Trial", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "Netflix", state: "Active" }),
      makeSubscription({
        id: "t1",
        name: "Notion",
        state: "Trial",
        amountMinor: 0,
        billingCycle: "Monthly",
        trial: { endDate: "2026-12-31", postAmountMinor: 1000 },
      }),
    ];
    fake = createFakeApi(subs);
    setSubby(fake);

    render(<Dashboard />);
    teardown = initStores();

    await screen.findByText((_content, node) => {
      if (!node || node.children.length > 0) return false;
      const text = node.textContent ?? "";
      return (
        /\/mo when 1 trial converts/.test(text) && !/trials convert/.test(text)
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

    await screen.findByText("Dashboard");
    await waitFor(() =>
      expect(metricCardValue("Active Subscriptions")).toBe("1"),
    );

    expect(screen.queryByText(/trials? convert/)).toBeNull();
  });
});
