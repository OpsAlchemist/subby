// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import GlobalSearch from "@/components/GlobalSearch";
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
 * Unit tests for the Global Search command palette (Story 3.6, FR-5, Req 12/22).
 *
 * The palette reads live subscriptions from {@link subscriptionsStore}. We
 * install a fake {@link SubbyApi} via `setSubby(...)` whose `list*`/`get*`
 * methods return controllable {@link IpcResult} data, `initStores()` to
 * populate the stores, then render `<GlobalSearch open />` with controllable
 * `onSelect`/`onClose` spies (mirroring `tests/subscriptionList.test.tsx`).
 *
 * Covered:
 *   - open lists ALL subs (empty query) (Req 12.3);
 *   - fuzzy filter + ranking order (best/contiguous first) (Req 12.1, 12.2);
 *   - ArrowUp/ArrowDown wrap + `aria-selected`/`aria-activedescendant` on the
 *     active row, and the accent-fill active-row styling (Story 3.6);
 *   - Enter calls `onSelect` with the HIGHLIGHTED sub, then `onClose`;
 *   - no-results Enter is a no-op;
 *   - Esc + backdrop close;
 *   - focus trap (Tab keeps focus within the dialog);
 *   - focus return to the opening trigger on close;
 *   - an axe scan with zero serious/critical violations.
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

    // Suggested price (Story 5.4): default fake returns no suggestion.
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

    // FX snapshot (Story 6.1): not exercised here — a rebased INR snapshot.
    getFxSnapshot: ((_home: string) =>
      ok({ asOf: new Date().toISOString().slice(0, 10), rates: { INR: "1" } })) as SubbyApi["getFxSnapshot"],

    // --- Logo Pack (Story 8.3): empty pack → every row uses the lettered fallback ---
    getLogoPack: (() =>
      ok({ version: 1, generatedAt: "", note: "", icons: {} })) as SubbyApi["getLogoPack"],

    // --- Logo blob cache + enrichment (Story 8.4): empty cache; enqueue acks ---
    getLogoCache: (() => ok<Record<string, string>>({})) as SubbyApi["getLogoCache"],
    enqueueEnrichment: (() => ok(null)) as SubbyApi["enqueueEnrichment"],
    syncNow: (() => ok(null)) as SubbyApi["syncNow"],

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

// --- Fixture ------------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

/** Seed data, wire stores, and render the palette open with spy callbacks. */
async function renderPalette(
  subs: SubscriptionV2[],
): Promise<{ onSelect: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  fake.state.subscriptions = subs;
  teardown = initStores();
  await waitFor(() => expect(subscriptionsStore.getSnapshot().loaded).toBe(true));

  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<GlobalSearch open onClose={onClose} onSelect={onSelect} />);
  // The dialog mounts synchronously once the store is loaded.
  await screen.findByRole("dialog", { name: "Search subscriptions" });
  return { onSelect, onClose };
}

/** Subscription names of the rendered option rows, in DOM order. */
function optionNames(): string[] {
  return screen.getAllByRole("option").map((li) => {
    // Each option renders the name in the first `.font-medium` span.
    const nameEl = li.querySelector(".font-medium");
    return nameEl?.textContent ?? "";
  });
}

/** The id of the currently active (`aria-selected`) option. */
function activeOptionId(): string | null {
  const active = screen
    .getAllByRole("option")
    .find((li) => li.getAttribute("aria-selected") === "true");
  return active?.id ?? null;
}

beforeEach(() => {
  fake = createFakeApi();
  setSubby(fake);
  // jsdom does not implement Element.scrollIntoView; the palette calls it to
  // keep the active option in view. Stub it so the component under test runs.
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
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

// --- Open & list all (Req 12.3) ----------------------------------------------

describe("open lists all subscriptions (Req 12.3)", () => {
  it("lists every subscription on open with an empty query", async () => {
    await renderPalette([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
      makeSub({ id: "c", name: "Hulu" }),
    ]);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(optionNames()).toEqual(expect.arrayContaining(["Netflix", "Spotify", "Hulu"]));
  });
});

// --- Fuzzy filter + ranking (Req 12.1, 12.2) ---------------------------------

describe("fuzzy filter + ranking (Req 12.1, 12.2)", () => {
  it("filters to subsequence matches and ranks the best (contiguous/earlier) first", async () => {
    const user = userEvent.setup();
    await renderPalette([
      makeSub({ id: "a", name: "Planet Fitness" }), // 'net' matches, later start
      makeSub({ id: "b", name: "Netflix" }), // 'net' contiguous at start → best
      makeSub({ id: "c", name: "Spotify" }), // no 'net'
    ]);

    await user.type(screen.getByRole("combobox"), "net");

    // Spotify is filtered out; Netflix ranks ahead of Planet Fitness.
    const names = optionNames();
    expect(names).toEqual(["Netflix", "Planet Fitness"]);
  });
});

// --- Arrow navigation, wrap, a11y attrs + active-row styling -----------------

describe("keyboard navigation and active-row (Story 3.6, Req 22.2)", () => {
  it("ArrowDown/ArrowUp move the active row with wrap and keep aria wiring in sync", async () => {
    const user = userEvent.setup();
    await renderPalette([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    const combobox = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");

    // First option is active on open.
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(combobox).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(activeOptionId()).toBe(options[0].id);

    // Down → second.
    await user.keyboard("{ArrowDown}");
    expect(activeOptionId()).toBe(options[1].id);
    expect(combobox).toHaveAttribute("aria-activedescendant", options[1].id);

    // Down again wraps back to the first.
    await user.keyboard("{ArrowDown}");
    expect(activeOptionId()).toBe(options[0].id);

    // Up wraps to the last.
    await user.keyboard("{ArrowUp}");
    expect(activeOptionId()).toBe(options[1].id);
  });

  it("paints the active row with the accent fill (bg-accent) and foreground ring", async () => {
    await renderPalette([makeSub({ id: "a", name: "Netflix" })]);

    const active = screen.getByRole("option");
    expect(active).toHaveAttribute("aria-selected", "true");
    // Accent-fill rule: accent background + element-foreground, never bg-secondary.
    expect(active.className).toContain("bg-accent");
    expect(active.className).toContain("text-accent-foreground");
    expect(active.className).toContain("ring-accent-foreground");
    expect(active.className).not.toContain("bg-secondary");
  });
});

// --- Enter selects the highlighted sub, then closes --------------------------

describe("Enter selects the highlighted result (FR-5)", () => {
  it("calls onSelect with the highlighted subscription, then onClose", async () => {
    const user = userEvent.setup();
    const { onSelect, onClose } = await renderPalette([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    // Move highlight to the second result, then Enter.
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "b", name: "Spotify" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter with no matching results is a no-op (does not select or crash)", async () => {
    const user = userEvent.setup();
    const { onSelect, onClose } = await renderPalette([
      makeSub({ id: "a", name: "Netflix" }),
    ]);

    await user.type(screen.getByRole("combobox"), "zzzzz");
    // No results: a status message replaces the listbox.
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a mouse click on a result selects it (same as Enter)", async () => {
    const user = userEvent.setup();
    const { onSelect, onClose } = await renderPalette([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    await user.click(screen.getByText("Spotify"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "b" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// --- Esc + backdrop close -----------------------------------------------------

describe("Escape and backdrop close", () => {
  it("Escape closes the palette", async () => {
    const user = userEvent.setup();
    const { onClose } = await renderPalette([makeSub({ id: "a", name: "Netflix" })]);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a backdrop click closes the palette", async () => {
    const user = userEvent.setup();
    const { onClose } = await renderPalette([makeSub({ id: "a", name: "Netflix" })]);

    // The backdrop is the dialog's parent (the fixed-inset scrim).
    const dialog = screen.getByRole("dialog", { name: "Search subscriptions" });
    const backdrop = dialog.parentElement as HTMLElement;
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// --- Focus trap + focus return (Story 3.6) -----------------------------------

describe("focus trap and focus return (Story 3.6, Req 22.1)", () => {
  it("traps Tab within the dialog (focus never reaches the page behind)", async () => {
    const user = userEvent.setup();
    // A page-behind button that must NEVER receive focus from within the palette.
    const behind = document.createElement("button");
    behind.textContent = "behind";
    document.body.appendChild(behind);

    await renderPalette([makeSub({ id: "a", name: "Netflix" })]);
    const input = screen.getByRole("combobox");
    input.focus();
    expect(input).toHaveFocus();

    await user.tab();
    // Focus stays within the dialog — the only focusable is the input, so it
    // remains there and never escapes to the page-behind button.
    const dialog = screen.getByRole("dialog", { name: "Search subscriptions" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(behind).not.toHaveFocus();

    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(behind).not.toHaveFocus();

    behind.remove();
  });

  it("returns focus to the element that opened it when it closes", async () => {
    // A trigger that is focused BEFORE the palette opens, standing in for the
    // top-bar Global Search button; focus must return here on close.
    const trigger = document.createElement("button");
    trigger.textContent = "open search";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    fake.state.subscriptions = [makeSub({ id: "a", name: "Netflix" })];
    teardown = initStores();
    await waitFor(() => expect(subscriptionsStore.getSnapshot().loaded).toBe(true));

    // Render controlled: toggling `open` false triggers the cleanup that
    // restores focus to `trigger` (captured as document.activeElement on open).
    const onClose = vi.fn();
    const { rerender } = render(
      <GlobalSearch open onClose={onClose} onSelect={() => {}} />,
    );
    await screen.findByRole("dialog", { name: "Search subscriptions" });

    rerender(<GlobalSearch open={false} onClose={onClose} onSelect={() => {}} />);

    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});

// --- Accessibility (Story 3.6) -----------------------------------------------

describe("accessibility (Story 3.6)", () => {
  it("the open palette has no serious/critical axe violations", async () => {
    await renderPalette([
      makeSub({ id: "a", name: "Netflix" }),
      makeSub({ id: "b", name: "Spotify" }),
    ]);

    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});
