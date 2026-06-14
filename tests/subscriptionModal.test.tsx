// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import SubscriptionModal from "@/components/SubscriptionModal";
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
import type { IpcResult, SubscriptionInput } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit tests for the Add/Edit subscription modal behavior (Task 19.2).
 *
 * These exercise the modal through the real renderer plumbing in jsdom:
 *   - A fake {@link SubbyApi} is injected via `setSubby(...)` (the seam from
 *     `src/api/subby.ts`) with controllable `create`/`update` spies and seeded
 *     `list*`/`get*` data, so `categoriesStore` + `settingsStore` are populated
 *     by `initStores()` exactly as in production.
 *   - The modal then reads those stores via `useStoreData`.
 *
 * Covered acceptance criteria:
 *   - 4.3 : CREATE mode pre-fills currency from `settings.defaultCurrency`.
 *   - 4.2 : EDIT mode pre-populates fields from the subscription.
 *   - 4.4 : Cancel / Escape close without persisting (no create/update).
 *   - 3.5 : Empty name submission shows a message naming the name field.
 *   - 3.6 : Negative amount submission shows a message naming the amount field.
 */

// --- IpcResult helpers --------------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

// --- Fixture factories --------------------------------------------------------

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
    color: "#e50914",
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

/**
 * A fake {@link SubbyApi} with `create`/`update` spies and seeded store data.
 * The settings currency is seeded to a NON-default value ("GBP", vs the INR
 * default) so the pre-fill assertion proves the value flows from settings and
 * is not just the store's seed default.
 */
interface FakeApi extends SubbyApi {
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  state: {
    subscriptions: Subscription[];
    categories: Category[];
    settings: Settings;
  };
}

function createFakeApi(): FakeApi {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    defaultCurrency: "GBP",
    accentColor: "#123456",
  };

  const createSpy = vi.fn((input: SubscriptionInput) =>
    ok<Subscription[]>([makeSubscription({ ...input, id: "new-id" })]),
  );
  const updateSpy = vi.fn(() => ok<Subscription[]>([makeSubscription()]));

  const fake: FakeApi = {
    createSpy,
    updateSpy,
    state: {
      subscriptions: [],
      categories: [makeCategory()],
      settings,
    },

    // --- Subscriptions ---
    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: createSpy as SubbyApi["createSubscription"],
    updateSubscription: updateSpy as SubbyApi["updateSubscription"],
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

    // --- Events (no-op subscriptions for the modal tests) ---
    onDataChanged: (): Unsubscribe => () => {},
    onError: (): Unsubscribe => () => {},
  };

  return fake;
}

// --- Shared fixture -----------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

/** Install the fake, populate the stores, and wait until settings/categories load. */
async function seedStores(): Promise<void> {
  fake = createFakeApi();
  setSubby(fake);
  teardown = initStores();
  await waitFor(() => {
    expect(settingsStore.getSnapshot().loaded).toBe(true);
    expect(categoriesStore.getSnapshot().loaded).toBe(true);
  });
  // Confirm the seeded (non-default) currency actually landed in the store.
  expect(settingsStore.getSnapshot().data.defaultCurrency).toBe("GBP");
}

beforeEach(async () => {
  await seedStores();
});

afterEach(() => {
  cleanup();
  teardown?.();
  setSubby(null);
  subscriptionsStore.reset();
  categoriesStore.reset();
  settingsStore.reset();
  errorStore.clear();
});

// --- Tests --------------------------------------------------------------------

describe("default currency pre-fill (Req 4.3)", () => {
  it("pre-fills the currency field from settings.defaultCurrency in CREATE mode", () => {
    render(<SubscriptionModal open onClose={() => {}} />);

    expect(screen.getByLabelText(/Currency/)).toHaveValue("GBP");
  });
});

describe("edit pre-population (Req 4.2)", () => {
  it("pre-populates fields with the subscription's current values", () => {
    const subscription = makeSubscription({
      id: "edit-me",
      name: "Spotify",
      provider: "Spotify AB",
      amount: 119,
      currency: "USD",
      billingCycle: "Yearly",
      website: "https://spotify.com",
    });

    render(<SubscriptionModal open onClose={() => {}} subscription={subscription} />);

    // The dialog reflects EDIT mode.
    expect(
      screen.getByRole("dialog", { name: /edit subscription/i }),
    ).toBeInTheDocument();

    expect(screen.getByLabelText(/^Name/)).toHaveValue("Spotify");
    expect(screen.getByLabelText(/Provider/)).toHaveValue("Spotify AB");
    expect(screen.getByLabelText(/^Amount/)).toHaveValue(119);
    // Edit currency comes from the subscription, NOT the settings default.
    expect(screen.getByLabelText(/Currency/)).toHaveValue("USD");
    expect(screen.getByLabelText(/Billing cycle/)).toHaveValue("Yearly");
    expect(screen.getByLabelText(/Website/)).toHaveValue("https://spotify.com");
  });
});

describe("cancel discards without persisting (Req 4.4)", () => {
  it("calls onClose and persists nothing when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fake.createSpy).not.toHaveBeenCalled();
    expect(fake.updateSpy).not.toHaveBeenCalled();
  });

  it("calls onClose and persists nothing when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    // Focus a field inside the dialog so the keydown reaches the dialog handler.
    const nameInput = screen.getByLabelText(/^Name/);
    await user.click(nameInput);
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
    expect(fake.createSpy).not.toHaveBeenCalled();
    expect(fake.updateSpy).not.toHaveBeenCalled();
  });
});

describe("inline validation names the offending field (Req 3.5, 3.6)", () => {
  it("rejects an empty name and shows a message naming the name field", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    // CREATE mode starts with an empty name; submit immediately.
    await user.click(screen.getByRole("button", { name: /add subscription/i }));

    expect(await screen.findByText("Name is required.")).toBeInTheDocument();
    expect(fake.createSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects a negative amount and shows a message naming the amount field", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    // Provide a valid name so only the amount fails validation.
    await user.type(screen.getByLabelText(/^Name/), "Valid Name");
    const amount = screen.getByLabelText(/^Amount/);
    await user.clear(amount);
    await user.type(amount, "-5");

    // The amount input is <input type="number" min={0}>, so a click-submit is
    // pre-empted by the browser's native range constraint before the modal's
    // own handler runs. Dispatch the submit event directly to exercise the
    // component's validation, which is what Req 3.6 governs.
    const form = screen
      .getByRole("button", { name: /add subscription/i })
      .closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(
      await screen.findByText("Amount must be a non-negative number."),
    ).toBeInTheDocument();
    expect(fake.createSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("happy path create (Req 3.1, 4.4)", () => {
  it("calls create with a SubscriptionInput (no id/timestamps) and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    await user.type(screen.getByLabelText(/^Name/), "Disney+");
    await user.type(screen.getByLabelText(/^Amount/), "299");

    await user.click(screen.getByRole("button", { name: /add subscription/i }));

    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.name).toBe("Disney+");
    expect(payload.amount).toBe(299);
    // Currency defaults from settings (Req 4.3).
    expect(payload.currency).toBe("GBP");
    // System-managed fields are NOT supplied by the modal.
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("createdAt");
    expect(payload).not.toHaveProperty("updatedAt");

    expect(fake.updateSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
