// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";

import CalendarView from "@/views/CalendarView";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";
import { todayISO } from "@/views/calendarGrid";

import { addDays } from "core/renewal";
import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * CalendarView tests (Story 6.2, Req 10) — the renewal-urgency-in-TEXT AC.
 *
 * The Calendar reads the live `subscriptionsStore` via `useStoreData`. We install
 * a fake {@link SubbyApi} that returns seeded subscriptions, `initStores()` to
 * populate, then render `<CalendarView/>`. Because the view defaults to the
 * current month and reads the real `todayISO()`, renewal dates are computed
 * RELATIVE to the real today (via the production `addDays`) so they always land
 * in the visible month — the test stays deterministic without faking the clock.
 */

// --- Fake SubbyApi facade -----------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

interface FakeApi extends SubbyApi {
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
  };
  dataChangedListeners: Array<() => void>;
  errorListeners: Array<(error: AppError) => void>;
}

function makeSub(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "",
    category: "Streaming",
    amountMinor: 49900,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "",
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

function createFakeApi(): FakeApi {
  const fake: FakeApi = {
    state: {
      subscriptions: [],
      categories: [],
      settings: { ...DEFAULT_SETTINGS_V2 },
    },
    dataChangedListeners: [],
    errorListeners: [],

    listSubscriptions: vi.fn(() => ok(fake.state.subscriptions)),
    createSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    updateSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    deleteSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    setState: vi.fn(() => ok(fake.state.subscriptions)),

    listCategories: vi.fn(() => ok(fake.state.categories)),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    updateCategory: () => ok(fake.state.categories),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    getSettings: vi.fn(() => ok(fake.state.settings)),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],
    getFxSnapshot: ((_home: string) =>
      ok({ asOf: todayISO(), rates: { INR: "1" } })) as SubbyApi["getFxSnapshot"],

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

// --- Test harness -------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

/** Seed data, wire stores, render the Calendar, wait for the grid. */
async function renderCalendar(subs: SubscriptionV2[]): Promise<void> {
  fake.state.subscriptions = subs;
  teardown = initStores();
  await waitFor(() => expect(subscriptionsStore.getSnapshot().loaded).toBe(true));
  render(<CalendarView />);
  await screen.findByRole("grid");
}

/**
 * The day-cell button that carries a renewal count. Matches `"N renewal(s)"`
 * (not `"no renewals"`), so empty days are never selected by mistake. When
 * several days have renewals, pass a phrase substring (e.g. "in 3 days") to
 * disambiguate.
 */
function renewalCell(labelSubstring?: string): HTMLElement | undefined {
  const grid = screen.getByRole("grid");
  return within(grid)
    .getAllByRole("button")
    .find((b) => {
      const label = b.getAttribute("aria-label") ?? "";
      if (!/\d+ renewal/.test(label)) return false;
      return labelSubstring === undefined || label.includes(labelSubstring);
    });
}

beforeEach(() => {
  fake = createFakeApi();
  setSubby(fake);
});

afterEach(() => {
  cleanup();
  teardown?.();
  setSubby(null);
  subscriptionsStore.reset();
  categoriesStore.reset();
  settingsStore.reset();
  errorStore.clear();
  vi.restoreAllMocks();
});

// --- Urgency text, deterministic via a pinned mid-month clock ----------------

/**
 * These tests pin "today" to a FIXED mid-month date so BOTH the future and past
 * urgency branches run every time (the component reads `todayISO()` /
 * `currentYearMonth()` per render, so a system-time stub set before `render`
 * governs the visible month and the urgency sense). Mid-month means a renewal a
 * few days either side stays inside the default visible month. `fireEvent` (not
 * `userEvent`) drives the click so no fake-timer/userEvent interplay is needed.
 */
describe("urgency text with a pinned mid-month clock (Req 10, Story 6.2)", () => {
  const PINNED = "2026-06-15"; // Mid-June; the 12th/15th/18th are all in-month.
  const FUTURE = "2026-06-18"; // +3 → "due in 3 days" / "Renewing in 3 days"
  const PAST = "2026-06-12"; //   -3 → "renewed 3 days ago" / "Renewed 3 days ago"

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${PINNED}T12:00:00Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("future and past day cells carry aligned, unambiguous urgency in the aria-label", async () => {
    await renderCalendar([
      makeSub({ id: "fut", name: "Netflix", nextRenewal: FUTURE }),
      makeSub({ id: "past", name: "Spotify", nextRenewal: PAST }),
    ]);

    const futureCell = renewalCell("in 3 days");
    expect(futureCell).toBeDefined();
    expect(futureCell!.getAttribute("aria-label")).toContain("1 renewal");
    // Future reads "due in 3 days" — aligns with the panel's "Renewing".
    expect(futureCell!.getAttribute("aria-label")).toContain("due in 3 days");

    const pastCell = renewalCell("3 days ago");
    expect(pastCell).toBeDefined();
    // Past reads "renewed 3 days ago" — never ambiguous (happened vs due).
    expect(pastCell!.getAttribute("aria-label")).toContain("renewed 3 days ago");
  });

  it("a renewal on today reads 'due today' in the cell and 'Renewing today' in the panel", async () => {
    await renderCalendar([makeSub({ id: "a", name: "Netflix", nextRenewal: PINNED })]);

    const cell = renewalCell("today");
    expect(cell).toBeDefined();
    expect(cell!.getAttribute("aria-label")).toContain("due today");

    fireEvent.click(cell!);
    const panel = screen.getByRole("complementary", { name: "Selected day renewals" });
    expect(within(panel).getByText("Netflix")).toBeInTheDocument();
    expect(within(panel).getByText("Renewing today")).toBeInTheDocument();
  });

  it("the side panel reads 'Renewing {phrase}' for a future day and 'Renewed {phrase}' for a past day", async () => {
    await renderCalendar([
      makeSub({ id: "fut", name: "Netflix", nextRenewal: FUTURE }),
      makeSub({ id: "past", name: "Spotify", nextRenewal: PAST }),
    ]);

    fireEvent.click(renewalCell("in 3 days")!);
    let panel = screen.getByRole("complementary", { name: "Selected day renewals" });
    expect(within(panel).getByText("Netflix")).toBeInTheDocument();
    expect(within(panel).getByText("Renewing in 3 days")).toBeInTheDocument();

    fireEvent.click(renewalCell("3 days ago")!);
    panel = screen.getByRole("complementary", { name: "Selected day renewals" });
    expect(within(panel).getByText("Spotify")).toBeInTheDocument();
    expect(within(panel).getByText("Renewed 3 days ago")).toBeInTheDocument();
  });
});

// --- Empty-day cells carry no urgency text (Req 10, Story 6.2) ---------------

describe("empty-day cells (Req 10, Story 6.2)", () => {
  it("a day with no renewals ends with 'no renewals' — no urgency clause", async () => {
    const today = todayISO();
    // Seed a renewal in a DIFFERENT month so the current month's cells are empty.
    const otherMonth = addDays(today, 60);
    await renderCalendar([makeSub({ id: "a", nextRenewal: otherMonth })]);

    const grid = screen.getByRole("grid");
    const emptyCells = within(grid)
      .getAllByRole("button")
      .filter((b) => /no renewals/.test(b.getAttribute("aria-label") ?? ""));
    expect(emptyCells.length).toBeGreaterThan(0);
    for (const b of emptyCells) {
      // Positive check: the label ENDS with "no renewals" — nothing appended.
      expect(b.getAttribute("aria-label") ?? "").toMatch(/no renewals$/);
    }
  });
});

// --- Accessibility (Req 22, cross-cutting) -----------------------------------

describe("Calendar accessibility (Story 6.2)", () => {
  it("has no serious/critical axe violations with an upcoming renewal", async () => {
    const today = todayISO();
    const renewal = addDays(today, 3);
    const inMonthRenewal = renewal.slice(0, 7) === today.slice(0, 7) ? renewal : addDays(today, -3);
    await renderCalendar([makeSub({ id: "a", name: "Netflix", nextRenewal: inMonthRenewal })]);

    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});
