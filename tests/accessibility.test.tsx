// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { axe } from "jest-axe";

import App from "@/App";
import Dashboard from "@/views/Dashboard";
import About from "@/views/About";
import Settings from "@/views/Settings";
import { setSubby } from "@/api/subby";
import {
  initStores,
  subscriptionsStore,
  categoriesStore,
  settingsStore,
  errorStore,
} from "@/stores";

import { DEFAULT_SETTINGS } from "core/models/schema";
import type { Settings as SettingsModel } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { Category } from "core/models/category";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Accessibility checks (Task 30.2, Req 22.1–22.4).
 *
 * Two complementary kinds of assertion, all in jsdom:
 *   - Automated axe scans of the key views (Dashboard, About, Settings) and the
 *     full App shell assert no serious/critical WCAG violations (Req 22.1,
 *     22.3). axe in jsdom cannot measure rendered colors, so the color-contrast
 *     rule is disabled here; high-contrast support is asserted from the CSS in
 *     the dedicated test below (Req 22.4).
 *   - Keyboard-navigation and labelling assertions exercise the App shell:
 *     the skip-link is the first focusable element, nav buttons are operable,
 *     the digit shortcuts switch views, "n" opens the Add modal (Req 22.1,
 *     22.2), and icon-only controls expose accessible names (Req 22.3).
 */

// --- IpcResult helpers --------------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

// --- Fake SubbyApi facade -----------------------------------------------------

interface FakeApi extends SubbyApi {
  state: {
    subscriptions: Subscription[];
    categories: Category[];
    settings: SettingsModel;
  };
  dataChangedListeners: Array<() => void>;
}

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
    website: "netflix.example",
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

function makeCategory(overrides: Partial<Category> = {}): Category {
  return { id: "cat-1", name: "Streaming", isDefault: true, ...overrides };
}

function createFakeApi(): FakeApi {
  const fake: FakeApi = {
    state: {
      subscriptions: [
        makeSubscription({ id: "sub-1", name: "Netflix", amount: 499 }),
        makeSubscription({
          id: "sub-2",
          name: "Spotify",
          provider: "Spotify AB",
          category: "Music",
          amount: 119,
          billingCycle: "Yearly",
        }),
      ],
      categories: [
        makeCategory({ id: "cat-1", name: "Streaming" }),
        makeCategory({ id: "cat-2", name: "Music" }),
      ],
      settings: { ...DEFAULT_SETTINGS },
    },
    dataChangedListeners: [],

    listSubscriptions: () => ok(fake.state.subscriptions),
    createSubscription: () => ok(fake.state.subscriptions),
    updateSubscription: () => ok(fake.state.subscriptions),
    deleteSubscription: () => ok(fake.state.subscriptions),
    toggleActive: () => ok(fake.state.subscriptions),

    listCategories: () => ok(fake.state.categories),
    createCategory: () =>
      ok({ categories: fake.state.categories, created: fake.state.categories[0] }),
    deleteCategory: () =>
      ok({ needsConfirmation: false as const, categories: fake.state.categories }),

    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsModel | null>(fake.state.settings),

    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/export.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok(fake.state.subscriptions),

    onDataChanged(cb: () => void): Unsubscribe {
      fake.dataChangedListeners.push(cb);
      return () => {
        fake.dataChangedListeners = fake.dataChangedListeners.filter((c) => c !== cb);
      };
    },
    onError(_cb: (error: AppError) => void): Unsubscribe {
      return () => {};
    },
  };
  return fake;
}

// --- axe configuration --------------------------------------------------------

/**
 * Run axe and return only serious/critical violations. The color-contrast rule
 * is disabled because jsdom does not perform layout/painting, so axe cannot
 * measure real contrast (it would otherwise yield noise, not findings).
 * High-contrast support is verified separately from globals.css (Req 22.4).
 */
async function seriousViolations(container: HTMLElement) {
  const results = await axe(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

/** Compact, readable description of any violations for assertion messages. */
function describeViolations(
  violations: Awaited<ReturnType<typeof seriousViolations>>,
): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}`)
    .join("\n");
}

// --- Fixture ------------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

async function seedStores(): Promise<void> {
  fake = createFakeApi();
  setSubby(fake);
  teardown = initStores();
  await waitFor(() => {
    expect(settingsStore.getSnapshot().loaded).toBe(true);
    expect(subscriptionsStore.getSnapshot().loaded).toBe(true);
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

// --- Automated axe scans (Req 22.1, 22.3) ------------------------------------

describe("Accessibility: automated axe scans (Req 22.1, 22.3)", () => {
  it("Dashboard has no serious/critical violations", async () => {
    const { container } = render(<Dashboard />);
    await screen.findByText("Active Subscriptions");
    const violations = await seriousViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("About has no serious/critical violations", async () => {
    const { container } = render(<About />);
    const violations = await seriousViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("Settings has no serious/critical violations", async () => {
    const { container } = render(<Settings />);
    await screen.findByLabelText("Theme");
    const violations = await seriousViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it("the App shell has no serious/critical violations", async () => {
    const { container } = render(<App />);
    await screen.findByRole("navigation", { name: "Primary" });
    const violations = await seriousViolations(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});

// --- Keyboard navigation (Req 22.1, 22.2) ------------------------------------

describe("Accessibility: keyboard navigation (Req 22.1, 22.2)", () => {
  it("makes the skip-link the first focusable element", async () => {
    const user = userEvent.setup();
    render(<App />);

    const skipLink = screen.getByRole("link", { name: /skip to main content/i });
    await user.tab();
    expect(skipLink).toHaveFocus();
  });

  it("exposes the primary nav as operable, tabbable buttons", async () => {
    const user = userEvent.setup();
    render(<App />);

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const navButtons = within(nav).getAllByRole("button");
    expect(navButtons.length).toBe(6);

    // Each nav button is reachable by keyboard (focusable) and operable.
    for (const button of navButtons) {
      button.focus();
      expect(button).toHaveFocus();
    }

    // Activating a nav button with the keyboard switches the view.
    const listButton = within(nav).getByRole("button", { name: /list/i });
    listButton.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("main")).toHaveAttribute("aria-label", "List");
  });

  it("switches views with the digit shortcuts (Req 22.2)", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("main")).toHaveAttribute("aria-label", "Dashboard");

    // "2" → List (second nav item).
    await user.keyboard("2");
    expect(screen.getByRole("main")).toHaveAttribute("aria-label", "List");

    // "5" → Settings.
    await user.keyboard("5");
    await waitFor(() =>
      expect(screen.getByRole("main")).toHaveAttribute("aria-label", "Settings"),
    );
  });

  it("opens the Add modal with the 'n' shortcut (Req 22.2)", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("dialog")).toBeNull();

    await user.keyboard("n");

    const dialog = await screen.findByRole("dialog", { name: "Add subscription" });
    expect(dialog).toBeInTheDocument();
  });
});

// --- Accessible names on icon-only controls (Req 22.3) -----------------------

describe("Accessibility: labelled icon-only controls (Req 22.3)", () => {
  it("gives the theme toggle and Add action accessible names", async () => {
    render(<App />);

    // Icon-only theme toggle exposes a name via aria-label.
    expect(
      screen.getByRole("button", { name: /theme:/i }),
    ).toBeInTheDocument();

    // The primary action names itself (text label beside the icon).
    expect(
      screen.getByRole("button", { name: /add subscription/i }),
    ).toBeInTheDocument();

    // The search trigger announces its purpose.
    expect(
      screen.getByRole("button", { name: /search subscriptions/i }),
    ).toBeInTheDocument();
  });

  it("labels the icon-only Close control in the Add modal", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard("n");
    const dialog = await screen.findByRole("dialog", { name: "Add subscription" });
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
  });
});

// --- Scalable fonts & high-contrast support, from CSS (Req 22.4) -------------

describe("Accessibility: scalable fonts and high contrast (Req 22.4)", () => {
  // Read the stylesheet directly: these are global, token-level guarantees that
  // are not observable through jsdom's (layout-free) computed styles.
  let css: string;

  beforeEach(async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    css = readFileSync(join(root, "src", "styles", "globals.css"), "utf8");
  });

  it("anchors the root font-size to 100% so rem-based sizing scales", () => {
    // Matches `html { font-size: 100%; }` allowing flexible whitespace.
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*100%/);
  });

  it("includes a prefers-contrast media block for high-contrast displays", () => {
    expect(css).toMatch(/@media\s*\(prefers-contrast:\s*more\)/);
  });
});
