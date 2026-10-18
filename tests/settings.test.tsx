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
import { axe } from "jest-axe";
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
  backupsStore,
  errorStore,
} from "@/stores";

import { backupTimestamp } from "core/backup";
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

function fail<T>(message: string): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: false, error: { code: "unknown", message } });
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
  createBackupSpy: ReturnType<typeof vi.fn>;
  restoreBackupSpy: ReturnType<typeof vi.fn>;
  state: {
    subscriptions: SubscriptionV2[];
    categories: Category[];
    settings: SettingsModel;
    backups: string[];
  };
  dataChangedListeners: Array<() => void>;
  emitDataChanged(): void;
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
  // "Back up now" (Story 7.3): resolves with a backup name by default; a test
  // overrides it to a rejected IpcResult to exercise the error→toast path.
  const createBackupSpy = vi.fn(() => ok<string>("2026-01-01-00-00-00-000.json"));
  // Restore (Story 7.4): resolves with the restored subscriptions by default; a
  // test overrides it to a rejected IpcResult to exercise the error→toast path.
  const restoreBackupSpy = vi.fn(() => ok<SubscriptionV2[]>(fake.state.subscriptions));

  const fake: FakeApi = {
    updateSpy,
    chooseFolderSpy,
    createBackupSpy,
    restoreBackupSpy,
    state: {
      subscriptions: [],
      categories: [makeCategory()],
      settings: { ...KNOWN_SETTINGS },
      backups: [],
    },
    dataChangedListeners: [],
    emitDataChanged() {
      for (const cb of fake.dataChangedListeners) cb();
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

    // --- Suggested price (Story 5.4): default fake returns no suggestion ---
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],

    // --- FX snapshot (Story 6.1): not exercised here — a rebased INR snapshot ---
    getFxSnapshot: ((_home: string) =>
      ok({ asOf: new Date().toISOString().slice(0, 10), rates: { INR: "1" } })) as SubbyApi["getFxSnapshot"],

    // --- Logo Pack (Story 8.3): empty pack → every row uses the lettered fallback ---
    getLogoPack: (() =>
      ok({ version: 1, generatedAt: "", note: "", icons: {} })) as SubbyApi["getLogoPack"],

    // --- Logo blob cache + enrichment (Story 8.4): empty cache; enqueue acks ---
    getLogoCache: (() => ok<Record<string, string>>({})) as SubbyApi["getLogoCache"],
    enqueueEnrichment: (() => ok(null)) as SubbyApi["enqueueEnrichment"],

    // --- Data ---
    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>(fake.state.backups),
    restoreBackup: restoreBackupSpy as SubbyApi["restoreBackup"],
    createBackup: createBackupSpy as SubbyApi["createBackup"],

    // --- Events: capture onDataChanged so a test can refresh the stores ---
    onDataChanged(cb: () => void): Unsubscribe {
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

// --- Shared fixture -----------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

/**
 * Install the fake, populate the stores, and wait until settings + backups load.
 * `backups` optionally pre-seeds the fake's backup history BEFORE the stores load
 * so the Backups history list renders with content on first paint.
 */
async function seedStores(backups: string[] = []): Promise<void> {
  fake = createFakeApi();
  fake.state.backups = backups;
  setSubby(fake);
  teardown = initStores();
  await waitFor(() => {
    expect(settingsStore.getSnapshot().loaded).toBe(true);
    expect(backupsStore.getSnapshot().loaded).toBe(true);
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
  backupsStore.reset();
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

// --- Online Features control surface (Story 8.2; FR-25, AD-22) ----------------

describe("Settings → Online Features section (Story 8.2)", () => {
  /** The two switches by their accessible name (feature + state only). */
  const logosName = /fetch brand logos for services subby doesn't bundle/i;
  const fxName = /refresh exchange rates/i;

  it("renders both features OFF by default with both exposure notices visible", async () => {
    render(<Settings />);

    // The section is a labelled landmark region.
    const region = await screen.findByRole("region", { name: "Online Features" });

    const logos = within(region).getByRole("switch", { name: logosName });
    const fx = within(region).getByRole("switch", { name: fxName });
    // KNOWN_SETTINGS.online is all-false → both unchecked.
    expect(logos).not.toBeChecked();
    expect(fx).not.toBeChecked();

    // Both exposure notices are visible BEFORE any toggle is touched, and name
    // the aggregate exposure + the real recipient host (not a per-logo framing).
    expect(
      within(region).getByText(
        /over time this reveals the full set of services you track to google \(t2\.gstatic\.com\)/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(
        /fetches the whole exchange-rate table from frankfurter \(api\.frankfurter\.dev\).*reveals nothing about which currencies or subscriptions you track/is,
      ),
    ).toBeInTheDocument();
  });

  it("pins the EXACT aggregate-exposure logo notice wording (Story 8.5, AD-14, FR-27)", async () => {
    // The highest-scrutiny notice must disclose the AGGREGATE exposure — the full
    // set of services over time, the real recipient (Google / t2.gstatic.com), AND
    // the IP linkage — never a per-logo framing. This exact string is a consent
    // correctness guarantee; pinning it makes any silent copy regression FAIL.
    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });

    const notice = within(region).getByText(
      "Over time this reveals the full set of services you track to Google (t2.gstatic.com), linked to your IP address.",
    );
    expect(notice).toBeInTheDocument();

    // The notice is the logo switch's own programmatic description (so a screen
    // reader hears the aggregate disclosure WITH the control it gates).
    const logos = within(region).getByRole("switch", { name: logosName });
    expect(logos.getAttribute("aria-describedby")).toBe(notice.id);

    // Guard the three load-bearing phrases individually so a partial edit (e.g.
    // dropping the IP linkage or renaming the recipient) also fails.
    const text = notice.textContent ?? "";
    expect(text).toContain("full set of services you track");
    expect(text).toContain("Google (t2.gstatic.com)");
    expect(text).toContain("linked to your IP address");
    // It is an AGGREGATE framing, never a single-logo one.
    expect(text).not.toMatch(/\b(this logo|a logo|each logo|per logo)\b/i);
  });

  it("pins the EXACT FX-refresh notice wording (Story 8.6, FR-28)", async () => {
    // The FX notice must state the whole-table, at-most-daily, reveals-nothing
    // framing — the privacy-safe live fetch. Pinning this exact string makes any
    // silent copy regression FAIL (per the spec's verify/pin requirement).
    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });

    const notice = within(region).getByText(
      "Fetches the whole exchange-rate table from Frankfurter (api.frankfurter.dev), at most once a day. Reveals nothing about which currencies or subscriptions you track.",
    );
    expect(notice).toBeInTheDocument();

    // The notice is the FX switch's own programmatic description.
    const fx = within(region).getByRole("switch", { name: fxName });
    expect(fx.getAttribute("aria-describedby")).toBe(notice.id);

    // Guard the three load-bearing phrases individually.
    const text = notice.textContent ?? "";
    expect(text).toContain("whole exchange-rate table");
    expect(text).toContain("api.frankfurter.dev");
    expect(text).toContain("at most once a day");
    expect(text).toContain("Reveals nothing about which currencies or subscriptions you track");
  });

  it("each switch's aria-describedby resolves to its own exposure notice", async () => {
    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });

    const logos = within(region).getByRole("switch", { name: logosName });
    const logosDescId = logos.getAttribute("aria-describedby");
    expect(logosDescId).toBeTruthy();
    const logosNotice = document.getElementById(logosDescId!);
    expect(logosNotice).not.toBeNull();
    expect(logosNotice).toHaveTextContent(/t2\.gstatic\.com/);
    // The notice must be readable BEFORE the switch — it precedes it in DOM
    // order (aria-describedby resolution alone is order-independent).
    expect(
      logosNotice!.compareDocumentPosition(logos) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The notice is a description, NOT folded into the accessible name.
    expect(logos).toHaveAccessibleName(
      /fetch brand logos for services subby doesn't bundle/i,
    );
    expect(logos).toHaveAccessibleName(expect.not.stringMatching(/t2\.gstatic/i));

    const fx = within(region).getByRole("switch", { name: fxName });
    const fxDescId = fx.getAttribute("aria-describedby");
    expect(fxDescId).toBeTruthy();
    const fxNotice = document.getElementById(fxDescId!);
    expect(fxNotice).not.toBeNull();
    expect(fxNotice).toHaveTextContent(/api\.frankfurter\.dev/);
    expect(fx).toHaveAccessibleName(/refresh exchange rates/i);
    expect(fx).toHaveAccessibleName(expect.not.stringMatching(/frankfurter/i));
  });

  it("enabling live logos persists the nested online patch exactly once (fxRefresh preserved)", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });

    await user.click(within(region).getByRole("switch", { name: logosName }));

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    const patch = fake.updateSpy.mock.calls[0][0] as Partial<SettingsModel>;
    expect(patch.online).toEqual({ liveLogoFetch: true, fxRefresh: false });
  });

  it("enabling FX refresh persists the nested online patch exactly once (liveLogoFetch preserved)", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });

    await user.click(within(region).getByRole("switch", { name: fxName }));

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    const patch = fake.updateSpy.mock.calls[0][0] as Partial<SettingsModel>;
    expect(patch.online).toEqual({ liveLogoFetch: false, fxRefresh: true });
  });

  it("disabling a feature persists that flag false while preserving the other", async () => {
    const user = userEvent.setup();
    // Seed with live logos already ON so a click turns it OFF.
    fake.state.settings = {
      ...fake.state.settings,
      online: { liveLogoFetch: true, fxRefresh: false },
    };
    settingsStore.reset();
    teardown?.();
    teardown = initStores();
    await waitFor(() => expect(settingsStore.getSnapshot().loaded).toBe(true));

    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });
    const logos = within(region).getByRole("switch", { name: logosName });
    expect(logos).toBeChecked();

    await user.click(logos);

    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));
    const patch = fake.updateSpy.mock.calls[0][0] as Partial<SettingsModel>;
    expect(patch.online).toEqual({ liveLogoFetch: false, fxRefresh: false });
  });

  it("the Online Features section is keyboard-operable and axe-clean", async () => {
    const user = userEvent.setup();
    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Online Features" });
    const logos = within(region).getByRole("switch", { name: logosName });

    // Keyboard-operable: focus + Space toggles the switch (no mouse needed).
    logos.focus();
    expect(logos).toHaveFocus();
    await user.keyboard(" ");
    await waitFor(() => expect(fake.updateSpy).toHaveBeenCalledTimes(1));

    // jsdom cannot compute color contrast (the sanctioned exception, mirrors the
    // Categories scan); every other rule stays on.
    const results = await axe(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
  });
});

// --- Scheduled & manual backups (Story 7.3) -----------------------------------

describe("Backups section: 'Back up now' + 'Last backup' (Story 7.3)", () => {
  it("'Back up now' calls dataApi.createBackup and is keyboard-operable", async () => {
    const user = userEvent.setup();
    render(<Settings />);

    const button = await screen.findByRole("button", { name: /back up now/i });
    // Keyboard-operable: focus + Enter activates it (no mouse needed).
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(fake.createBackupSpy).toHaveBeenCalledTimes(1),
    );
    // Non-destructive: the manual action is NOT a settings patch.
    expect(fake.updateSpy).not.toHaveBeenCalled();
    // No native confirm dialog (window.confirm) is used.
    expect(errorStore.getSnapshot().latest).toBeNull();
  });

  it("disables the button while the backup is in flight, then re-enables it", async () => {
    const user = userEvent.setup();

    // A deferred createBackup lets us observe the in-flight disabled state.
    let resolveBackup: (r: IpcResult<string>) => void = () => {};
    fake.createBackupSpy.mockImplementationOnce(
      () =>
        new Promise<IpcResult<string>>((resolve) => {
          resolveBackup = resolve;
        }),
    );

    render(<Settings />);
    const button = await screen.findByRole("button", { name: /back up now/i });
    expect(button).not.toBeDisabled();

    await user.click(button);
    // In flight → disabled.
    await waitFor(() => expect(button).toBeDisabled());

    // Resolve the backup → the button re-enables.
    resolveBackup({ ok: true, data: "2026-01-01-00-00-00-000.json" });
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("records a toast error when the backup fails (no crash)", async () => {
    const user = userEvent.setup();
    fake.createBackupSpy.mockImplementationOnce(() =>
      fail<string>("disk full"),
    );

    render(<Settings />);
    const button = await screen.findByRole("button", { name: /back up now/i });
    await user.click(button);

    await waitFor(() => {
      expect(errorStore.getSnapshot().latest?.message).toBe("disk full");
    });
  });

  it("shows 'Never' when lastBackupAt is null/absent", async () => {
    render(<Settings />); // KNOWN_SETTINGS.lastBackupAt is undefined
    const region = await screen.findByRole("region", { name: "Backups" });
    expect(within(region).getByText("Never")).toBeInTheDocument();
  });

  it("shows the last-backup time when lastBackupAt is set", async () => {
    const stamp = "2026-03-07T09:05:00.000Z";
    fake.state.settings = { ...fake.state.settings, lastBackupAt: stamp };
    settingsStore.reset();
    teardown?.();
    teardown = initStores();
    await waitFor(() =>
      expect(settingsStore.getSnapshot().loaded).toBe(true),
    );

    render(<Settings />);
    const region = await screen.findByRole("region", { name: "Backups" });
    // Not "Never" — the formatted locale instant is shown instead.
    expect(within(region).queryByText("Never")).toBeNull();
    expect(
      within(region).getByText(new Date(stamp).toLocaleString()),
    ).toBeInTheDocument();
  });
});

// --- Backup history list + branded restore (Story 7.4) ------------------------

describe("Backups section: history list + branded restore (Story 7.4)", () => {
  // Two well-formed names (newest-first as the adapter returns them) + one
  // foreign name that `backupTimestamp` cannot parse (must fall back to raw).
  const NEWER = "2026-03-07-09-05-42-137-0000.json";
  const OLDER = "2026-03-06-08-00-00-000-0000.json";
  const FOREIGN = "legacy-export.json";

  async function seedWithBackups(names: string[]): Promise<void> {
    cleanup();
    teardown?.();
    subscriptionsStore.reset();
    categoriesStore.reset();
    settingsStore.reset();
    backupsStore.reset();
    errorStore.clear();
    await seedStores(names);
  }

  it("shows 'No backups yet' when the history is empty", async () => {
    render(<Settings />); // default seed = no backups
    const region = await screen.findByRole("region", { name: "Backups" });
    expect(within(region).getByText("No backups yet")).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /restore/i })).toBeNull();
  });

  it("renders the history newest-first with formatted times; a foreign name falls back to raw", async () => {
    await seedWithBackups([NEWER, OLDER, FOREIGN]);
    render(<Settings />);
    const list = await screen.findByRole("list", { name: "Backup history" });

    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Newest-first order is preserved from the adapter's sort.
    expect(within(items[0]).getByText(new Date(backupTimestamp(NEWER)!).toLocaleString())).toBeInTheDocument();
    expect(within(items[1]).getByText(new Date(backupTimestamp(OLDER)!).toLocaleString())).toBeInTheDocument();
    // A foreign name shows its raw name (still restorable).
    expect(within(items[2]).getByText(FOREIGN)).toBeInTheDocument();
  });

  it("clicking Restore opens the branded dialog (cancel is the focus default); Cancel runs NO restore", async () => {
    const user = userEvent.setup();
    await seedWithBackups([NEWER]);
    render(<Settings />);

    const restoreBtn = await screen.findByRole("button", {
      name: /restore backup from/i,
    });
    await user.click(restoreBtn);

    // A branded alertdialog (NOT window.confirm) names the impact + the safety.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Replace all current subscriptions/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/backed up first so you can undo this/i)).toBeInTheDocument();

    // Cancel is the focus default (an accidental Enter cancels, never restores).
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.restoreBackupSpy).not.toHaveBeenCalled();
  });

  it("Escape cancels the dialog and runs NO restore", async () => {
    const user = userEvent.setup();
    await seedWithBackups([NEWER]);
    render(<Settings />);

    await user.click(
      await screen.findByRole("button", { name: /restore backup from/i }),
    );
    await screen.findByRole("alertdialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.restoreBackupSpy).not.toHaveBeenCalled();
  });

  it("confirming calls dataApi.restoreBackup(name) with the chosen backup", async () => {
    const user = userEvent.setup();
    await seedWithBackups([NEWER]);
    render(<Settings />);

    await user.click(
      await screen.findByRole("button", { name: /restore backup from/i }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(fake.restoreBackupSpy).toHaveBeenCalledTimes(1));
    expect(fake.restoreBackupSpy).toHaveBeenCalledWith(NEWER);
    // The dialog closes after a successful restore.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("routes a restore failure to the global toast (no crash)", async () => {
    const user = userEvent.setup();
    await seedWithBackups([NEWER]);
    fake.restoreBackupSpy.mockImplementationOnce(() =>
      fail<SubscriptionV2[]>("restore failed"),
    );
    render(<Settings />);

    await user.click(
      await screen.findByRole("button", { name: /restore backup from/i }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));

    await waitFor(() =>
      expect(errorStore.getSnapshot().latest?.message).toBe("restore failed"),
    );
  });

  it("refreshes the history after a new backup via the onDataChanged broadcast", async () => {
    await seedWithBackups([OLDER]);
    render(<Settings />);
    const list = await screen.findByRole("list", { name: "Backup history" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);

    // A "Back up now" wrote a new backup, then the handler broadcasts the change.
    fake.state.backups = [NEWER, OLDER];
    fake.emitDataChanged();

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Backup history" })).getAllByRole(
          "listitem",
        ),
      ).toHaveLength(2),
    );
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
      "Online Features",
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
