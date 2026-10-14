// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import Settings from "@/views/Settings";
import About from "@/views/About";
import {
  SettingsScaffold,
  SettingsSection,
} from "@/components/SettingsSection";
import { APP_VERSION } from "@/version";
import pkg from "../package.json";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import type { SettingsV2 as SettingsModel } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
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
  homeCurrency: "INR",
  notification: {
    enabled: true,
    leadTimes: ["same-day", "one-day", "three-days"],
  },
  backupFrequency: "weekly",
  theme: "dark",
  accentColor: "#92400e", // Warm Graphite default (ochre); the old purple is retired
  trayMode: false,
  dataFolder: null,
  online: { liveLogoFetch: false, fxRefresh: false },
};

// --- Fake SubbyApi facade -----------------------------------------------------

interface FakeApi extends SubbyApi {
  updateSpy: ReturnType<typeof vi.fn>;
  chooseFolderSpy: ReturnType<typeof vi.fn>;
  state: {
    subscriptions: SubscriptionV2[];
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
    setState: () => ok(fake.state.subscriptions),

    // --- Categories ---
    listCategories: () => ok(fake.state.categories),
    createCategory: () =>
      ok({
        categories: fake.state.categories,
        created: fake.state.categories[0],
      }),
    updateCategory: () => ok(fake.state.categories),
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

// --- Section-insert scaffold: labelled landmarks (Story 3.2 AC) --------------

describe("Settings section-insert scaffold (Story 3.2)", () => {
  it("renders every Settings section as a labelled landmark region", async () => {
    render(<Settings />);
    await screen.findByLabelText("Theme");

    // Each v1 group is now a <section> landmark whose accessible name is its
    // own visible heading (region role requires an accessible name to resolve).
    for (const name of [
      "General",
      "Notifications",
      "Backups",
      "Appearance",
      "System",
    ]) {
      expect(
        screen.getByRole("region", { name }),
        `missing labelled section "${name}"`,
      ).toBeInTheDocument();
    }
  });

  it("renders a region whose accessible name IS its own visible heading", () => {
    render(
      <SettingsScaffold title="Settings">
        <SettingsSection title="Backups" description="…">
          <button type="button">a control</button>
        </SettingsSection>
      </SettingsScaffold>,
    );

    const region = screen.getByRole("region", { name: "Backups" });
    const heading = screen.getByRole("heading", { name: "Backups" });
    // The section's accessible name comes from its own heading (aria-labelledby
    // → the h3 id), not a separate aria-label.
    expect(region).toHaveAttribute("aria-labelledby", heading.id);
    expect(region).not.toHaveAttribute("aria-label");
  });

  it("inserting one SettingsSection is additive — siblings are unchanged", () => {
    // Baseline: two sections.
    const { rerender } = render(
      <SettingsScaffold title="Settings">
        <SettingsSection title="General">
          <span>general controls</span>
        </SettingsSection>
        <SettingsSection title="Appearance">
          <span>appearance controls</span>
        </SettingsSection>
      </SettingsScaffold>,
    );

    expect(screen.getAllByRole("region")).toHaveLength(2);

    // A later epic appends ONE child in reading order (insert, don't
    // restructure): the new titled landmark appears and the originals persist.
    rerender(
      <SettingsScaffold title="Settings">
        <SettingsSection title="General">
          <span>general controls</span>
        </SettingsSection>
        <SettingsSection title="Appearance">
          <span>appearance controls</span>
        </SettingsSection>
        <SettingsSection title="Home Currency">
          <span>home currency controls</span>
        </SettingsSection>
      </SettingsScaffold>,
    );

    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(3);
    expect(regions.map((r) => r.getAttribute("aria-labelledby"))).toHaveLength(3);
    expect(screen.getByRole("region", { name: "General" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Appearance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Home Currency" }),
    ).toBeInTheDocument();
  });

  it("omits the description paragraph when none is provided", () => {
    render(
      <SettingsScaffold title="Settings">
        <SettingsSection title="Home Currency">
          <span>controls</span>
        </SettingsSection>
      </SettingsScaffold>,
    );

    const region = screen.getByRole("region", { name: "Home Currency" });
    // Only the heading text — no description <p> is emitted when omitted.
    expect(region.querySelector("p")).toBeNull();
  });
});

// --- Accent reconciliation: honest theme-token presentation (Story 3.2) ------

describe("Settings accent control reconciliation (Story 3.1 deferred seam)", () => {
  it("keeps a discoverable 'Accent color' control", async () => {
    render(<Settings />);
    await screen.findByLabelText("Theme");

    expect(
      screen.getByRole("group", { name: "Accent color" }),
    ).toBeInTheDocument();
  });

  it("presents the theme accents honestly — no misleading free-hex input", async () => {
    render(<Settings />);
    const group = await screen.findByRole("group", { name: "Accent color" });

    // No free-hex color input that would disagree with the painted token.
    expect(group.querySelector('input[type="color"]')).toBeNull();
    // The two theme accents are explained as following the active theme.
    expect(
      within(group).getByText(/follows the active theme/i),
    ).toBeInTheDocument();
    // Both swatches are shown (the active one carries a "(current)" marker).
    expect(within(group).getByText("Light")).toBeInTheDocument();
    expect(within(group).getByText(/^Dark/)).toBeInTheDocument();
  });

  it("marks the active-theme swatch as current (dark-seeded → amber/Dark)", async () => {
    // KNOWN_SETTINGS.theme is "dark" → the Dark (amber) swatch is current.
    render(<Settings />);
    const group = await screen.findByRole("group", { name: "Accent color" });

    // The current marker is text (never color-only) + aria-current.
    const current = within(group).getByText(/current/i);
    expect(current).toHaveTextContent("Dark (current)");
    expect(current).toHaveAttribute("aria-current", "true");

    // Exactly one swatch is marked current, and it is the Dark one.
    const marked = within(group)
      .getAllByText(/^(Light|Dark)/)
      .filter((el) => el.getAttribute("aria-current") === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("Dark");
  });
});

// --- About: app version + single ECB attribution (Story 3.2) -----------------

describe("About version and attribution scaffold (Story 3.2)", () => {
  it("renders the app-version line with the real package.json version", () => {
    render(<About />);

    // The build-time constant is pinned to the real package version (not the
    // "0.0.0-dev" fallback), and that exact string is rendered.
    expect(APP_VERSION).toBe(pkg.version);
    expect(screen.getByText("Version", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(pkg.version)).toBeInTheDocument();
  });

  it("hosts the single ECB attribution section (not duplicated)", () => {
    render(<About />);

    expect(
      screen.getAllByText(/European Central Bank/),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("region", { name: "Exchange rates" }),
    ).toHaveLength(1);
  });
});
