// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import Settings from "@/views/Settings";
import About from "@/views/About";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import type { Settings as SettingsModel } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Unit tests for Settings persistence and branding/attribution (Task 26.2).
 *
 * Persistence (Req 15.2): the Settings view reads the live `settingsStore`
 * (populated by `initStores()`) and persists every control change immediately
 * through `settingsApi.update(...)` → the fake {@link SubbyApi}'s
 * `updateSettings` spy. Each test changes a control and asserts the spy was
 * called with the expected patch. The data-folder button calls
 * `settingsApi.chooseDataFolder()` → the `chooseDataFolder` spy.
 *
 * Branding (Req 23.1, 23.2, 23.3): the About view shows the name "Subby", the
 * tagline, and attribution to Mr. K / @KubeMonk / OpsAlchemist; the Settings
 * footer carries the same attribution non-intrusively.
 */

// --- IpcResult helpers --------------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

// --- Known settings the fake serves -------------------------------------------

/** A known, fully-specified settings object so control state is deterministic. */
const KNOWN_SETTINGS: SettingsModel = {
  defaultCurrency: "INR",
  notification: {
    enabled: true,
    leadTimes: ["same-day", "one-day", "three-days"],
  },
  backupFrequency: "weekly",
  theme: "dark",
  accentColor: "#7c5cff",
  trayMode: false,
  dataFolder: null,
};

// --- Fake SubbyApi facade -----------------------------------------------------

interface FakeApi extends SubbyApi {
  updateSpy: ReturnType<typeof vi.fn>;
  chooseFolderSpy: ReturnType<typeof vi.fn>;
  state: {
    subscriptions: Subscription[];
    categories: Category[];
    settings: SettingsModel;
  };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
  return { id: "cat-1", name: "Streaming", isDefault: true, ...overrides };
}

function createFakeApi(): FakeApi {
  // updateSettings echoes the merged settings back as { ok: true, data }.
  const updateSpy = vi.fn((patch: Partial<SettingsModel>) =>
    ok<SettingsModel>({ ...fake.state.settings, ...patch }),
  );
  const chooseFolderSpy = vi.fn(() =>
    ok<SettingsModel | null>(fake.state.settings),
  );

  const fake: FakeApi = {
    updateSpy,
    chooseFolderSpy,
    state: {
      subscriptions: [],
      categories: [makeCategory()],
      settings: { ...KNOWN_SETTINGS },
    },

    // --- Subscriptions ---
    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: () => ok(fake.state.subscriptions),
    updateSubscription: () => ok(fake.state.subscriptions),
    deleteSubscription: () => ok(fake.state.subscriptions),
    toggleActive: () => ok(fake.state.subscriptions),

    // --- Categories ---
    listCategories: () => ok(fake.state.categories),
    createCategory: () =>
      ok({
        categories: fake.state.categories,
        created: fake.state.categories[0],
      }),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    // --- Settings ---
    getSettings: () => ok(fake.state.settings),
    updateSettings: updateSpy as SubbyApi["updateSettings"],
    chooseDataFolder: chooseFolderSpy as SubbyApi["chooseDataFolder"],

    // --- Data ---
    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok(fake.state.subscriptions),

    // --- Events (no-op subscriptions for these tests) ---
    onDataChanged: (): Unsubscribe => () => {},
    onError: (): Unsubscribe => () => {},
  };

  return fake;
}

// --- Shared fixture -----------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

/** Install the fake, populate the stores, and wait until settings load. */
async function seedStores(): Promise<void> {
  fake = createFakeApi();
  setSubby(fake);
  teardown = initStores();
  await waitFor(() => {
    expect(settingsStore.getSnapshot().loaded).toBe(true);
  });
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

// --- Persistence (Req 15.2) ---------------------------------------------------

describe("Settings persistence calls updateSettings (Req 15.2)", () => {
  it("persists a theme change", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    // Confirm the known settings loaded before interacting.
    const themeSelect = await screen.findByLabelText("Theme");
    expect(themeSelect).toHaveValue("dark");

    await user.selectOptions(themeSelect, "light");

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    expect(fake.updateSpy).toHaveBeenCalledWith({ theme: "light" });
  });

  it("persists toggling notifications enabled", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const toggle = await screen.findByRole("switch", {
      name: /enable renewal reminders/i,
    });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    const patch = fake.updateSpy.mock.calls[0][0] as Partial<SettingsModel>;
    expect(patch.notification).toEqual({
      enabled: false,
      leadTimes: ["same-day", "one-day", "three-days"],
    });
  });

  it("persists toggling a reminder lead-time checkbox", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const sameDay = await screen.findByLabelText("Same day");
    expect(sameDay).toBeChecked();

    // Unchecking "same-day" removes it from the persisted leadTimes.
    await user.click(sameDay);

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    const patch = fake.updateSpy.mock.calls[0][0] as Partial<SettingsModel>;
    expect(patch.notification?.leadTimes).toEqual(["one-day", "three-days"]);
  });

  it("persists a backup frequency change", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const backup = await screen.findByLabelText("Backup frequency");
    expect(backup).toHaveValue("weekly");

    await user.selectOptions(backup, "daily");

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    expect(fake.updateSpy).toHaveBeenCalledWith({ backupFrequency: "daily" });
  });

  it("persists an accent color change", async () => {
    render(<Settings />);

    const accent = await screen.findByLabelText("Accent color");
    // Color inputs are awkward for user-event typing; fire the change directly.
    fireEvent.change(accent, { target: { value: "#ff0000" } });

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    expect(fake.updateSpy).toHaveBeenCalledWith({ accentColor: "#ff0000" });
  });

  it("persists toggling Tray_Mode", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const tray = await screen.findByRole("switch", {
      name: /keep running in the system tray/i,
    });
    expect(tray).not.toBeChecked();

    await user.click(tray);

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    expect(fake.updateSpy).toHaveBeenCalledWith({ trayMode: true });
  });

  it("invokes the native data-folder chooser when the button is clicked", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const button = await screen.findByRole("button", {
      name: /choose folder/i,
    });
    await user.click(button);

    await waitFor(() => expect(fake.chooseFolderSpy).toHaveBeenCalledTimes(1));
    // Selecting a folder is not a settings patch, so updateSettings is untouched.
    expect(fake.updateSpy).not.toHaveBeenCalled();
  });
});

// --- Branding & attribution (Req 23.1, 23.2, 23.3) ----------------------------

describe("About branding and attribution (Req 23.1, 23.2)", () => {
  it("shows the product name, tagline, and attribution", () => {
    render(<About />);

    // Name (Req 23.1).
    expect(
      screen.getByRole("heading", { name: "Subby" }),
    ).toBeInTheDocument();
    // Tagline (Req 23.1).
    expect(
      screen.getByText("Take control of your subscriptions."),
    ).toBeInTheDocument();
    // Attribution (Req 23.2).
    expect(screen.getByText("Mr. K")).toBeInTheDocument();
    expect(screen.getByText("@KubeMonk")).toBeInTheDocument();
    expect(screen.getByText("OpsAlchemist")).toBeInTheDocument();
    // ECB exchange-rate attribution (Story 2.3 binding condition).
    expect(
      screen.getByRole("heading", { name: "Exchange rates" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/European Central Bank/)).toBeInTheDocument();
  });
});

describe("Settings footer attribution (Req 23.2, 23.3)", () => {
  it("shows the author attribution in a non-intrusive footer", async () => {
    render(<Settings />);
    await screen.findByLabelText("Theme");

    const footer = document.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer).toHaveTextContent("Subby");
    expect(footer).toHaveTextContent("Mr. K");
    expect(footer).toHaveTextContent("@KubeMonk");
    expect(footer).toHaveTextContent("OpsAlchemist");
  });
});
