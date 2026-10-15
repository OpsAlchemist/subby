// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import "@testing-library/jest-dom/vitest";

import SettingsCategories from "@/components/SettingsCategories";
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
import type { DeleteCategoryData } from "shared/subbyApi";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit tests for the Settings → Categories section (Story 3.4, FR-3, Req 7).
 *
 * Exercise the real renderer plumbing: a fake {@link SubbyApi} is injected via
 * `setSubby(...)` with controllable category spies, `categoriesStore` is
 * populated by `initStores()`, and `<SettingsCategories/>` reads it. The fake's
 * mutations update `fake.state.categories` and `emitDataChanged()` so the store
 * reloads exactly as in production.
 *
 * Covered:
 *   - set color persists through `cat:update` (updateCategory spy).
 *   - clear color drops it (updateCategory with { color: undefined }).
 *   - create category appends; a duplicate shows an inline error.
 *   - deleting an in-use category shows a BRANDED alertdialog (never
 *     window.confirm) naming the impact; cancel is the focus default; confirm
 *     re-invokes with { confirmed: true }.
 */

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}
function fail<T>(error: AppError): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error });
}

interface FakeApi extends SubbyApi {
  updateCategorySpy: ReturnType<typeof vi.fn>;
  deleteCategorySpy: ReturnType<typeof vi.fn>;
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
  };
  dataChangedListeners: Array<() => void>;
  emitDataChanged(): void;
  /** Categories that are "in use" (deleting them needs confirmation). */
  inUse: Record<string, number>;
}

function cat(overrides: Partial<Category> = {}): Category {
  return { id: "c1", name: "Streaming", isDefault: true, ...overrides };
}

function createFakeApi(): FakeApi {
  const updateCategorySpy = vi.fn(
    (id: string, patch: { color: string | undefined }) => {
      fake.state.categories = fake.state.categories.map((c) =>
        c.id === id
          ? patch.color === undefined
            ? (({ color: _c, ...rest }) => rest)(c)
            : { ...c, color: patch.color }
          : c,
      );
      fake.emitDataChanged();
      return ok<Category[]>(fake.state.categories);
    },
  );

  const deleteCategorySpy = vi.fn(
    (id: string, opts?: { confirmed: boolean }) => {
      const inUseCount = fake.inUse[id] ?? 0;
      if (inUseCount > 0 && opts?.confirmed !== true) {
        const target = fake.state.categories.find((c) => c.id === id)!;
        return ok<DeleteCategoryData>({
          needsConfirmation: true,
          name: target.name,
          inUseCount,
        });
      }
      fake.state.categories = fake.state.categories.filter((c) => c.id !== id);
      fake.emitDataChanged();
      return ok<DeleteCategoryData>({
        needsConfirmation: false,
        categories: fake.state.categories,
      });
    },
  );

  const fake: FakeApi = {
    updateCategorySpy,
    deleteCategorySpy,
    inUse: {},
    state: {
      subscriptions: [],
      categories: [cat()],
      settings: { ...DEFAULT_SETTINGS_V2 },
    },
    dataChangedListeners: [],
    emitDataChanged() {
      for (const c of this.dataChangedListeners) c();
    },

    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: () => ok(fake.state.subscriptions),
    updateSubscription: () => ok(fake.state.subscriptions),
    deleteSubscription: () => ok(fake.state.subscriptions),
    setState: () => ok(fake.state.subscriptions),

    listCategories: () => ok(fake.state.categories),
    createCategory: (name: string) => {
      const dup = fake.state.categories.find(
        (c) => c.name.toLowerCase() === name.trim().toLowerCase(),
      );
      if (dup) {
        return fail<{ categories: Category[]; created: Category }>({
          code: "conflict",
          field: "name",
          message: `A category named "${dup.name}" already exists.`,
        });
      }
      const created: Category = {
        id: `c-${name}`,
        name: name.trim(),
        isDefault: false,
      };
      fake.state.categories = [...fake.state.categories, created];
      fake.emitDataChanged();
      return ok({ categories: fake.state.categories, created });
    },
    updateCategory: updateCategorySpy as SubbyApi["updateCategory"],
    deleteCategory: deleteCategorySpy as SubbyApi["deleteCategory"],

    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    // Suggested price (Story 5.4): default fake returns no suggestion.
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok(fake.state.subscriptions),

    onDataChanged: (cb): Unsubscribe => {
      fake.dataChangedListeners.push(cb);
      return () => {
        fake.dataChangedListeners = fake.dataChangedListeners.filter(
          (c) => c !== cb,
        );
      };
    },
    onError: (): Unsubscribe => () => {},
  };
  return fake;
}

let fake: FakeApi;
let teardown: () => void;

async function renderSection(categories: Category[]): Promise<void> {
  fake.state.categories = categories;
  teardown = initStores();
  await waitFor(() => expect(categoriesStore.getSnapshot().loaded).toBe(true));
  render(<SettingsCategories />);
  await screen.findByRole("region", { name: "Categories" });
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

describe("set / clear color (Story 3.4)", () => {
  it("persists a color via cat:update (updateCategory)", async () => {
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    const picker = screen.getByLabelText("Color for Streaming") as HTMLInputElement;
    // Native color inputs fire change with a #rrggbb value; fireEvent models that.
    fireEvent.input(picker, { target: { value: "#123456" } });
    fireEvent.change(picker, { target: { value: "#123456" } });

    await waitFor(() =>
      expect(fake.updateCategorySpy).toHaveBeenCalledWith("c1", {
        color: "#123456",
      }),
    );
  });

  it("clears a color via cat:update with { color: undefined }", async () => {
    const user = userEvent.setup();
    await renderSection([cat({ id: "c1", name: "Streaming", color: "#db2777" })]);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(fake.updateCategorySpy).toHaveBeenCalledWith("c1", {
        color: undefined,
      }),
    );
  });

  it("opening the picker on a COLORLESS category and confirming unchanged persists NOTHING", async () => {
    await renderSection([cat({ id: "c1", name: "Streaming" })]); // no color

    const picker = screen.getByLabelText("Color for Streaming") as HTMLInputElement;
    // Confirming the native picker without changing it emits the seeded
    // placeholder (#808080) — this must NOT be saved as a chosen color.
    expect(picker.value).toBe("#808080");
    fireEvent.input(picker, { target: { value: "#808080" } });
    fireEvent.change(picker, { target: { value: "#808080" } });

    // Give any pending microtask a chance to run, then assert no update happened.
    await Promise.resolve();
    expect(fake.updateCategorySpy).not.toHaveBeenCalled();
  });

  it("a deliberate pick (different from the placeholder) on a colorless category DOES persist", async () => {
    await renderSection([cat({ id: "c1", name: "Streaming" })]); // no color

    const picker = screen.getByLabelText("Color for Streaming") as HTMLInputElement;
    fireEvent.input(picker, { target: { value: "#123456" } });
    fireEvent.change(picker, { target: { value: "#123456" } });

    await waitFor(() =>
      expect(fake.updateCategorySpy).toHaveBeenCalledWith("c1", {
        color: "#123456",
      }),
    );
  });
});

describe("create category (Story 3.4)", () => {
  it("appends a new category", async () => {
    const user = userEvent.setup();
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    await user.type(screen.getByLabelText("Add category"), "Newsletters");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Categories" })).getByText(
          "Newsletters",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("shows an inline duplicate error echoing the existing name", async () => {
    const user = userEvent.setup();
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    await user.type(screen.getByLabelText("Add category"), "streaming");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText(/A category named "Streaming" already exists\./),
    ).toBeInTheDocument();
  });
});

describe("delete via branded confirmation (Story 3.4)", () => {
  it("deletes a NOT-in-use category immediately (no dialog)", async () => {
    const user = userEvent.setup();
    await renderSection([
      cat({ id: "c1", name: "Streaming" }),
      cat({ id: "c2", name: "Spare", isDefault: false }),
    ]);

    await user.click(screen.getByRole("button", { name: "Delete Spare" }));

    expect(fake.deleteCategorySpy).toHaveBeenCalledWith("c2", undefined);
    // No confirmation dialog for a not-in-use category.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Spare")).toBeNull());
  });

  it("shows a branded alertdialog for an IN-USE category; cancel is focus default; confirm re-invokes with confirmed:true", async () => {
    const user = userEvent.setup();
    fake.inUse = { c1: 3 };
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    await user.click(screen.getByRole("button", { name: "Delete Streaming" }));

    // Branded in-app alertdialog (never window.confirm) naming the exact impact.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/3 subscriptions/)).toBeInTheDocument();

    // The safe/cancel option is the focus default.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    // Confirm re-invokes the delete with { confirmed: true }.
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(fake.deleteCategorySpy).toHaveBeenLastCalledWith("c1", {
        confirmed: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancelling the in-use confirmation deletes nothing", async () => {
    const user = userEvent.setup();
    fake.inUse = { c1: 2 };
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    await user.click(screen.getByRole("button", { name: "Delete Streaming" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Only the initial (unconfirmed) call happened — no confirmed delete.
    expect(fake.deleteCategorySpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Streaming")).toBeInTheDocument();
  });

  it("never uses window.confirm for category delete", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    fake.inUse = { c1: 1 };
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    await user.click(screen.getByRole("button", { name: "Delete Streaming" }));
    await screen.findByRole("alertdialog");

    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

// --- Accessibility: axe scan of the section (Story 3.7) ----------------------

describe("accessibility of the Categories section (Story 3.7)", () => {
  it("the Categories section has no serious/critical axe violations (closed)", async () => {
    await renderSection([
      cat({ id: "c1", name: "Streaming", color: "#db2777" }),
      cat({ id: "c2", name: "Spare", isDefault: false }),
    ]);

    // jsdom cannot compute color contrast (the sanctioned exception); every
    // other rule stays on — mirrors the List/palette scans.
    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });

  it("the branded delete confirmation is axe-clean when open", async () => {
    const user = userEvent.setup();
    // Seed an in-use category so Delete opens the branded alertdialog.
    fake.inUse = { c1: 3 };
    await renderSection([cat({ id: "c1", name: "Streaming" })]);

    await user.click(screen.getByRole("button", { name: "Delete Streaming" }));
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
