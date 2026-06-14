// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SubscriptionList from "@/views/SubscriptionList";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import { DEFAULT_SETTINGS } from "core/models/schema";
import type { Settings } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit tests for Subscription List interactions (Task 21.2, Req 9.3–9.7).
 *
 * The view reads live data from the client stores. We install a fake
 * {@link SubbyApi} via `setSubby(...)` whose `list*`/`get*` methods return
 * controllable {@link IpcResult} data and whose mutation methods
 * (`toggleActive`/`deleteSubscription`/`updateSubscription`) are spies. We
 * `initStores()` so the stores populate, then render `<SubscriptionList/>`.
 *
 * Note on layout: the view renders BOTH a wide `<table>` (`hidden md:block`)
 * and a narrow card list (`md:hidden`). jsdom applies no CSS, so both branches
 * are present in the DOM. To avoid ambiguous matches, all row-level queries are
 * scoped to the `<table>` via `within(getByRole("table"))`.
 */

// --- Fake SubbyApi facade -----------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

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

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "",
    category: "Streaming",
    amount: 499,
    currency: "INR",
    billingCycle: "Monthly",
    nextRenewal: "2025-02-01",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "",
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

function makeCategory(name: string): Category {
  return { id: `cat-${name}`, name, isDefault: true };
}

function createFakeApi(): FakeApi {
  const fake: FakeApi = {
    state: {
      subscriptions: [],
      categories: [],
      settings: { ...DEFAULT_SETTINGS },
    },
    dataChangedListeners: [],
    errorListeners: [],
    emitDataChanged() {
      for (const cb of this.dataChangedListeners) cb();
    },

    // --- Subscriptions: list returns state; mutations are spies ---
    listSubscriptions: vi.fn(() => ok(fake.state.subscriptions)),
    createSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    updateSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    deleteSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    toggleActive: vi.fn(() => ok(fake.state.subscriptions)),

    // --- Categories ---
    listCategories: vi.fn(() => ok(fake.state.categories)),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: vi.fn(() => ok(fake.state.settings)),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<Settings | null>(fake.state.settings),

    // --- Data ---
    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok(fake.state.subscriptions),

    // --- Events ---
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

// --- Test helpers -------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

/** Seed data, wire stores, and render the list. Resilient to async loads. */
async function renderList(
  subs: Subscription[],
  categories: Category[] = [],
): Promise<void> {
  fake.state.subscriptions = subs;
  fake.state.categories = categories;
  teardown = initStores();
  await waitFor(() => expect(subscriptionsStore.getSnapshot().loaded).toBe(true));
  render(<SubscriptionList />);
  await screen.findByRole("table");
}

/** The subscription names of the data rows, in table (DOM) order. */
function tableRowNames(): string[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("checkbox")
    .map((cb) => cb.getAttribute("aria-label") ?? "")
    .filter(
      (label) => label.startsWith("Select ") && label !== "Select all subscriptions",
    )
    .map((label) => label.replace(/^Select /, ""));
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

// --- Sort (Req 9.3) -----------------------------------------------------------

describe("sorting by column (Req 9.3)", () => {
  it("orders rows by name ascending, then reversed on a second click", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Spotify" }),
      makeSub({ id: "b", name: "Apple Music" }),
      makeSub({ id: "c", name: "Netflix" }),
    ]);

    // Unsorted: store order is preserved.
    expect(tableRowNames()).toEqual(["Spotify", "Apple Music", "Netflix"]);

    const table = screen.getByRole("table");
    const nameHeader = within(table).getByRole("button", { name: /^Name/ });

    await user.click(nameHeader); // ascending
    expect(tableRowNames()).toEqual(["Apple Music", "Netflix", "Spotify"]);

    await user.click(nameHeader); // descending
    expect(tableRowNames()).toEqual(["Spotify", "Netflix", "Apple Music"]);
  });
});

// --- Filter (Req 9.4) ---------------------------------------------------------

describe("filtering (Req 9.4)", () => {
  it("shows only subscriptions in the selected category", async () => {
    const user = userEvent.setup();
    await renderList(
      [
        makeSub({ id: "a", name: "Netflix", category: "Streaming" }),
        makeSub({ id: "b", name: "Spotify", category: "Music" }),
        makeSub({ id: "c", name: "Hulu", category: "Streaming" }),
      ],
      [makeCategory("Streaming"), makeCategory("Music")],
    );

    expect(tableRowNames()).toEqual(["Netflix", "Spotify", "Hulu"]);

    await user.selectOptions(screen.getByLabelText("Category"), "Music");
    expect(tableRowNames()).toEqual(["Spotify"]);
  });

  it("shows only subscriptions matching the selected status", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", isActive: true }),
      makeSub({ id: "b", name: "Hulu", isActive: false }),
    ]);

    await user.selectOptions(screen.getByLabelText("Status"), "inactive");
    expect(tableRowNames()).toEqual(["Hulu"]);
  });
});

// --- Group (Req 9.5) ----------------------------------------------------------

describe("grouping (Req 9.5)", () => {
  it("renders a group header per category with rows grouped", async () => {
    const user = userEvent.setup();
    await renderList(
      [
        makeSub({ id: "a", name: "Netflix", category: "Streaming" }),
        makeSub({ id: "b", name: "Spotify", category: "Music" }),
        makeSub({ id: "c", name: "Hulu", category: "Streaming" }),
      ],
      [makeCategory("Streaming"), makeCategory("Music")],
    );

    await user.selectOptions(screen.getByLabelText("Group by"), "category");

    const table = screen.getByRole("table");
    const groupHeaders = Array.from(
      table.querySelectorAll('th[scope="colgroup"]'),
    ).map((th) => th.textContent ?? "");

    // One header per distinct category, in first-seen order.
    expect(groupHeaders).toHaveLength(2);
    expect(groupHeaders[0]).toContain("Streaming");
    expect(groupHeaders[1]).toContain("Music");
    // All rows still present, grouped.
    expect(tableRowNames().sort()).toEqual(["Hulu", "Netflix", "Spotify"]);
  });
});

// --- Bulk actions (Req 9.6) ---------------------------------------------------

describe("bulk actions (Req 9.6)", () => {
  it("deactivates every selected subscription via toggleActive(id, false)", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
      makeSub({ id: "c", name: "Hulu" }),
    ]);

    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(within(table).getByLabelText("Select Spotify"));

    await user.click(screen.getByRole("button", { name: /Deactivate/ }));

    await waitFor(() =>
      expect(fake.toggleActive).toHaveBeenCalledTimes(2),
    );
    const calledIds = (fake.toggleActive as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calledIds.sort()).toEqual(["a", "b"]);
    for (const call of (fake.toggleActive as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe(false);
    }
    // The untouched subscription was not affected.
    expect(calledIds).not.toContain("c");
  });

  it("removes every selected subscription when delete is confirmed", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(within(table).getByLabelText("Select Spotify"));

    await user.click(screen.getByRole("button", { name: /Delete/ }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(fake.deleteSubscription).toHaveBeenCalledTimes(2),
    );
    const removedIds = (fake.deleteSubscription as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(removedIds.sort()).toEqual(["a", "b"]);
  });
});

// --- Quick-edit (Req 9.7) -----------------------------------------------------

describe("quick-edit (Req 9.7)", () => {
  it("persists an edited amount via update(id, { amount })", async () => {
    const user = userEvent.setup();
    await renderList([makeSub({ id: "a", name: "Netflix", amount: 499 })]);

    // jsdom renders BOTH the wide table and the narrow card layout (no CSS to
    // hide either), so two `autoFocus` edit inputs mount at once. jsdom also
    // ignores CSS `display` for focus, so the second input steals focus from
    // the first, firing its `onBlur` -> `commitEdit` and closing the edit
    // before we can change the value. Neutralizing `focus()` stops that
    // focus-stealing race so the edit input stays open; we then drive the
    // change deterministically with `fireEvent` (which needs no real focus).
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Edit amount for Netflix" }),
    );

    const input = await within(table).findByRole("spinbutton", {
      name: "Edit amount for Netflix",
    });
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fake.updateSubscription).toHaveBeenCalledTimes(1));
    expect(fake.updateSubscription).toHaveBeenCalledWith("a", { amount: 999 });
  });
});
