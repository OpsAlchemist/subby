// @vitest-environment jsdom
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import SubscriptionList from "@/views/SubscriptionList";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit tests for Subscription List interactions (Task 21.2, Req 9.3–9.7).
 *
 * The view reads live data from the client stores. We install a fake
 * {@link SubbyApi} via `setSubby(...)` whose `list*`/`get*` methods return
 * controllable {@link IpcResult} data and whose mutation methods
 * (`setState`/`deleteSubscription`/`updateSubscription`) are spies. We
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
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
  };
  dataChangedListeners: Array<() => void>;
  errorListeners: Array<(error: AppError) => void>;
  emitDataChanged(): void;
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

function makeCategory(name: string): Category {
  return { id: `cat-${name}`, name, isDefault: true };
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
    emitDataChanged() {
      for (const cb of this.dataChangedListeners) cb();
    },

    // --- Subscriptions: list returns state; mutations are spies ---
    listSubscriptions: vi.fn(() => ok(fake.state.subscriptions)),
    createSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    updateSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    deleteSubscription: vi.fn(() => ok(fake.state.subscriptions)),
    setState: vi.fn(() => ok(fake.state.subscriptions)),

    // --- Categories ---
    listCategories: vi.fn(() => ok(fake.state.categories)),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    updateCategory: () => ok(fake.state.categories),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: vi.fn(() => ok(fake.state.settings)),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    // --- Suggested price (Story 5.4): default fake returns no suggestion ---
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

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
  subs: SubscriptionV2[],
  categories: Category[] = [],
): Promise<void> {
  fake.state.subscriptions = subs;
  fake.state.categories = categories;
  teardown = initStores();
  await waitFor(() => expect(subscriptionsStore.getSnapshot().loaded).toBe(true));
  render(<SubscriptionList />);
  await screen.findByRole("table");
}

/**
 * Like {@link renderList} but passes the Story 3.6 palette-arrival highlight
 * props so the view scrolls/highlights `highlightId` and clears it via
 * `onHighlightConsumed`. Returns the rerender fn + the consume spy.
 */
async function renderListWithHighlight(
  subs: SubscriptionV2[],
  highlightId: string | null,
  categories: Category[] = [],
): Promise<{
  rerender: (ui: React.ReactElement) => void;
  onHighlightConsumed: ReturnType<typeof vi.fn>;
}> {
  fake.state.subscriptions = subs;
  fake.state.categories = categories;
  teardown = initStores();
  await waitFor(() => expect(subscriptionsStore.getSnapshot().loaded).toBe(true));
  const onHighlightConsumed = vi.fn();
  const { rerender } = render(
    <SubscriptionList
      highlightId={highlightId}
      onHighlightConsumed={onHighlightConsumed}
    />,
  );
  await screen.findByRole("table");
  return { rerender, onHighlightConsumed };
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
  // jsdom implements neither Element.scrollIntoView nor matchMedia; the Story
  // 3.6 highlight uses both. Stub them so the highlight path runs under test.
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
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
      makeSub({ id: "a", name: "Netflix", state: "Active" }),
      makeSub({ id: "b", name: "Hulu", state: "Paused" }),
    ]);

    // The v2 State filter is labelled "State" with options Active/Trial/Paused.
    await user.selectOptions(screen.getByLabelText("State"), "Paused");
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
  it("sets every selected subscription to Paused via setState(id,'Paused')", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
      makeSub({ id: "c", name: "Hulu" }),
    ]);

    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(within(table).getByLabelText("Select Spotify"));

    // The bulk bar now offers "Set Active" and "Set Paused" (no boolean toggle).
    await user.click(screen.getByRole("button", { name: /Set Paused/ }));

    await waitFor(() => expect(fake.setState).toHaveBeenCalledTimes(2));
    const calledIds = (fake.setState as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calledIds.sort()).toEqual(["a", "b"]);
    for (const call of (fake.setState as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe("Paused");
    }
    // The untouched subscription was not affected.
    expect(calledIds).not.toContain("c");
  });

  it("removes every selected subscription via the branded confirm dialog (never window.confirm)", async () => {
    const user = userEvent.setup();
    // The bulk delete must NEVER fall back to the native window.confirm — if it
    // is called, this spy fails the test.
    const confirmSpy = vi.spyOn(window, "confirm");

    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(within(table).getByLabelText("Select Spotify"));

    await user.click(screen.getByRole("button", { name: /Delete/ }));

    // A branded in-app alertdialog opens naming the exact count impact; nothing
    // is deleted yet.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/2 subscriptions/)).toBeInTheDocument();
    expect(fake.deleteSubscription).not.toHaveBeenCalled();

    // Confirm the destructive action in the dialog (its own "Delete" button).
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fake.deleteSubscription).toHaveBeenCalledTimes(2),
    );
    const removedIds = (fake.deleteSubscription as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(removedIds.sort()).toEqual(["a", "b"]);
    // The selection is cleared and the dialog is dismissed.
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    // The native confirm is never consulted.
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("cancelling the branded delete dialog keeps the selection and deletes nothing", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(within(table).getByLabelText("Select Spotify"));
    await user.click(screen.getByRole("button", { name: /Delete/ }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(fake.deleteSubscription).not.toHaveBeenCalled();
    // The selection survives — the bulk-actions bar still shows the count.
    const bulkBar = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(bulkBar).getByText("2 selected")).toBeInTheDocument();
  });
});

// --- Quick-edit (Req 9.7) -----------------------------------------------------

describe("quick-edit (Req 9.7)", () => {
  it("persists an edited amount via update(id, { amountMinor })", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", amountMinor: 49900, currency: "INR" }),
    ]);

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
    // The List parses the entered MAJOR amount into integer minor units in the
    // sub's own currency: minorUnits("999", "INR") === 99900 (exponent 2).
    expect(fake.updateSubscription).toHaveBeenCalledWith("a", { amountMinor: 99900 });
  });
});

// --- Category color chip + tag chips (Story 3.4) -----------------------------

describe("category color dot + tag chips (Story 3.4)", () => {
  it("renders an aria-hidden color dot before a category WITH a color; none when colorless", async () => {
    await renderList(
      [
        makeSub({ id: "a", name: "Netflix", category: "Streaming" }),
        makeSub({ id: "b", name: "Blog", category: "Writing" }),
      ],
      [
        { id: "c1", name: "Streaming", isDefault: true, color: "#db2777" },
        { id: "c2", name: "Writing", isDefault: false }, // colorless
      ],
    );

    const table = screen.getByRole("table");
    // The colored category renders a decorative dot with its background color;
    // the colorless one renders none (the NAME still carries the meaning).
    const dot = table.querySelector(
      'span[aria-hidden="true"][style*="background-color"]',
    ) as HTMLElement | null;
    expect(dot).not.toBeNull();
    // Both category NAMES are still present as text.
    expect(within(table).getByText("Streaming")).toBeInTheDocument();
    expect(within(table).getByText("Writing")).toBeInTheDocument();

    // Exactly ONE colored dot (Streaming), since Writing has no color.
    const dots = table.querySelectorAll(
      'span[aria-hidden="true"][style*="background-color"]',
    );
    expect(dots).toHaveLength(1);
  });

  it("renders a subscription's tag chips read-only in the row", async () => {
    await renderList(
      [makeSub({ id: "a", name: "Netflix", category: "Streaming", tags: ["Shared", "Family"] })],
      [{ id: "c1", name: "Streaming", isDefault: true }],
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("Shared")).toBeInTheDocument();
    expect(within(table).getByText("Family")).toBeInTheDocument();
  });
});

// --- Tag filter (Story 3.5, FR-4) --------------------------------------------

describe("tag filter (Story 3.5, FR-4)", () => {
  it("shows only subscriptions carrying the selected tag and composes with other filters", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", tags: ["Work", "Home"] }),
      makeSub({ id: "b", name: "Spotify", tags: ["Home"] }),
      makeSub({ id: "c", name: "Hulu", tags: [] }),
    ]);

    // All rows at rest (tag axis defaults to "all" — a no-op).
    expect(tableRowNames()).toEqual(["Netflix", "Spotify", "Hulu"]);

    // Picking "Work" leaves only subs whose tags include that EXACT tag.
    await user.selectOptions(screen.getByLabelText("Tag"), "Work");
    expect(tableRowNames()).toEqual(["Netflix"]);

    // Switching to "Home" matches both Netflix and Spotify.
    await user.selectOptions(screen.getByLabelText("Tag"), "Home");
    expect(tableRowNames()).toEqual(["Netflix", "Spotify"]);

    // "All tags" is a no-op again.
    await user.selectOptions(screen.getByLabelText("Tag"), "all");
    expect(tableRowNames()).toEqual(["Netflix", "Spotify", "Hulu"]);
  });

  it("lists distinct exact-case tags as options in first-seen order", async () => {
    await renderList([
      makeSub({ id: "a", name: "Netflix", tags: ["Work", "Home"] }),
      makeSub({ id: "b", name: "Spotify", tags: ["work"] }),
      makeSub({ id: "c", name: "Hulu", tags: [] }),
    ]);

    const select = screen.getByLabelText("Tag") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    // "all" placeholder first, then distinct tags in first-seen order; "Work"
    // and "work" are DISTINCT (exact-case); the empty-tag sub contributes none.
    expect(options).toEqual(["all", "Work", "Home", "work"]);
  });

  it("intersects the Tag axis with a Category filter", async () => {
    const user = userEvent.setup();
    await renderList(
      [
        makeSub({ id: "a", name: "Netflix", category: "Streaming", tags: ["Work"] }),
        makeSub({ id: "b", name: "Hulu", category: "Streaming", tags: ["Home"] }),
        makeSub({ id: "c", name: "Blog", category: "Writing", tags: ["Work"] }),
      ],
      [makeCategory("Streaming"), makeCategory("Writing")],
    );

    await user.selectOptions(screen.getByLabelText("Category"), "Streaming");
    await user.selectOptions(screen.getByLabelText("Tag"), "Work");
    // Only the sub matching BOTH axes shows.
    expect(tableRowNames()).toEqual(["Netflix"]);
  });
});

// --- Quick-edit validation (Story 3.5, Req 9.7) ------------------------------

describe("quick-edit validation (Story 3.5, Req 9.7)", () => {
  it("keeps the editor open with an announced alert on an invalid amount, persisting nothing", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", amountMinor: 49900, currency: "INR" }),
    ]);

    // See the note in the valid-amount test: neutralize focus() so the twin
    // card-layout input cannot steal focus and blur-close this editor.
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Edit amount for Netflix" }),
    );

    const input = await within(table).findByRole("spinbutton", {
      name: "Edit amount for Netflix",
    });
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The editor STAYS open with an announced role="alert" inline error; nothing
    // was persisted.
    const alert = await within(table).findByRole("alert");
    expect(alert).toHaveTextContent(/valid amount/i);
    expect(
      within(table).getByRole("spinbutton", { name: "Edit amount for Netflix" }),
    ).toBeInTheDocument();
    expect(fake.updateSubscription).not.toHaveBeenCalled();
  });

  it("keeps the editor open with an alert on an invalid date, persisting nothing", async () => {
    const user = userEvent.setup();
    await renderList([makeSub({ id: "a", name: "Netflix" })]);

    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Edit next renewal for Netflix" }),
    );

    const input = await within(table).findByLabelText("Edit next renewal for Netflix");
    // A bare `type="date"` input in jsdom accepts arbitrary strings; feed a
    // non-ISO value to trip the regex guard.
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await within(table).findByRole("alert");
    expect(alert).toHaveTextContent(/valid date/i);
    expect(fake.updateSubscription).not.toHaveBeenCalled();
  });

  it("cancels on Esc and returns focus to the originating cell trigger", async () => {
    await renderList([makeSub({ id: "a", name: "Netflix" })]);

    const table = screen.getByRole("table");
    const trigger = within(table).getByRole("button", {
      name: "Edit amount for Netflix",
    });

    // Make the trigger the active element BEFORE neutralizing focus(), so
    // startEdit captures it as the focus-return target. (jsdom renders both the
    // table and card layouts; the twin autoFocus inputs would otherwise steal
    // focus and blur-close the editor — the global focus() no-op prevents that
    // race, matching the existing valid-amount test.)
    trigger.focus();
    expect(trigger).toHaveFocus();
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(() => {});

    fireEvent.click(trigger);
    const input = await within(table).findByRole("spinbutton", {
      name: "Edit amount for Netflix",
    });

    // The focus-return target is the originating trigger; spy on ITS focus.
    const triggerFocus = vi.spyOn(trigger, "focus");
    fireEvent.keyDown(input, { key: "Escape" });

    // The editor closed, nothing persisted, and focus was returned to the
    // originating cell's quick-edit button.
    await waitFor(() =>
      expect(
        within(table).queryByRole("spinbutton", {
          name: "Edit amount for Netflix",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(triggerFocus).toHaveBeenCalled();
    expect(fake.updateSubscription).not.toHaveBeenCalled();

    focusSpy.mockRestore();
  });

  it("reverts on an invalid blur — nothing persisted and no dangling alert", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", amountMinor: 49900, currency: "INR" }),
    ]);

    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Edit amount for Netflix" }),
    );

    const input = await within(table).findByRole("spinbutton", {
      name: "Edit amount for Netflix",
    });
    fireEvent.change(input, { target: { value: "abc" } });
    // Blur with an invalid value reverts (cancels) — it never persists bad data,
    // and leaves no dangling alert behind.
    fireEvent.blur(input);

    await waitFor(() =>
      expect(
        within(table).queryByRole("spinbutton", {
          name: "Edit amount for Netflix",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(within(table).queryByRole("alert")).not.toBeInTheDocument();
    expect(fake.updateSubscription).not.toHaveBeenCalled();
  });

  it("commits a VALID blur — persists the edit and closes the editor", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", amountMinor: 49900, currency: "INR" }),
    ]);

    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Edit amount for Netflix" }),
    );

    const input = await within(table).findByRole("spinbutton", {
      name: "Edit amount for Netflix",
    });
    fireEvent.change(input, { target: { value: "999" } });
    // Blur with a VALID value still commits (preserves the existing behavior).
    fireEvent.blur(input);

    await waitFor(() =>
      expect(fake.updateSubscription).toHaveBeenCalledTimes(1),
    );
    // minorUnits("999", "INR") === 99900 (exponent 2).
    expect(fake.updateSubscription).toHaveBeenCalledWith("a", { amountMinor: 99900 });
    // The editor closed.
    await waitFor(() =>
      expect(
        within(table).queryByRole("spinbutton", {
          name: "Edit amount for Netflix",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("recovers from an invalid Enter: fixing the value and committing clears the alert and persists", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix", amountMinor: 49900, currency: "INR" }),
    ]);

    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {});

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Edit amount for Netflix" }),
    );

    const input = await within(table).findByRole("spinbutton", {
      name: "Edit amount for Netflix",
    });

    // Invalid commit: the editor holds open, the alert appears, nothing persists.
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await within(table).findByRole("alert")).toBeInTheDocument();
    expect(fake.updateSubscription).not.toHaveBeenCalled();

    // Fix the value and commit again: the alert clears, the edit persists, and
    // the editor closes.
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(fake.updateSubscription).toHaveBeenCalledTimes(1),
    );
    expect(fake.updateSubscription).toHaveBeenCalledWith("a", { amountMinor: 99900 });
    await waitFor(() => {
      expect(within(table).queryByRole("alert")).not.toBeInTheDocument();
      expect(
        within(table).queryByRole("spinbutton", {
          name: "Edit amount for Netflix",
        }),
      ).not.toBeInTheDocument();
    });
  });
});

// --- Selection count live region (Story 3.5, Req 9.6) ------------------------

describe("selection-count live region (Story 3.5, Req 9.6)", () => {
  it("announces the selection count through a persistent polite status region", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    // The region is mounted UNCONDITIONALLY (empty at rest) so a change is
    // observed by assistive tech — present before the count changes.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    expect(status).toHaveTextContent("1 selected");

    await user.click(within(table).getByLabelText("Select Spotify"));
    expect(status).toHaveTextContent("2 selected");

    // Clearing the selection empties the region again.
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(within(table).getByLabelText("Select Spotify"));
    expect(status).toHaveTextContent("");
  });
});

// --- Bulk-select keyboard model (Story 3.7) ----------------------------------

describe("bulk-select keyboard model (Story 3.7)", () => {
  it("toggles a focused row checkbox with the Space key (name 'Select <name>' unchanged)", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    const table = screen.getByRole("table");
    const status = screen.getByRole("status");
    // Accessible name is preserved and used to locate the control.
    const netflix = within(table).getByLabelText(
      "Select Netflix",
    ) as HTMLInputElement;
    expect(netflix).not.toBeChecked();

    // Keyboard operation: focus the checkbox and press Space to toggle it.
    netflix.focus();
    expect(netflix).toHaveFocus();
    await user.keyboard(" ");

    expect(netflix).toBeChecked();
    // The selection-count live region reflects the keyboard toggle.
    expect(status).toHaveTextContent("1 selected");

    // Space again unchecks it.
    await user.keyboard(" ");
    expect(netflix).not.toBeChecked();
    expect(status).toHaveTextContent("");
  });

  it("toggles every visible row via the keyboard-operable 'Select all subscriptions' control", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
      makeSub({ id: "c", name: "Hulu" }),
    ]);

    const table = screen.getByRole("table");
    const status = screen.getByRole("status");
    // Accessible name is preserved and used to locate the control.
    const selectAll = within(table).getByLabelText(
      "Select all subscriptions",
    ) as HTMLInputElement;

    // Keyboard operation: focus Select-all and press Space to select every row.
    selectAll.focus();
    expect(selectAll).toHaveFocus();
    await user.keyboard(" ");

    for (const name of ["Netflix", "Spotify", "Hulu"]) {
      expect(within(table).getByLabelText(`Select ${name}`)).toBeChecked();
    }
    expect(status).toHaveTextContent("3 selected");

    // Space again clears every row.
    await user.keyboard(" ");
    for (const name of ["Netflix", "Spotify", "Hulu"]) {
      expect(within(table).getByLabelText(`Select ${name}`)).not.toBeChecked();
    }
    expect(status).toHaveTextContent("");
  });
});

// --- StatusBadge text-not-color contract (Story 3.7) -------------------------

describe("StatusBadge conveys state by text, not color alone (Story 3.7)", () => {
  it.each(["Active", "Paused", "Trial"] as const)(
    "renders the literal '%s' label with an aria-hidden decorative dot",
    async (state) => {
      await renderList([makeSub({ id: "a", name: "Netflix", state })]);

      // Scope to the table row (the badge is also mirrored in the card list).
      const table = screen.getByRole("table");
      const row = within(table)
        .getByLabelText("Select Netflix")
        .closest("tr") as HTMLElement;

      // The badge carries a VISIBLE text label naming the state — color is never
      // the sole carrier.
      const badge = within(row).getByText(state);
      expect(badge).toBeInTheDocument();

      // The leading decorative dot is hidden from assistive tech.
      const dot = badge.querySelector('[aria-hidden="true"]');
      expect(dot).not.toBeNull();
    },
  );
});

// --- Trial badge accessible name + Convert to Active (Story 5.1) -------------

describe("Trial badge accessible name + Convert to Active (Story 5.1)", () => {
  it("a Trial row's badge composes state + post amount + conversion date (no /mo suffix)", async () => {
    await renderList([
      makeSub({
        id: "t1",
        name: "Notion",
        state: "Trial",
        currency: "USD",
        // A Yearly trial: the post amount ($120) is per the sub's cycle, NOT a
        // monthly figure, so the badge must NOT read "/mo".
        billingCycle: "Yearly",
        trial: { endDate: "2026-12-31", postAmountMinor: 12000 },
      }),
    ]);

    const table = screen.getByRole("table");
    // The badge's accessible name carries the stakes (post amount + conversion
    // date); the formatting matches the row currency formatter (USD → "$120.00").
    const badge = within(table).getByLabelText(
      /Trial, \$120\.00 after, converts 2026-12-31/,
    );
    expect(badge).toBeInTheDocument();
    // The amount is NOT labelled "/mo" (it is per the billing cycle).
    expect(badge.getAttribute("aria-label")).not.toMatch(/\/mo/);
    // The visible text is still the single word "Trial".
    expect(badge).toHaveTextContent("Trial");
    // The decorative dot is hidden from assistive tech.
    expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("composes the accessible name for the start+days variant via conversionDate", async () => {
    await renderList([
      makeSub({
        id: "t1",
        name: "Figma",
        state: "Trial",
        currency: "USD",
        trial: { startDate: "2026-12-01", lengthDays: 14, postAmountMinor: 1500 },
      }),
    ]);

    const table = screen.getByRole("table");
    // start 2026-12-01 + 14 days → converts 2026-12-15.
    expect(
      within(table).getByLabelText(
        /Trial, \$15\.00 after, converts 2026-12-15/,
      ),
    ).toBeInTheDocument();
  });

  it("Convert to Active calls update with Active + post amount + cleared trial", async () => {
    const user = userEvent.setup();
    await renderList([
      makeSub({
        id: "t1",
        name: "Notion",
        state: "Trial",
        amountMinor: 0,
        currency: "USD",
        trial: { endDate: "2026-12-31", postAmountMinor: 2000 },
      }),
    ]);

    const table = screen.getByRole("table");
    await user.click(
      within(table).getByRole("button", { name: "Convert Notion to Active" }),
    );

    await waitFor(() =>
      expect(fake.updateSubscription).toHaveBeenCalledTimes(1),
    );
    expect(fake.updateSubscription).toHaveBeenCalledWith("t1", {
      state: "Active",
      amountMinor: 2000,
      trial: undefined,
    });
  });

  it("shows the Convert affordance only on Trial rows (not Active/Paused)", async () => {
    await renderList([
      makeSub({ id: "a", name: "Active One", state: "Active" }),
      makeSub({ id: "p", name: "Paused One", state: "Paused" }),
      makeSub({
        id: "t",
        name: "Trial One",
        state: "Trial",
        trial: { endDate: "2026-12-31", postAmountMinor: 1000 },
      }),
    ]);

    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("button", { name: "Convert Trial One to Active" }),
    ).toBeInTheDocument();
    expect(
      within(table).queryByRole("button", {
        name: "Convert Active One to Active",
      }),
    ).toBeNull();
    expect(
      within(table).queryByRole("button", {
        name: "Convert Paused One to Active",
      }),
    ).toBeNull();
  });
});

// --- Accessibility of the new surfaces (Story 3.5) ---------------------------

describe("new-surface accessibility (Story 3.5)", () => {
  it("the List with the Tag filter has no serious/critical axe violations", async () => {
    await renderList(
      [makeSub({ id: "a", name: "Netflix", tags: ["Work"] })],
      [makeCategory("Streaming")],
    );
    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });

  it("the branded delete dialog is axe-clean when open", async () => {
    const user = userEvent.setup();
    await renderList([makeSub({ id: "a", name: "Netflix" })]);
    const table = screen.getByRole("table");
    await user.click(within(table).getByLabelText("Select Netflix"));
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    await screen.findByRole("alertdialog");

    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});

// --- Palette-arrival highlight (Story 3.6, FR-5) -----------------------------

describe("palette-arrival highlight (Story 3.6, FR-5)", () => {
  /** The matching table row for a subscription id (its Select checkbox's row). */
  function tableRowFor(name: string): HTMLElement {
    const table = screen.getByRole("table");
    const checkbox = within(table).getByLabelText(`Select ${name}`);
    return checkbox.closest("tr") as HTMLElement;
  }

  it("scrolls the matching row into view, paints a transient accent tint, and clears via onHighlightConsumed", async () => {
    const { onHighlightConsumed } = await renderListWithHighlight(
      [
        makeSub({ id: "a", name: "Netflix" }),
        makeSub({ id: "b", name: "Spotify" }),
      ],
      "b", // highlight Spotify
    );

    // The matching row carries the DECORATIVE accent tint (not the solid fill).
    await waitFor(() => {
      const row = tableRowFor("Spotify");
      expect(row.className).toContain("bg-accent/15");
    });

    // The scroll target was asked to come into view.
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();

    // The highlight is ephemeral: App is told to drop the id immediately.
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);

    // It never entangled with bulk selection: the row's checkbox stays unchecked.
    const table = screen.getByRole("table");
    expect(within(table).getByLabelText("Select Spotify")).not.toBeChecked();
    // The non-highlighted row has no tint.
    expect(tableRowFor("Netflix").className).not.toContain("bg-accent/15");
  });

  it("makes a filtered-OUT target reachable by clearing the local search before highlighting", async () => {
    const user = userEvent.setup();
    // Render WITHOUT a highlight first so we can set a local search that hides
    // the target, then rerender with the highlight (as App would on palette select).
    const { rerender, onHighlightConsumed } = await renderListWithHighlight(
      [
        makeSub({ id: "a", name: "Netflix" }),
        makeSub({ id: "b", name: "Spotify" }),
      ],
      null,
    );

    // A local search that hides Spotify (only Netflix matches "net").
    await user.type(screen.getByLabelText("Search subscriptions"), "net");
    await waitFor(() => expect(tableRowNames()).toEqual(["Netflix"]));

    // Now App threads in highlightId "b" (Spotify) — currently filtered out.
    rerender(
      <SubscriptionList highlightId="b" onHighlightConsumed={onHighlightConsumed} />,
    );

    // The local search is cleared so the row is reachable, and it is highlighted.
    await waitFor(() => {
      expect(tableRowNames()).toEqual(["Netflix", "Spotify"]);
      expect(tableRowFor("Spotify").className).toContain("bg-accent/15");
    });
    // The search box was reset to empty.
    expect(screen.getByLabelText("Search subscriptions")).toHaveValue("");
    expect(onHighlightConsumed).toHaveBeenCalled();
  });

  it("consumes a highlightId that names no existing subscription without highlighting anything", async () => {
    const { onHighlightConsumed } = await renderListWithHighlight(
      [makeSub({ id: "a", name: "Netflix" })],
      "does-not-exist",
    );

    // Nothing is tinted; App is still told to drop the dangling id.
    await waitFor(() => expect(onHighlightConsumed).toHaveBeenCalled());
    expect(tableRowFor("Netflix").className).not.toContain("bg-accent/15");
  });

  it("clears the transient tint after its interval, even though App nulls highlightId immediately", async () => {
    // Regression guard: the clear-timer must survive `onHighlightConsumed`
    // nulling `highlightId` on the next render. If the timer lived in the same
    // effect keyed on `highlightId`, that effect's cleanup would cancel it and
    // the tint would persist forever. Render under real timers (the store load
    // needs them), then assert the tint is eventually removed.
    await renderListWithHighlight(
      [
        makeSub({ id: "a", name: "Netflix" }),
        makeSub({ id: "b", name: "Spotify" }),
      ],
      "b", // highlight Spotify
    );

    // The tint is painted on arrival.
    expect(tableRowFor("Spotify").className).toContain("bg-accent/15");

    // After the highlight interval (2s) elapses, the tint clears itself —
    // proving the clear-timer was NOT cancelled when App dropped highlightId.
    await waitFor(
      () =>
        expect(tableRowFor("Spotify").className).not.toContain("bg-accent/15"),
      { timeout: 3000 },
    );
  });

  it("snaps the scroll (behavior:'auto') when prefers-reduced-motion is set", async () => {
    // Override the beforeEach matchMedia stub to report reduced-motion ON for
    // the reduced-motion query, so the highlight scroll must snap (no animation).
    window.matchMedia = ((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    await renderListWithHighlight(
      [
        makeSub({ id: "a", name: "Netflix" }),
        makeSub({ id: "b", name: "Spotify" }),
      ],
      "b", // highlight Spotify
    );

    const scrollSpy = HTMLElement.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >;
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    // The matching call snaps rather than animating under reduced-motion.
    const snapped = scrollSpy.mock.calls.some(
      (c) => (c[0] as ScrollIntoViewOptions | undefined)?.behavior === "auto",
    );
    expect(snapped).toBe(true);
  });
});
