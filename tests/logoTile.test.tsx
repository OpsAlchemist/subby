// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import LogoTile from "@/components/LogoTile";
import { setSubby } from "@/api/subby";
import {
  initStores,
  settingsStore,
  logoPackStore,
  logoCacheStore,
  subscriptionsStore,
  categoriesStore,
  backupsStore,
  errorStore,
} from "@/stores";
import type { LogoPack } from "core/logo";

import { DEFAULT_SETTINGS_V2 } from "core/models/schema";
import type { SettingsV2 } from "core/models/settings";
import type { AppError, IpcResult } from "shared/types";
import type { SubbyApi, Unsubscribe } from "shared/subbyApi";

/**
 * Live logo fetch trigger (Story 8.5; FR-27, AD-9, AD-14).
 *
 * {@link LogoTile} is the SINGLE component that resolves pack+cache for every row
 * on every surface, so it is where the opt-in live-logo pipeline is triggered.
 * This file covers the full I/O matrix of the one auto-enqueue effect:
 *
 *   - toggle-ON + a TRUE pack+cache miss for a real domain → enqueues once;
 *   - toggle-OFF + the same miss → NEVER enqueues (the headline off-invariant);
 *   - a bundled hit, a cached hit, or an empty/unparseable website → never;
 *   - N re-renders of the same row → at most ONE enqueue (dedup discipline);
 *   - the toggle flipping ON at runtime while a missing row is visible → one.
 *
 * The tile reads live data from the client stores; we install a fake
 * {@link SubbyApi} whose `enqueueEnrichment` is a spy, `initStores()` to populate,
 * then render `<LogoTile/>` directly (no view) so the assertion is on the trigger
 * itself, isolated from any surface.
 */

// --- IpcResult + fake facade --------------------------------------------------

function ok<T>(data: T): Promise<IpcResult<T>> {
  return Promise.resolve({ ok: true, data });
}

interface FakeApi extends SubbyApi {
  state: { settings: SettingsV2; pack: LogoPack; cache: Record<string, string> };
  enqueueSpy: ReturnType<typeof vi.fn>;
  dataChangedListeners: Array<() => void>;
  emitDataChanged(): void;
}

const NETFLIX_PATH = "M4 1h2v22H4zM18 1h2v22h-2z";
const PACK_WITH_NETFLIX: LogoPack = {
  version: 1,
  generatedAt: "2026-10-18T00:00:00.000Z",
  note: "test",
  icons: { "netflix.com": { title: "Netflix", hex: "E50914", path: NETFLIX_PATH } },
};

function createFakeApi(settings: SettingsV2, pack: LogoPack): FakeApi {
  const enqueueSpy = vi.fn(() => ok<null>(null));
  const fake: FakeApi = {
    state: { settings, pack, cache: {} },
    enqueueSpy,
    dataChangedListeners: [],
    emitDataChanged() {
      for (const cb of this.dataChangedListeners) cb();
    },

    // --- Subscriptions / categories (unused here; benign stubs) ---
    listSubscriptions: () => ok([]),
    createSubscription: () => ok([]),
    updateSubscription: () => ok([]),
    deleteSubscription: () => ok([]),
    setState: () => ok([]),
    listCategories: () => ok([]),
    createCategory: () =>
      ok({ categories: [], created: { id: "c", name: "c", isDefault: false } }),
    updateCategory: () => ok([]),
    deleteCategory: () => ok({ needsConfirmation: false as const, categories: [] }),

    // --- Settings ---
    getSettings: () => ok(fake.state.settings),
    updateSettings: () => ok(fake.state.settings),
    chooseDataFolder: () => ok<SettingsV2 | null>(fake.state.settings),

    // --- Price / FX (unused) ---
    getPriceSuggestion: (() => ok(null)) as SubbyApi["getPriceSuggestion"],
    getFxSnapshot: ((_h: string) =>
      ok({ asOf: "2026-10-01", rates: { INR: "1" } })) as SubbyApi["getFxSnapshot"],

    // --- Logo pack + cache + enrichment ---
    getLogoPack: (() => ok(fake.state.pack)) as SubbyApi["getLogoPack"],
    getLogoCache: (() => ok(fake.state.cache)) as SubbyApi["getLogoCache"],
    enqueueEnrichment: enqueueSpy as SubbyApi["enqueueEnrichment"],

    // --- Data (unused) ---
    importData: () => ok({ applied: [], imported: 0, skipped: 0, rejected: [] }),
    exportData: () => ok({ path: "/tmp/x.json", bytes: 0 }),
    listBackups: () => ok<string[]>([]),
    restoreBackup: () => ok([]),
    createBackup: () => ok("b.json"),

    // --- Events ---
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

// --- Fixture ------------------------------------------------------------------

let fake: FakeApi;
let teardown: () => void;

function settingsWith(liveLogoFetch: boolean): SettingsV2 {
  return {
    ...DEFAULT_SETTINGS_V2,
    online: { liveLogoFetch, fxRefresh: false },
  };
}

/**
 * Wire the stores with the given toggle + pack + cache, wait until the three
 * stores the tile reads have loaded, then render the tile and return nothing.
 */
async function setup(opts: {
  liveLogoFetch: boolean;
  pack?: LogoPack;
  cache?: Record<string, string>;
}): Promise<void> {
  fake = createFakeApi(settingsWith(opts.liveLogoFetch), opts.pack ?? PACK_WITH_NETFLIX);
  fake.state.cache = opts.cache ?? {};
  setSubby(fake);
  teardown = initStores();
  await waitFor(() => {
    expect(settingsStore.getSnapshot().loaded).toBe(true);
    expect(logoPackStore.getSnapshot().loaded).toBe(true);
    expect(logoCacheStore.getSnapshot().loaded).toBe(true);
  });
}

afterEach(() => {
  cleanup();
  teardown?.();
  setSubby(null);
  settingsStore.reset();
  logoPackStore.reset();
  logoCacheStore.reset();
  subscriptionsStore.reset();
  categoriesStore.reset();
  backupsStore.reset();
  errorStore.clear();
  vi.restoreAllMocks();
});

// --- Matrix -------------------------------------------------------------------

describe("LogoTile live logo fetch trigger (Story 8.5; FR-27)", () => {
  it("toggle ON + true miss: enqueues the registrable domain exactly once", async () => {
    await setup({ liveLogoFetch: true });
    // acme.example is in neither the pack nor the cache → lettered fallback.
    render(<LogoTile name="Acme Cloud" website="https://www.acme.example/app" />);

    await waitFor(() => expect(fake.enqueueSpy).toHaveBeenCalledTimes(1));
    // The enqueued key is the normalized registrable domain — the same key the
    // cache + resolver use (scheme/www/path stripped, lowercased).
    expect(fake.enqueueSpy).toHaveBeenCalledWith("acme.example");
  });

  it("toggle OFF + true miss: NEVER enqueues (the headline off-invariant)", async () => {
    await setup({ liveLogoFetch: false });
    render(<LogoTile name="Acme Cloud" website="https://acme.example" />);

    // Give any stray effect a chance to run, then assert nothing was enqueued.
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).not.toHaveBeenCalled();
  });

  it("bundled hit: a pack brand never enqueues even with the toggle ON", async () => {
    await setup({ liveLogoFetch: true });
    // netflix.com IS in the pack → kind:"bundled", not a letter miss.
    render(<LogoTile name="Netflix" website="https://www.netflix.com/browse" />);

    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).not.toHaveBeenCalled();
  });

  it("cached hit: a domain already in the cache never enqueues (already resolved)", async () => {
    await setup({
      liveLogoFetch: true,
      cache: { "acme.example": "data:image/png;base64,iVBORw0KGgo=" },
    });
    // acme.example is a pack MISS but a cache HIT → kind:"cached", no enqueue.
    render(<LogoTile name="Acme" website="https://acme.example/app" />);

    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).not.toHaveBeenCalled();
  });

  it("empty / unparseable website: never enqueues (domain is null)", async () => {
    await setup({ liveLogoFetch: true });
    const { rerender } = render(<LogoTile name="No Site" website="" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).not.toHaveBeenCalled();

    // A junk, non-URL website also yields a null domain → still no enqueue.
    rerender(<LogoTile name="Junk" website="not a url" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).not.toHaveBeenCalled();
  });

  it("re-render stability: N re-renders of the same row enqueue at most once", async () => {
    await setup({ liveLogoFetch: true });
    const { rerender } = render(
      <LogoTile name="Acme Cloud" website="https://acme.example" />,
    );
    await waitFor(() => expect(fake.enqueueSpy).toHaveBeenCalledTimes(1));

    // Re-render the SAME row (same domain + toggle) several times with an
    // unrelated prop change — the dedup keeps the effect from re-firing.
    for (let i = 0; i < 5; i++) {
      rerender(
        <LogoTile name="Acme Cloud" website="https://acme.example" className={`c${i}`} />,
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("toggle flips ON at runtime: a visible missing row enqueues once on the change", async () => {
    // Start with the toggle OFF: the visible miss must NOT enqueue.
    await setup({ liveLogoFetch: false });
    render(<LogoTile name="Acme Cloud" website="https://acme.example" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).not.toHaveBeenCalled();

    // The user enables live logos: the fake serves the new settings and the
    // onDataChanged broadcast reloads the settings store → the effect re-runs on
    // the toggle change and enqueues exactly once.
    fake.state.settings = settingsWith(true);
    fake.emitDataChanged();

    await waitFor(() => expect(fake.enqueueSpy).toHaveBeenCalledTimes(1));
    expect(fake.enqueueSpy).toHaveBeenCalledWith("acme.example");
  });

  it("result swaps in: once the fetched logo is cached, the row does not re-enqueue", async () => {
    await setup({ liveLogoFetch: true });
    render(<LogoTile name="Acme Cloud" website="https://acme.example" />);
    await waitFor(() => expect(fake.enqueueSpy).toHaveBeenCalledTimes(1));

    // The EnrichmentService persisted the blob and broadcast evt:dataChanged; the
    // cache now resolves this domain → the row re-resolves to kind:"cached" and
    // the effect (keyed on [domain, toggle], neither changed) does NOT re-fire.
    fake.state.cache = { "acme.example": "data:image/png;base64,iVBORw0KGgo=" };
    fake.emitDataChanged();
    await waitFor(() =>
      expect(logoCacheStore.getSnapshot().data["acme.example"]).toBeTruthy(),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(fake.enqueueSpy).toHaveBeenCalledTimes(1);
  });
});
