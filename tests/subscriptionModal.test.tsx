// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
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

import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { PriceSuggestion } from "core/priceSeed";
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
    color: "#e50914",
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

/**
 * A fake {@link SubbyApi} with `create`/`update` spies and seeded store data.
 * The settings currency is seeded to a NON-default value ("GBP", vs the INR
 * default) so the pre-fill assertion proves the value flows from settings and
 * is not just the store's seed default.
 */
interface FakeApi extends SubbyApi {
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  createCategorySpy: ReturnType<typeof vi.fn>;
  suggestSpy: ReturnType<typeof vi.fn>;
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsV2;
    /**
     * The suggestion the fake returns from `getPriceSuggestion` for ANY name
     * (Story 5.4). Tests set it to a {@link PriceSuggestion} to simulate a seed
     * match or leave it `null` for a miss / absent seed. The default is `null`
     * so unrelated modal tests see no suggestion behavior.
     */
    suggestion: PriceSuggestion | null;
  };
}

function createFakeApi(): FakeApi {
  const settings: SettingsV2 = {
    ...DEFAULT_SETTINGS_V2,
    homeCurrency: "GBP",
    accentColor: "#123456",
  };

  // The create/update spies only need to resolve successfully. The modal sends a
  // v2 input (with `amountMajor`), which does not spread cleanly into a
  // SubscriptionV2, so we ignore the input fields and return a canonical v2 sub.
  const createSpy = vi.fn((_input: SubscriptionInput) =>
    ok<SubscriptionV2[]>([makeSubscription({ id: "new-id" })]),
  );
  const updateSpy = vi.fn(() => ok<SubscriptionV2[]>([makeSubscription()]));
  // Inline add-category: creates a category by the given name and returns it so
  // the modal can select it immediately (Story 3.4).
  const createCategorySpy = vi.fn((name: string) => {
    const created = makeCategory({ id: `cat-${name}`, name, isDefault: false });
    fake.state.categories = [...fake.state.categories, created];
    return ok({ categories: fake.state.categories, created });
  });
  // Suggested price (Story 5.4): returns whatever the test seeded on
  // `fake.state.suggestion` for ANY queried name (the modal only queries in
  // CREATE mode). Default null = no match / absent seed.
  const suggestSpy = vi.fn((_name: string) =>
    ok<PriceSuggestion | null>(fake.state.suggestion),
  );

  const fake: FakeApi = {
    createSpy,
    updateSpy,
    createCategorySpy,
    suggestSpy,
    state: {
      subscriptions: [],
      categories: [makeCategory()],
      settings,
      suggestion: null,
    },

    // --- Subscriptions ---
    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: createSpy as SubbyApi["createSubscription"],
    updateSubscription: updateSpy as SubbyApi["updateSubscription"],
    deleteSubscription: () => ok(fake.state.subscriptions),
    setState: () => ok(fake.state.subscriptions),

    // --- Categories ---
    listCategories: () => ok(fake.state.categories),
    createCategory: createCategorySpy as SubbyApi["createCategory"],
    updateCategory: () => ok(fake.state.categories),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    // --- Suggested price (Story 5.4) ---
    getPriceSuggestion: suggestSpy as SubbyApi["getPriceSuggestion"],

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
  expect(settingsStore.getSnapshot().data.homeCurrency).toBe("GBP");
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
  it("pre-fills the currency field from settings.homeCurrency in CREATE mode", () => {
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
      amountMinor: 11900, // USD exponent 2: 119 major = 11900 minor
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

    // A non-empty but negative amount is a parse-level failure: the money seam
    // (`minorUnits`) rejects it, so the modal shows the "valid amount" message
    // (the "non-negative number" copy is reserved for an EMPTY amount).
    expect(
      await screen.findByText("Enter a valid amount for this currency."),
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
    // The modal sends the user-entered MAJOR amount as a string (`amountMajor`);
    // core parses it into integer minor units.
    expect(payload.amountMajor).toBe("299");
    // Currency defaults from settings (Req 4.3).
    expect(payload.currency).toBe("GBP");
    // System-managed fields are NOT supplied by the modal.
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("createdAt");
    expect(payload).not.toHaveProperty("updatedAt");

    expect(fake.updateSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("omits `trial` from the create payload for a non-Trial state", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Disney+");
    await user.type(screen.getByLabelText(/^Amount/), "299");

    // The default State is Active, so the trial fields are not even rendered.
    expect(screen.queryByLabelText(/Trial ends on/)).toBeNull();
    expect(screen.queryByLabelText(/Amount after trial/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.state).toBe("Active");
    expect(payload.trial).toBeUndefined();
  });
});

describe("Trial state reveals the trial fields and carries them in the payload (AD-17, AD-18)", () => {
  it("selecting Trial reveals the trial fields; create carries trial:{endDate,postAmountMinor}", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    await user.type(screen.getByLabelText(/^Name/), "Trial Service");
    await user.type(screen.getByLabelText(/^Amount/), "0");

    // Trial fields are hidden until the Trial state is selected. The end-date
    // variant field is labelled "Trial ends on" (Story 5.1 renamed it from the
    // pre-5.1 "Trial end date" when it added the start+days variant).
    expect(screen.queryByLabelText(/Trial ends on/)).toBeNull();

    // Select the Trial option in the segmented State radiogroup.
    await user.click(screen.getByRole("radio", { name: "Trial" }));

    // The trial block is now revealed; the default variant is "Ends on a date".
    const trialEnd = await screen.findByLabelText(/Trial ends on/);
    const trialAmount = screen.getByLabelText(/Amount after trial/);

    fireEvent.change(trialEnd, { target: { value: "2026-12-31" } });
    await user.type(trialAmount, "9.99");

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.state).toBe("Trial");
    // The entered post-trial MAJOR amount (9.99 GBP, exp 2) is parsed to minor units.
    expect(payload.trial).toEqual({ endDate: "2026-12-31", postAmountMinor: 999 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// --- Trial-length variants (Story 5.1; AD-18) --------------------------------

describe("trial-length variants (Story 5.1)", () => {
  it("the start+days variant saves trial:{startDate,lengthDays,postAmountMinor}", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    await user.type(screen.getByLabelText(/^Name/), "Days Trial");
    await user.type(screen.getByLabelText(/^Amount/), "0");

    // Reveal the trial block and switch to the "Lasts N days from start" variant.
    await user.click(screen.getByRole("radio", { name: "Trial" }));
    await user.click(
      await screen.findByRole("radio", { name: /Lasts N days from start/ }),
    );

    const start = await screen.findByLabelText(/Trial starts on/);
    fireEvent.change(start, { target: { value: "2026-12-01" } });
    await user.type(screen.getByLabelText(/Trial length \(days\)/), "14");
    await user.type(screen.getByLabelText(/Amount after trial/), "9.99");

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.state).toBe("Trial");
    // The start+days variant is persisted verbatim (GBP exp 2 → 999 minor).
    expect(payload.trial).toEqual({
      startDate: "2026-12-01",
      lengthDays: 14,
      postAmountMinor: 999,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the end-date variant still saves trial:{endDate,postAmountMinor} (default back-compat)", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "End Trial");
    await user.type(screen.getByLabelText(/^Amount/), "0");

    await user.click(screen.getByRole("radio", { name: "Trial" }));
    // The default variant is "Ends on a date"; no mode switch needed.
    const end = await screen.findByLabelText(/Trial ends on/);
    fireEvent.change(end, { target: { value: "2026-12-31" } });
    await user.type(screen.getByLabelText(/Amount after trial/), "10");

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.trial).toEqual({ endDate: "2026-12-31", postAmountMinor: 1000 });
  });

  it("an invalid (zero/empty) trial length shows an inline error and persists nothing", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Bad Days");
    await user.type(screen.getByLabelText(/^Amount/), "0");

    await user.click(screen.getByRole("radio", { name: "Trial" }));
    await user.click(
      await screen.findByRole("radio", { name: /Lasts N days from start/ }),
    );
    const start = await screen.findByLabelText(/Trial starts on/);
    fireEvent.change(start, { target: { value: "2026-12-01" } });
    // A zero-day length is invalid (positive whole days only).
    const days = screen.getByLabelText(/Trial length \(days\)/);
    fireEvent.change(days, { target: { value: "0" } });
    await user.type(screen.getByLabelText(/Amount after trial/), "9.99");

    const form = screen
      .getByRole("button", { name: /add subscription/i })
      .closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(
      await screen.findByText("Enter a positive whole number of days."),
    ).toBeInTheDocument();
    expect(fake.createSpy).not.toHaveBeenCalled();
  });

  it("surfaces a dated post-amount hint ($X after {conversionDate}, no /mo suffix)", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Hinted");
    await user.type(screen.getByLabelText(/^Amount/), "0");

    await user.click(screen.getByRole("radio", { name: "Trial" }));
    const end = await screen.findByLabelText(/Trial ends on/);
    fireEvent.change(end, { target: { value: "2026-12-31" } });
    await user.type(screen.getByLabelText(/Amount after trial/), "10");

    // The hint names the conversion date (the end date here) and the amount,
    // with NO "/mo" suffix (post amount is per the sub's cycle, not monthly).
    const hint = await screen.findByText(/ after 2026-12-31/);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).not.toMatch(/\/mo/);
  });

  it("pre-populates the start+days variant in EDIT mode", async () => {
    const subscription = makeSubscription({
      id: "edit-trial",
      state: "Trial",
      currency: "USD",
      trial: { startDate: "2026-11-01", lengthDays: 7, postAmountMinor: 500 },
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    // The start+days variant radio is selected and its fields are seeded.
    expect(
      screen.getByRole("radio", { name: /Lasts N days from start/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText(/Trial starts on/)).toHaveValue("2026-11-01");
    expect(screen.getByLabelText(/Trial length \(days\)/)).toHaveValue(7);
    // Post amount rendered back to major (USD exp 2: 500 → 5).
    expect(screen.getByLabelText(/Amount after trial/)).toHaveValue(5);
  });
});

// --- Tag editor (Story 3.4, FR-3) --------------------------------------------

describe("TagEditor in the modal (Story 3.4)", () => {
  it("adds, de-duplicates case-insensitively, removes, and carries tags on create", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Tagged");
    await user.type(screen.getByLabelText(/^Amount/), "100");

    const tagInput = screen.getByLabelText("Tags");
    // Add "Work" via Enter.
    await user.type(tagInput, "Work{Enter}");
    expect(screen.getByText("Work")).toBeInTheDocument();

    // A case/whitespace duplicate is dropped (still just one "Work").
    await user.type(tagInput, "  work {Enter}");
    expect(screen.getAllByText(/^work$/i)).toHaveLength(1);

    // Add a second distinct tag, then remove the first via its remove button.
    await user.type(tagInput, "Personal{Enter}");
    expect(screen.getByText("Personal")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove tag Work" }));
    expect(screen.queryByText("Work")).toBeNull();

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.tags).toEqual(["Personal"]);
  });

  it("a comma-separated paste adds EVERY segment (finding E)", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Pasted");
    await user.type(screen.getByLabelText(/^Amount/), "100");

    const tagInput = screen.getByLabelText("Tags") as HTMLInputElement;
    // Simulate a paste of "a,b,c" by setting the value with commas in one change.
    fireEvent.change(tagInput, { target: { value: "a,b,c" } });

    // Every segment BEFORE the last comma is committed as a chip (finding E: not
    // just the first). The trailing non-comma remainder "c" stays in the input,
    // per the TagEditor contract.
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(tagInput.value).toBe("c");

    // Pressing Enter commits the trailing remainder, so all three land.
    await user.type(tagInput, "{Enter}");
    expect(screen.getByText("c")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.tags).toEqual(["a", "b", "c"]);
  });

  it("a trailing-comma paste 'a,b,c,' commits all three segments", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Pasted2");
    await user.type(screen.getByLabelText(/^Amount/), "100");

    const tagInput = screen.getByLabelText("Tags") as HTMLInputElement;
    // A trailing comma means EVERY segment is before a comma → all commit.
    fireEvent.change(tagInput, { target: { value: "a,b,c," } });

    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(tagInput.value).toBe("");

    await user.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(fake.createSpy).toHaveBeenCalledTimes(1));

    const payload = fake.createSpy.mock.calls[0][0] as SubscriptionInput;
    expect(payload.tags).toEqual(["a", "b", "c"]);
  });

  it("Escape while focused in the tag field does NOT close the modal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SubscriptionModal open onClose={onClose} />);

    const tagInput = screen.getByLabelText("Tags");
    await user.click(tagInput);
    await user.keyboard("{Escape}");

    // The tag field swallows Escape; the modal stays open (no onClose, no discard).
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("pre-populates and preserves existing tags in EDIT mode", async () => {
    const user = userEvent.setup();
    const subscription = makeSubscription({ id: "edit-tags", tags: ["Keep"] });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    expect(screen.getByText("Keep")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Tags"), "Added{Enter}");

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));

    const patch = fake.updateSpy.mock.calls[0][1] as { tags: string[] };
    expect(patch.tags).toEqual(["Keep", "Added"]);
  });
});

// --- Inline add-category (Story 3.4) -----------------------------------------

describe("inline add-category in the modal (Story 3.4)", () => {
  it("creates a category and selects it without leaving the modal", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: /add new/i }));
    const nameField = await screen.findByLabelText("New category name");
    await user.type(nameField, "Newsletters{Enter}");

    await waitFor(() =>
      expect(fake.createCategorySpy).toHaveBeenCalledWith("Newsletters"),
    );
    // The Category select now has the created category selected.
    await waitFor(() =>
      expect(screen.getByLabelText("Category")).toHaveValue("Newsletters"),
    );
  });
});

// --- Price history: opt-in record-on-edit + read-only view (Story 5.3) -------

describe("price history (Story 5.3; AD-21)", () => {
  /** A price entry fixture. */
  function entry(
    amountMinor: number,
    currency = "USD",
    date = "2026-01-01",
  ): { amountMinor: number; currency: string; date: string } {
    return { amountMinor, currency, date };
  }

  it("offers the record checkbox ONLY when the amount changed (edit mode)", async () => {
    const user = userEvent.setup();
    const subscription = makeSubscription({
      id: "edit-price",
      currency: "USD",
      amountMinor: 1000, // $10.00
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    // Unchanged amount: the offer is NOT shown.
    expect(
      screen.queryByLabelText("Record this as a price change"),
    ).toBeNull();

    // Change the amount → the offer appears, defaulting CHECKED.
    const amount = screen.getByLabelText(/^Amount/);
    await user.clear(amount);
    await user.type(amount, "12.00");
    const checkbox = await screen.findByLabelText(
      "Record this as a price change",
    );
    expect(checkbox).toBeChecked();

    // Revert to the original amount → the offer disappears again.
    await user.clear(amount);
    await user.type(amount, "10.00");
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Record this as a price change"),
      ).toBeNull(),
    );
  });

  it("never offers a record in CREATE mode (nothing to compare against)", async () => {
    const user = userEvent.setup();
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "Fresh");
    await user.type(screen.getByLabelText(/^Amount/), "9.99");

    expect(
      screen.queryByLabelText("Record this as a price change"),
    ).toBeNull();
  });

  it("offers the record on a CURRENCY-only change and appends an entry when opted in", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    // $10.00 USD; both USD and EUR are exponent 2, so the typed amount "10.00"
    // parses to the SAME 1000 minor units — only the currency changes.
    const subscription = makeSubscription({
      id: "edit-currency",
      currency: "USD",
      amountMinor: 1000,
      priceHistory: [],
    });
    render(
      <SubscriptionModal open onClose={onClose} subscription={subscription} />,
    );

    // No change yet → no offer.
    expect(
      screen.queryByLabelText("Record this as a price change"),
    ).toBeNull();

    // Switch the Native currency USD → EUR, leaving the amount at 10.00.
    const currency = screen.getByLabelText(/Currency/);
    await user.clear(currency);
    await user.type(currency, "EUR");

    // The offer appears (currency-only change) and defaults CHECKED.
    const checkbox = await screen.findByLabelText(
      "Record this as a price change",
    );
    expect(checkbox).toBeChecked();

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));

    const patch = fake.updateSpy.mock.calls[0][1] as {
      amountMinor: number;
      currency: string;
      priceHistory?: { amountMinor: number; currency: string; date: string }[];
    };
    expect(patch.currency).toBe("EUR");
    expect(patch.amountMinor).toBe(1000);
    // An entry is appended capturing the new amount + NEW currency, dated today.
    expect(patch.priceHistory).toBeDefined();
    expect(patch.priceHistory).toHaveLength(1);
    expect(patch.priceHistory![0].amountMinor).toBe(1000);
    expect(patch.priceHistory![0].currency).toBe("EUR");
    expect(patch.priceHistory![0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-arms the opt-in (checked) when the offer is unchecked, reverted, then re-shown", async () => {
    const user = userEvent.setup();
    const subscription = makeSubscription({
      id: "edit-rearm",
      currency: "USD",
      amountMinor: 1000, // $10.00
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    const amount = screen.getByLabelText(/^Amount/);

    // Change the amount → offer appears checked; the user UNCHECKS it.
    await user.clear(amount);
    await user.type(amount, "12.00");
    const checkbox = await screen.findByLabelText(
      "Record this as a price change",
    );
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // Revert to the original amount → the offer hides (no change).
    await user.clear(amount);
    await user.type(amount, "10.00");
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Record this as a price change"),
      ).toBeNull(),
    );

    // Make a genuine change again → the offer re-appears CHECKED (not sticky off).
    await user.clear(amount);
    await user.type(amount, "15.00");
    const reshown = await screen.findByLabelText(
      "Record this as a price change",
    );
    expect(reshown).toBeChecked();
  });

  it("opting in appends a forward-log entry (new amount, currency, today) to the patch", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const prior = entry(1000, "USD", "2025-06-01"); // an existing entry
    const subscription = makeSubscription({
      id: "edit-price",
      currency: "USD",
      amountMinor: 1000, // $10.00
      priceHistory: [prior],
    });
    render(
      <SubscriptionModal open onClose={onClose} subscription={subscription} />,
    );

    const amount = screen.getByLabelText(/^Amount/);
    await user.clear(amount);
    await user.type(amount, "12.00"); // $12.00 → 1200 minor

    // The default is checked; submit.
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));

    const patch = fake.updateSpy.mock.calls[0][1] as {
      amountMinor: number;
      priceHistory?: { amountMinor: number; currency: string; date: string }[];
    };
    expect(patch.amountMinor).toBe(1200);
    // The prior entry is preserved and the NEW amount is appended at the end
    // (forward log), dated the renderer's local today (YYYY-MM-DD).
    expect(patch.priceHistory).toBeDefined();
    const ph = patch.priceHistory!;
    expect(ph).toHaveLength(2);
    expect(ph[0]).toEqual(prior);
    expect(ph[1].amountMinor).toBe(1200);
    expect(ph[1].currency).toBe("USD");
    expect(ph[1].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("declining (unchecking) records nothing — priceHistory is omitted from the patch", async () => {
    const user = userEvent.setup();
    const prior = entry(1000, "USD", "2025-06-01");
    const subscription = makeSubscription({
      id: "edit-price",
      currency: "USD",
      amountMinor: 1000,
      priceHistory: [prior],
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    const amount = screen.getByLabelText(/^Amount/);
    await user.clear(amount);
    await user.type(amount, "12.00");

    // Uncheck the record offer, then save.
    await user.click(
      await screen.findByLabelText("Record this as a price change"),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));

    const patch = fake.updateSpy.mock.calls[0][1] as {
      amountMinor: number;
      priceHistory?: unknown;
    };
    // The amount still updates, but no priceHistory field is sent (the stored
    // append-only history is left untouched by the merge).
    expect(patch.amountMinor).toBe(1200);
    expect(patch).not.toHaveProperty("priceHistory");
  });

  it("an unchanged amount records nothing even if submitted", async () => {
    const user = userEvent.setup();
    const prior = entry(1000, "USD", "2025-06-01");
    const subscription = makeSubscription({
      id: "edit-price",
      name: "Keep Price",
      currency: "USD",
      amountMinor: 1000,
      priceHistory: [prior],
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    // Change only the name; leave the amount at $10.00.
    const name = screen.getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "Keep Price Renamed");

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));

    const patch = fake.updateSpy.mock.calls[0][1] as { priceHistory?: unknown };
    expect(patch).not.toHaveProperty("priceHistory");
  });

  it("renders the read-only price history list with each entry's date + formatted money, newest-first", () => {
    const subscription = makeSubscription({
      id: "view-history",
      currency: "USD",
      amountMinor: 1500,
      priceHistory: [
        entry(1000, "USD", "2025-01-01"),
        entry(1200, "USD", "2025-06-01"),
        entry(1500, "USD", "2026-01-01"),
      ],
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    const region = screen.getByRole("region", { name: "Price history" });
    expect(region).toBeInTheDocument();

    // Dates for all three entries are shown.
    expect(screen.getByText("2025-01-01")).toBeInTheDocument();
    expect(screen.getByText("2025-06-01")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01")).toBeInTheDocument();

    // The money is actually FORMATTED (Intl currency, USD → $X.XX), not a raw
    // minor-unit integer. Each entry's figure appears in the region.
    expect(within(region).getByText(/\$10\.00/)).toBeInTheDocument();
    expect(within(region).getByText(/\$12\.00/)).toBeInTheDocument();
    expect(within(region).getByText(/\$15\.00/)).toBeInTheDocument();

    // There are no edit/delete controls in the price-history region (read-only).
    expect(region.querySelectorAll("button")).toHaveLength(0);

    // Newest-first display: the first list item is the most recent entry; the
    // row pairs the date with its formatted money.
    const items = region.querySelectorAll("li");
    expect(items[0].textContent).toContain("2026-01-01");
    expect(items[0].textContent).toContain("$15.00");
    expect(items[items.length - 1].textContent).toContain("2025-01-01");
    expect(items[items.length - 1].textContent).toContain("$10.00");
  });

  it("renders a price history entry in a currency unknown to the money seam without throwing", () => {
    // "ZZZZ" is not in the money seam's exponent table (so `toMajor` throws →
    // raw-minor fallback) AND is not a well-formed ISO-4217 code, so the Intl
    // currency formatter also rejects it → the final `${currency} ${major}`
    // fallback. The view must still render — never crash — exercising BOTH catch
    // branches in `formatEntryMoney`.
    const subscription = makeSubscription({
      id: "unknown-currency-history",
      currency: "USD",
      amountMinor: 1500,
      priceHistory: [entry(123456, "ZZZZ", "2025-03-01")],
    });

    expect(() =>
      render(
        <SubscriptionModal
          open
          onClose={() => {}}
          subscription={subscription}
        />,
      ),
    ).not.toThrow();

    const region = screen.getByRole("region", { name: "Price history" });
    expect(within(region).getByText("2025-03-01")).toBeInTheDocument();
    // The double-fallback renders the raw integer prefixed by the currency code.
    expect(within(region).getByText(/ZZZZ\s*123456/)).toBeInTheDocument();
  });

  it("a populated price history list is axe-clean (no serious/critical violations)", async () => {
    const subscription = makeSubscription({
      id: "axe-history",
      currency: "USD",
      amountMinor: 1500,
      priceHistory: [
        entry(1000, "USD", "2025-01-01"),
        entry(1500, "USD", "2026-01-01"),
      ],
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );
    await screen.findByRole("region", { name: "Price history" });

    // jsdom cannot compute color contrast, so that one rule stays disabled (the
    // sanctioned exception — mirrors the modal/List scans); nothing else.
    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });

  it("shows a sensible empty state when there is no price history", () => {
    const subscription = makeSubscription({
      id: "empty-history",
      priceHistory: [],
    });
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    expect(screen.getByText("No price changes recorded.")).toBeInTheDocument();
  });
});

// --- Suggested price on add (Story 5.4; FR-13) -------------------------------

describe("suggested price on add (Story 5.4)", () => {
  /** Today as YYYY-MM-DD (matches the modal's `todayIso`), so a fresh seed. */
  function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** A fresh (today-dated) USD/Monthly suggestion for $15.49. */
  function freshNetflix(): PriceSuggestion {
    return {
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly",
      asOf: todayIso(),
    };
  }

  it("CREATE: typing a known name pre-fills the amount and shows a dated note + disclaimer", async () => {
    const user = userEvent.setup();
    fake.state.suggestion = freshNetflix();
    render(<SubscriptionModal open onClose={() => {}} />);

    const amount = screen.getByLabelText(/^Amount/);
    expect(amount).toHaveValue(null); // empty to start

    await user.type(screen.getByLabelText(/^Name/), "Netflix");

    // The lookup fired for the typed name.
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());

    // The amount pre-filled to the suggestion's major value (USD 1549 → 15.49),
    // and the currency/cycle adopted the suggestion.
    await waitFor(() => expect(amount).toHaveValue(15.49));
    expect(screen.getByLabelText(/Currency/)).toHaveValue("USD");
    expect(screen.getByLabelText(/Billing cycle/)).toHaveValue("Monthly");

    // A dated note names the as-of date, says "please confirm", and carries the
    // "approximate, always verify" disclaimer.
    const note = await screen.findByText(/typical as of/i);
    expect(note.textContent).toContain(todayIso());
    expect(note.textContent).toMatch(/please confirm/i);
    expect(note.textContent).toMatch(/approximate/i);
    expect(note.textContent).toMatch(/verify/i);
    // The note shows the FORMATTED money (USD 1549 → 15.49) with the currency
    // code exactly ONCE (no "15.49 USD USD" double-print).
    expect(note.textContent).toMatch(/15\.49/);
    expect(note.textContent).toMatch(/15\.49 USD/);
    expect(note.textContent).not.toMatch(/USD\s+USD/);
  });

  it("CREATE: an unknown-currency match does NOT pre-fill the amount but adopts currency/cycle and shows a one-currency note", async () => {
    const user = userEvent.setup();
    // "ZZZZ" is not in the money exponent table, so `toMajor` throws → the amount
    // is NOT pre-filled (the note still informs via the raw-minor fallback).
    fake.state.suggestion = {
      amountMinor: 1549,
      currency: "ZZZZ",
      billingCycle: "Yearly",
      asOf: todayIso(),
    };

    expect(() =>
      render(<SubscriptionModal open onClose={() => {}} />),
    ).not.toThrow();

    const amount = screen.getByLabelText(/^Amount/);
    await user.type(screen.getByLabelText(/^Name/), "Mystery");
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());

    // The dated note renders (nothing threw) with its unknown-currency fallback:
    // "ZZZZ 1549", with the currency code shown exactly ONCE.
    const note = await screen.findByText(/typical as of/i);
    expect(note.textContent).toMatch(/ZZZZ\s+1549/);
    expect(note.textContent).not.toMatch(/ZZZZ[^]*ZZZZ/);

    // Currency and cycle still adopt the suggestion, but the amount stays empty
    // (toMajor could not render a major string for the unknown currency).
    await waitFor(() =>
      expect(screen.getByLabelText(/Currency/)).toHaveValue("ZZZZ"),
    );
    expect(screen.getByLabelText(/Billing cycle/)).toHaveValue("Yearly");
    expect(amount).toHaveValue(null);
  });

  it("CREATE: the user's already-typed amount is NEVER overwritten by a later match", async () => {
    const user = userEvent.setup();
    fake.state.suggestion = freshNetflix();
    render(<SubscriptionModal open onClose={() => {}} />);

    // The user types an amount FIRST (marking it user-edited)...
    const amount = screen.getByLabelText(/^Amount/);
    await user.type(amount, "42");
    expect(amount).toHaveValue(42);

    // ...then types a name that matches. The suggestion must NOT clobber "42".
    await user.type(screen.getByLabelText(/^Name/), "Netflix");
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());

    // Give the async lookup a chance to resolve, then assert the value is still 42.
    const note = await screen.findByText(/typical as of/i); // note still shows
    expect(note).toBeInTheDocument();
    expect(amount).toHaveValue(42);
  });

  it("CREATE: after a pre-fill, editing the amount then re-typing the name does NOT re-fill", async () => {
    const user = userEvent.setup();
    fake.state.suggestion = freshNetflix();
    render(<SubscriptionModal open onClose={() => {}} />);

    const name = screen.getByLabelText(/^Name/);
    const amount = screen.getByLabelText(/^Amount/);

    // First match pre-fills 15.49.
    await user.type(name, "Netflix");
    await waitFor(() => expect(amount).toHaveValue(15.49));

    // The user edits the amount — their value now wins forever.
    await user.clear(amount);
    await user.type(amount, "7");
    expect(amount).toHaveValue(7);

    // Keep typing the name (still a match): the suggestion must NOT re-overwrite.
    await user.type(name, " Premium");
    // (unknown "netflix premium" would miss anyway, so also type a known match)
    await user.clear(name);
    await user.type(name, "Netflix");
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());

    expect(amount).toHaveValue(7);
  });

  it("CREATE: a non-matching name shows no note and pre-fills nothing (silent)", async () => {
    const user = userEvent.setup();
    fake.state.suggestion = null; // the seed misses for every name
    render(<SubscriptionModal open onClose={() => {}} />);

    await user.type(screen.getByLabelText(/^Name/), "MyCustomThing");
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());

    expect(screen.getByLabelText(/^Amount/)).toHaveValue(null);
    expect(screen.queryByText(/typical as of/i)).toBeNull();
  });

  it("CREATE: clearing the name ignores a late-resolving match (no stale note on an empty field)", async () => {
    const user = userEvent.setup();
    // The lookup for a non-empty name resolves ONLY when we release it, so we can
    // clear the name while it is in flight and prove the late match is ignored.
    let release!: (v: IpcResult<PriceSuggestion | null>) => void;
    const pending = new Promise<IpcResult<PriceSuggestion | null>>((r) => {
      release = r;
    });
    fake.suggestSpy.mockImplementation((_name: string) => pending);

    render(<SubscriptionModal open onClose={() => {}} />);
    const name = screen.getByLabelText(/^Name/);

    // Type a name (fires the in-flight lookup), then CLEAR it before resolving.
    await user.type(name, "Netflix");
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());
    await user.clear(name);

    // Now resolve the stale lookup with a match. The empty-name branch already
    // bumped the sequence ref, so this resolve is dropped — no note appears.
    release({ ok: true, data: freshNetflix() });
    await pending;

    // Give React a tick to process any (ignored) resolution.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/typical as of/i)).toBeNull();
    expect(screen.getByLabelText(/^Amount/)).toHaveValue(null);
  });

  it("CREATE: a STALE seed (>~1yr) shows the note but does NOT auto-fill the amount", async () => {
    const user = userEvent.setup();
    // asOf far in the past → always stale relative to any real `today`.
    fake.state.suggestion = {
      amountMinor: 1549,
      currency: "USD",
      billingCycle: "Monthly",
      asOf: "2020-01-01",
    };
    render(<SubscriptionModal open onClose={() => {}} />);

    const amount = screen.getByLabelText(/^Amount/);
    await user.type(screen.getByLabelText(/^Name/), "Netflix");
    await waitFor(() => expect(fake.suggestSpy).toHaveBeenCalled());

    // The dated note still informs (naming the old date)...
    const note = await screen.findByText(/typical as of/i);
    expect(note.textContent).toContain("2020-01-01");
    // ...but the amount is NOT silently pre-filled from the stale seed.
    expect(amount).toHaveValue(null);
  });

  it("EDIT: never queries a suggestion and never shows the note", async () => {
    const subscription = makeSubscription({
      id: "edit-no-suggest",
      name: "Netflix",
      currency: "USD",
      amountMinor: 49900,
    });
    // Even if the fake WOULD return a suggestion, EDIT mode must not query.
    fake.state.suggestion = freshNetflix();
    render(
      <SubscriptionModal open onClose={() => {}} subscription={subscription} />,
    );

    // Give any (erroneous) async lookup time to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.suggestSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/typical as of/i)).toBeNull();
  });
});

// --- Accessibility: axe scan + focus trap/return (Story 3.7) -----------------

describe("accessibility of the open modal (Story 3.7)", () => {
  it("the open Add/Edit modal has no serious/critical axe violations", async () => {
    render(<SubscriptionModal open onClose={() => {}} />);
    await screen.findByRole("dialog", { name: /add subscription/i });

    // Mirror the List/palette scans: jsdom cannot compute color contrast, so
    // that one rule stays disabled (the sanctioned exception) — nothing else.
    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });

  it("traps Tab / Shift-Tab within the dialog (focus never reaches the page behind)", async () => {
    const user = userEvent.setup();
    // A page-behind button that must NEVER receive focus from within the modal.
    const behind = document.createElement("button");
    behind.textContent = "behind";
    document.body.appendChild(behind);

    render(<SubscriptionModal open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", {
      name: /add subscription/i,
    });

    // Derive the first/last focusables from the SAME selector the component's
    // trap uses, so the test pins the real wrap boundaries (not a brittle
    // "last control happens to be a button" assumption).
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // Tab from the LAST focusable must wrap to the FIRST (trap, not escape).
    last.focus();
    expect(last).toHaveFocus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(behind).not.toHaveFocus();

    // Shift-Tab from the FIRST focusable must wrap to the LAST (the branch at
    // SubscriptionModal.tsx:526-528), never out to the page behind.
    first.focus();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(behind).not.toHaveFocus();

    behind.remove();
  });

  it("returns focus to the triggering element when it closes", async () => {
    // A trigger focused BEFORE the modal opens, standing in for the top-bar Add
    // button; focus must return here on close (Cancel / Esc / backdrop all route
    // through the controlled `open` prop going false).
    const trigger = document.createElement("button");
    trigger.textContent = "open add";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const onClose = vi.fn();
    const { rerender } = render(
      <SubscriptionModal open onClose={onClose} />,
    );
    await screen.findByRole("dialog", { name: /add subscription/i });

    // Closing (open → false) runs the focus-management cleanup that restores
    // focus to whatever was focused when the modal opened.
    rerender(<SubscriptionModal open={false} onClose={onClose} />);

    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});
