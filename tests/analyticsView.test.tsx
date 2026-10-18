// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { axe } from "jest-axe";

import AnalyticsView from "@/views/AnalyticsView";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import { homeMonthlyTotal } from "core/totalsV2";
import { exponentOf, type RateSnapshot } from "core/money";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * AnalyticsView tests (Story 6.3).
 *
 * The Analytics view reads the live `subscriptionsStore`/`settingsStore` via
 * `useStoreData`, and fetches the bundled FX `RateSnapshot` over Story 6.1's
 * read-only `fx:snapshot` IPC. Every chart figure is the ONE honest
 * Home-Currency convert-before-sum total (`homeMonthlyTotal`/`homeYearlyTotal`),
 * guarded by `rateConfidence` for staleness. We install a fake {@link SubbyApi}
 * whose `getFxSnapshot` returns a controllable snapshot (or an error) and
 * compute expected figures with the real core math — never hardcoded formatting.
 */

// --- IpcResult helpers --------------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

function errResult<T>(error: AppError): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error });
}

// --- Snapshots ----------------------------------------------------------------

/** `today` (UTC day) minus `n` days, as a `YYYY-MM-DD` string. */
function todayMinusDays(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

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

// --- Fake SubbyApi facade -----------------------------------------------------

interface FakeApi extends SubbyApi {
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
  };
  fxSnapshot: RateSnapshot | null;
  /** Optional per-Home-Currency snapshots; falls back to `fxSnapshot`. */
  fxByHome: Record<string, RateSnapshot>;
  /** Every Home Currency `getFxSnapshot` was called with (fetch-tracking). */
  fxRequests: string[];
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
    nextRenewal: "2099-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.example",
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
    fxByHome: {},
    fxRequests: [],
    fxErrored: false,
    dataChangedListeners: [],
    errorListeners: [],

    emitDataChanged() {
      for (const cb of this.dataChangedListeners) cb();
    },

    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: () => ok(fake.state.subscriptions),
    updateSubscription: () => ok(fake.state.subscriptions),
    deleteSubscription: () => ok(fake.state.subscriptions),
    setState: () => ok(fake.state.subscriptions),

    listCategories: () => ok(fake.state.categories),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    updateCategory: () => ok(fake.state.categories),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

    // FX snapshot (Story 6.1 / 6.3): controllable per-test. Records the queried
    // Home Currency and honors a per-Home snapshot override (`fxByHome`) so a
    // test can prove the view re-fetches when `homeCurrency` changes.
    getFxSnapshot: ((home: string) => {
      fake.fxRequests.push(home);
      if (fake.fxErrored) {
        return errResult<RateSnapshot>({ code: "not_found", message: "unavailable" });
      }
      return ok((fake.fxByHome[home] ?? fake.fxSnapshot) as RateSnapshot);
    }) as SubbyApi["getFxSnapshot"],

    // --- Logo Pack (Story 8.3): empty pack → every row uses the lettered fallback ---
    getLogoPack: (() =>
      ok({ version: 1, generatedAt: "", note: "", icons: {} })) as SubbyApi["getLogoPack"],

    // --- Logo blob cache + enrichment (Story 8.4): empty cache; enqueue acks ---
    getLogoCache: (() => ok<Record<string, string>>({})) as SubbyApi["getLogoCache"],
    enqueueEnrichment: (() => ok(null)) as SubbyApi["enqueueEnrichment"],

    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok(fake.state.subscriptions),
    createBackup: () => ok("2026-01-01-00-00-00-000.json"),

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

/** The Home-Currency (INR) formatter the view uses. */
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

/** The expected displayed Home-converted monthly figure for a sub set. */
function expectedMonthlyMoney(
  subs: SubscriptionV2[],
  snapshot: RateSnapshot,
): string {
  const total = homeMonthlyTotal(subs, snapshot, DEFAULT_SETTINGS_V2.homeCurrency);
  return formatCurrency(minorToMajor(total.totalMinor));
}

// --- Fixture ------------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

afterEach(() => {
  teardown?.();
  cleanup();
  setSubby(null);
  subscriptionsStore.reset();
  categoriesStore.reset();
  settingsStore.reset();
  errorStore.clear();
});

function mount(subs: SubscriptionV2[], configure?: (f: FakeApi) => void): void {
  fake = createFakeApi(subs);
  configure?.(fake);
  setSubby(fake);
  render(<AnalyticsView />);
  teardown = initStores();
}

// --- Home-converted figures (the hardcoded INR sum is gone) ------------------

describe("AnalyticsView Home-Currency figures (Story 6.3)", () => {
  it("renders every figure as a Home-converted convert-before-sum total, not the naive native sum", async () => {
    // 1000.00 USD + 1000.00 INR, Home INR, snapshot USD = 91.35 INR / unit.
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "u", name: "USD sub", currency: "USD", amountMinor: 100000 }),
      makeSubscription({ id: "i", name: "INR sub", currency: "INR", amountMinor: 100000 }),
    ];
    mount(subs);

    const expectedTotal = expectedMonthlyMoney(subs, INR_SNAPSHOT);
    await waitFor(() => {
      expect(screen.getByText("Monthly spend")).toBeInTheDocument();
    });

    // The headline monthly figure is the honest Home-converted total...
    const monthlyCard = screen.getByText("Monthly spend").closest("div.rounded-lg");
    expect(monthlyCard).not.toBeNull();
    expect(within(monthlyCard as HTMLElement).getByText(expectedTotal)).toBeInTheDocument();

    // ...and NOT the naive native minor sum (2000.00 "INR"): the USD line alone
    // converts to 1000 × 91.35 = 91,350 INR, so the total dwarfs the naive 2,000.
    const naive = formatCurrency(minorToMajor(100000 + 100000));
    expect(expectedTotal).not.toBe(naive);
    expect(screen.queryByText(naive)).toBeNull();
  });

  it("computes each category share as a Home-converted total per category subset", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "A", category: "Streaming", currency: "USD", amountMinor: 1000 }),
      makeSubscription({ id: "b", name: "B", category: "Software", currency: "EUR", amountMinor: 2000 }),
    ];
    mount(subs);

    await screen.findByText("Category distribution");

    const streamingExpected = expectedMonthlyMoney(
      [subs[0]],
      INR_SNAPSHOT,
    );
    const softwareExpected = expectedMonthlyMoney([subs[1]], INR_SNAPSHOT);

    // Each category's Home-converted amount appears (there are two surfaces: the
    // stacked-bar table and the category-distribution table), so use getAllBy.
    expect(screen.getAllByText(streamingExpected).length).toBeGreaterThan(0);
    expect(screen.getAllByText(softwareExpected).length).toBeGreaterThan(0);
  });

  it("ranks most-expensive by Home-converted monthly, where it DISAGREES with native minor units", async () => {
    // Under INR_SNAPSHOT (USD 91.350, EUR 100.00) the two orderings DISAGREE:
    //   USD $150 (15000 minor) → 13,702.50 INR
    //   EUR €140 (14000 minor) → 14,000.00 INR
    // Native-minor ranks USD first (15000 > 14000); Home-converted ranks EUR
    // first (14000 > 13702.50 INR). A regression to native-minor ranking would
    // flip the order — so asserting EUR first proves Home-converted ranking.
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "usd", name: "Dollar Service", currency: "USD", amountMinor: 15000 }),
      makeSubscription({ id: "eur", name: "Euro Service", currency: "EUR", amountMinor: 14000 }),
    ];
    mount(subs);

    await screen.findByText("Most expensive");

    const list = screen.getByText("Most expensive").closest("section");
    const items = within(list as HTMLElement).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Euro Service");
    expect(items[1]).toHaveTextContent("Dollar Service");
  });

  it("uses tabular-nums for money figures", async () => {
    mount([makeSubscription({ id: "a", amountMinor: 49900 })]);
    await screen.findByText("Monthly spend");
    const monthlyCard = screen.getByText("Monthly spend").closest("div.rounded-lg");
    expect(monthlyCard?.querySelector(".tabular-nums")).not.toBeNull();
  });
});

// --- Non-INR Home Currency formatting + re-fetch on change -------------------

/** A fresh snapshot rebased to `home` (home → 1), with the given extra rates. */
function snapshotFor(home: string, rates: Record<string, string>): RateSnapshot {
  return { asOf: todayMinusDays(10), rates: { [home]: "1", ...rates } };
}

/** Expected displayed monthly figure for a sub set in an arbitrary Home Currency. */
function expectedMoneyFor(
  subs: SubscriptionV2[],
  snapshot: RateSnapshot,
  home: string,
): string {
  const total = homeMonthlyTotal(subs, snapshot, home);
  const major = total.totalMinor / 10 ** exponentOf(home);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: home,
    maximumFractionDigits: 2,
  }).format(major);
}

describe("AnalyticsView non-INR Home Currency (Story 6.3)", () => {
  it("formats every figure in a USD Home Currency", async () => {
    const snap = snapshotFor("USD", { INR: "0.01094", EUR: "1.07" });
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", currency: "USD", amountMinor: 1500 }),
      makeSubscription({ id: "b", currency: "EUR", amountMinor: 1000 }),
    ];
    mount(subs, (f) => {
      f.state.settings = { ...DEFAULT_SETTINGS_V2, homeCurrency: "USD" };
      f.fxSnapshot = snap;
    });

    await screen.findByText("Monthly spend");
    const expected = expectedMoneyFor(subs, snap, "USD");
    // A USD-formatted figure ("$...") — not the INR default.
    expect(expected).toMatch(/\$/);
    const monthlyCard = screen.getByText("Monthly spend").closest("div.rounded-lg");
    expect(within(monthlyCard as HTMLElement).getByText(expected)).toBeInTheDocument();
  });

  it("formats figures with no decimals in a JPY (0-decimal) Home Currency", async () => {
    const snap = snapshotFor("JPY", { USD: "150.0", INR: "1.80" });
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", currency: "JPY", amountMinor: 500 }),
      makeSubscription({ id: "b", currency: "USD", amountMinor: 1000 }),
    ];
    mount(subs, (f) => {
      f.state.settings = { ...DEFAULT_SETTINGS_V2, homeCurrency: "JPY" };
      f.fxSnapshot = snap;
    });

    await screen.findByText("Monthly spend");
    const expected = expectedMoneyFor(subs, snap, "JPY");
    // JPY has exponent 0, so the formatted figure carries no fractional part.
    expect(expected).not.toMatch(/\.\d/);
    const monthlyCard = screen.getByText("Monthly spend").closest("div.rounded-lg");
    expect(within(monthlyCard as HTMLElement).getByText(expected)).toBeInTheDocument();
  });

  it("re-fetches the snapshot and recomputes when homeCurrency changes after mount", async () => {
    const inrSubs = [makeSubscription({ id: "a", currency: "INR", amountMinor: 50000 })];
    const usdSnap = snapshotFor("USD", { INR: "0.01094" });

    mount(inrSubs, (f) => {
      // INR home initially (DEFAULT_SETTINGS_V2); a USD snapshot waits in fxByHome.
      f.fxByHome = { INR: INR_SNAPSHOT, USD: usdSnap };
    });

    // Initial fetch is for the INR Home Currency, formatted in INR.
    await waitFor(() => {
      expect(fake.fxRequests).toContain("INR");
    });
    const inrExpected = expectedMoneyFor(inrSubs, INR_SNAPSHOT, "INR");
    const monthlyCard = () =>
      screen.getByText("Monthly spend").closest("div.rounded-lg") as HTMLElement;
    await waitFor(() => {
      expect(within(monthlyCard()).getByText(inrExpected)).toBeInTheDocument();
    });

    // Change the Home Currency to USD and broadcast: the settings store reloads,
    // the view re-renders, and the useFxSnapshot effect (keyed on homeCurrency)
    // re-fetches for USD and recomputes in USD.
    fake.state.settings = { ...DEFAULT_SETTINGS_V2, homeCurrency: "USD" };
    fake.emitDataChanged();

    const usdExpected = expectedMoneyFor(inrSubs, usdSnap, "USD");
    await waitFor(() => {
      expect(fake.fxRequests).toContain("USD");
    });
    await waitFor(() => {
      expect(within(monthlyCard()).getByText(usdExpected)).toBeInTheDocument();
    });
    expect(usdExpected).toMatch(/\$/);
  });
});

// --- Keyboard-reachable data table (Req 22.3) --------------------------------

describe("AnalyticsView chart text alternatives (Story 6.3, Req 22.3)", () => {
  it("gives the stacked bar / category distribution a keyboard-reachable table (not aria-hidden) plus an sr-only summary", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "A", category: "Streaming", amountMinor: 1000 }),
      makeSubscription({ id: "b", name: "B", category: "Software", amountMinor: 2000 }),
    ];
    mount(subs);

    await screen.findByText("Monthly spend by category");

    // Both charts expose a real <table> in the normal reading order.
    const tables = screen.getAllByRole("table");
    expect(tables.length).toBeGreaterThanOrEqual(2);

    for (const table of tables) {
      // The table itself is navigable — not aria-hidden.
      expect(table).not.toHaveAttribute("aria-hidden", "true");
      // And is not nested inside an aria-hidden ancestor.
      expect(table.closest('[aria-hidden="true"]')).toBeNull();
      // Each has a per-category row with the category name as a row header.
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(1);
    }

    // The decorative SVGs stay aria-hidden.
    const svgs = Array.from(document.querySelectorAll("svg"));
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }

    // Each chart still carries a visually-hidden summary.
    const srOnly = Array.from(document.querySelectorAll(".sr-only")).map(
      (n) => n.textContent ?? "",
    );
    expect(srOnly.some((t) => /Monthly spend by category/i.test(t))).toBe(true);
    expect(srOnly.some((t) => /monthly spend per category/i.test(t))).toBe(true);
  });

  it("most-expensive and renewal timeline remain navigable ordered lists", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "A", amountMinor: 1000, nextRenewal: "2099-01-01" }),
    ];
    mount(subs);
    await screen.findByText("Most expensive");

    const expensive = screen.getByText("Most expensive").closest("section");
    expect(within(expensive as HTMLElement).getByRole("list")).toBeInTheDocument();

    const timeline = screen.getByText("Renewal timeline").closest("section");
    expect(within(timeline as HTMLElement).getAllByRole("list").length).toBeGreaterThan(0);
  });

  it("renders the timeline without crashing when a renewal has an off-money-seam currency", async () => {
    // A Paused sub (excluded from the Home-total figures, so they still compute)
    // with an upcoming renewal in a currency the money seam does not know. The
    // timeline runs over ALL subs, so `toMajor` would throw UnknownCurrencyError
    // and blank the whole view — the per-row safe fallback must prevent that.
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "ok", name: "Netflix", currency: "INR", amountMinor: 49900 }),
      makeSubscription({
        id: "weird",
        name: "Mystery Service",
        state: "Paused",
        currency: "ZZZ",
        amountMinor: 1234,
        nextRenewal: "2099-03-15",
      }),
    ];
    mount(subs);

    // The view renders (did not crash) and the bad-currency row shows its name
    // plus a neutral fallback amount — no UnknownCurrencyError propagated.
    await screen.findByText("Renewal timeline");
    const timeline = screen.getByText("Renewal timeline").closest("section");
    expect(within(timeline as HTMLElement).getByText("Mystery Service")).toBeInTheDocument();
    expect(within(timeline as HTMLElement).getByText(/ZZZ/)).toBeInTheDocument();
    // The confident money figures still render for the active INR sub.
    expect(screen.getByText("Monthly spend")).toBeInTheDocument();
  });
});

// --- Stale-rate guard ---------------------------------------------------------

describe("AnalyticsView stale-rate guard (Story 2.4 / AD-12)", () => {
  it("shows the shared stale affordance and marks figures approximate — no confident single total", async () => {
    mount([makeSubscription({ id: "a", amountMinor: 49900 })], (f) => {
      f.fxSnapshot = STALE_SNAPSHOT;
    });

    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent(/exchange rates are about .* old/i);
    note.focus();
    expect(note).toHaveFocus();
    expect(note.tagName).not.toBe("BUTTON");

    // The headline figure is the "~approximate" form, NOT the confident string.
    const confident = expectedMonthlyMoney(
      [makeSubscription({ id: "a", amountMinor: 49900 })],
      STALE_SNAPSHOT,
    );
    const monthlyCard = screen.getByText("Monthly spend").closest("div.rounded-lg");
    expect(within(monthlyCard as HTMLElement).getByText(`~${confident}`)).toBeInTheDocument();
    // The plain confident value does not appear verbatim in the card.
    expect(within(monthlyCard as HTMLElement).queryByText(confident)).toBeNull();
  });

  it("shows a confident (no '~') figure on a fresh snapshot", async () => {
    mount([makeSubscription({ id: "a", amountMinor: 49900 })]);
    await screen.findByText("Monthly spend");
    expect(screen.queryByRole("note")).toBeNull();
    const confident = expectedMonthlyMoney(
      [makeSubscription({ id: "a", amountMinor: 49900 })],
      INR_SNAPSHOT,
    );
    const monthlyCard = screen.getByText("Monthly spend").closest("div.rounded-lg");
    expect(within(monthlyCard as HTMLElement).getByText(confident)).toBeInTheDocument();
  });
});

// --- Rates unavailable (IPC error) -------------------------------------------

describe("AnalyticsView rates unavailable (IPC error degrade)", () => {
  it("shows a 'rates unavailable' state (never a wrong number) and does not crash", async () => {
    mount([makeSubscription({ id: "a", amountMinor: 49900 })], (f) => {
      f.fxErrored = true;
    });

    await waitFor(() => {
      expect(screen.getByText(/Rates unavailable/i)).toBeInTheDocument();
    });
    // No chart figures, no crash.
    expect(screen.queryByText("Monthly spend")).toBeNull();
  });

  it("degrades to 'rates unavailable' when a present snapshot lacks a rate for a sub's currency", async () => {
    mount([makeSubscription({ id: "jp", name: "Niconico", currency: "JPY", amountMinor: 500 })], (f) => {
      f.fxSnapshot = INR_SNAPSHOT; // present, but has no JPY rate
      f.fxErrored = false;
    });

    await waitFor(() => {
      expect(screen.getByText(/Rates unavailable/i)).toBeInTheDocument();
    });
  });
});

// --- No spend-over-time trend (deferred) -------------------------------------

describe("AnalyticsView scope (Story 6.3)", () => {
  it("does NOT render a spend-over-time trend chart", async () => {
    mount([makeSubscription({ id: "a", amountMinor: 49900 })]);
    await screen.findByText("Monthly spend");
    expect(screen.queryByText(/spend over time/i)).toBeNull();
    expect(screen.queryByText(/trend/i)).toBeNull();
  });

  it("renders an empty state (no crash) with no subscriptions", async () => {
    mount([]);
    await screen.findByText(/No active subscriptions yet/i);
  });
});

// --- Axe (zero serious/critical) ---------------------------------------------

describe("AnalyticsView accessibility (Story 6.3, Req 22.1/22.3)", () => {
  async function seriousViolations(container: HTMLElement) {
    const results = await axe(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    return results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
  }

  it("is axe-clean with mixed-currency subscriptions and fresh rates", async () => {
    const subs: SubscriptionV2[] = [
      makeSubscription({ id: "a", name: "A", category: "Streaming", currency: "USD", amountMinor: 1000, nextRenewal: "2099-01-01" }),
      makeSubscription({ id: "b", name: "B", category: "Software", currency: "EUR", amountMinor: 2000, nextRenewal: "2099-02-01" }),
    ];
    mount(subs);
    await screen.findByText("Monthly spend by category");
    const violations = await seriousViolations(document.body);
    expect(violations.map((v) => v.id)).toEqual([]);
  });

  it("is axe-clean on stale rates (affordance present)", async () => {
    mount([makeSubscription({ id: "a", amountMinor: 49900 })], (f) => {
      f.fxSnapshot = STALE_SNAPSHOT;
    });
    await screen.findByRole("note");
    const violations = await seriousViolations(document.body);
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
