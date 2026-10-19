import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";

import type { OnlineSettingsV2, SettingsV2 } from "core/models/settings";
import type { AppError, IpcResult } from "shared/types";

import {
  createAppContext,
  runMigrationBarrier,
  type AppContext,
} from "./appWiring";
import { CH } from "./ipc/channels";
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
} from "./ipc/handlers";
import { buildCsp } from "./net/csp";
import { runChooseDataFolder } from "./services/dialog";
import { EnrichmentService } from "./services/enrichment";
import { NotificationService } from "./services/notificationService";
import { Scheduler } from "./services/scheduler";
import { destroyTray, ensureTray } from "./services/tray";

const isDev = !app.isPackaged && Boolean(process.env["ELECTRON_RENDERER_URL"]);

/**
 * Silence Chromium's own phone-home surfaces at init (AD-7).
 *
 * Subby's gated-network boundary (`electron/net/`) is only meaningful if the
 * browser engine underneath it cannot leak independently of the gate. Chromium
 * ships several background network surfaces; the two reachable via command-line
 * switches are disabled here, BEFORE the `ready` event (switches set after
 * `ready` are ignored):
 *   - `disable-component-update` — stops the component updater that fetches
 *     Widevine/CRL/etc. bundles from Google in the background.
 *   - `disable-domain-reliability` — stops Chrome's Domain Reliability service
 *     from uploading network-error beacons to Google.
 *
 * The spellcheck dictionary download (also a Google CDN fetch) is additionally
 * disabled per-window via `webPreferences.spellcheck: false`, and belt-and-
 * braces at the session level inside {@link disablePhoneHomeSurfacesOnReady}.
 * The renderer stays sandboxed with no Node integration (unchanged), and no
 * auto-updater is added (AD-30) — an updater would itself be a phone-home
 * surface against the telemetry line.
 */
function disablePhoneHomeSwitches(): void {
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("disable-domain-reliability");
}
// Must run before `ready`: command-line switches set after the app is ready are
// not honored. Called at module load, which is before `app.whenReady` resolves.
disablePhoneHomeSwitches();

/**
 * Session-level phone-home silence applied once the app is ready (AD-7).
 *
 * `setSpellCheckerDictionaryDownloadURL("")` points the Hunspell dictionary
 * downloader at an empty URL so no dictionary is ever fetched from the Google
 * CDN even if the spellchecker were somehow enabled (it is already off per
 * window). No-op on macOS (the OS spellchecker is used), harmless elsewhere, and
 * wrapped so a platform quirk can never throw into the launch sequence.
 */
function disablePhoneHomeSurfacesOnReady(): void {
  if (isDev) return;
  try {
    session.defaultSession.setSpellCheckerDictionaryDownloadURL("");
  } catch {
    // Defensive: never let a session-API quirk abort launch (AD-28).
  }
}

/**
 * Delay (ms) before the deferred scheduler first-tick. Kept small but non-zero
 * so the renderer can paint first, protecting cold-start perceived performance
 * (Req 21.1).
 */
const SCHEDULER_FIRST_TICK_DELAY_MS = 3000;

/**
 * The live main window, or `null` when none is open. Handlers reach the current
 * window through the {@link registerIpcHandlers} `getWindow` accessor so
 * broadcasts always target the latest window.
 */
let mainWindow: BrowserWindow | null = null;

/** The assembled application context (storage + services); built on ready. */
let appContext: AppContext | null = null;

/**
 * The reminder scheduler (Notification_Service + periodic evaluation). Lives in
 * the main process so reminders fire independently of the renderer/window
 * (Req 13.3). Constructed on ready, started at the deferred first-tick, and
 * stopped on quit.
 */
let scheduler: Scheduler | null = null;

/**
 * The logo-enrichment service (Story 8.4). Lives in the main process and owns a
 * single serial queue; `enrich:enqueue` returns immediately while the worker
 * fetches through the gated gateway, persists to the `logos/` blob cache, and
 * broadcasts a coalesced `evt:dataChanged`. Constructed inside the app context
 * post-barrier, DRAINED only after `ready-to-show` (AD-28), and stopped on quit.
 */
let enrichment: EnrichmentService | null = null;

/**
 * Set once a genuine application quit is underway (`before-quit`, or the tray
 * "Quit" action). While true the window `close` handler stops intercepting so
 * the app can actually exit instead of hiding to the tray (Req 13.3 vs 13.4).
 */
let isQuitting = false;

/**
 * Cached `settings.trayMode`, refreshed from disk whenever the window close is
 * evaluated and on window focus. Used by the synchronous `window-all-closed`
 * handler (which cannot await a settings read) to decide whether to quit.
 */
let trayModeCache = false;

/**
 * Cached `settings.online` toggles, refreshed from disk post-barrier and on
 * every `settings:update` success. The dynamic production CSP
 * ({@link applyProductionCsp}) reads this cache SYNCHRONOUSLY inside
 * `onHeadersReceived` (which cannot await a settings read) so enabling an online
 * feature later (Story 8.2) updates `connect-src` without a second header
 * registration. Seeded all-false so the pre-barrier CSP is byte-identical to the
 * fully-offline 1.0 policy (`connect-src 'self'`). Mirrors {@link trayModeCache}
 * / {@link refreshTrayMode}.
 */
let onlineSettingsCache: OnlineSettingsV2 = {
  liveLogoFetch: false,
  fxRefresh: false,
};

/** Accessor passed to the IPC layer for renderer broadcasts. */
const getWindow = (): BrowserWindow | null => mainWindow;

/**
 * Re-read `settings.trayMode` from the live services and refresh
 * {@link trayModeCache}. Returns the fresh value so the (async) window `close`
 * handler can make an authoritative Tray_Mode decision even when the user
 * toggled the setting moments earlier. Falls back to the cached value if the
 * context is not yet built or the read fails.
 */
async function refreshTrayMode(): Promise<boolean> {
  if (appContext === null) return trayModeCache;
  try {
    const settings = await appContext.services.getSettings();
    trayModeCache = settings.trayMode;
  } catch {
    // Keep the last known value on a transient read failure.
  }
  return trayModeCache;
}

/**
 * Re-read `settings.online` from the live services and refresh
 * {@link onlineSettingsCache} so the synchronous `onHeadersReceived` CSP builder
 * sees the current toggles. Called once post-barrier (seed) and after every
 * `settings:update` success (so a feature enabled at runtime widens the CSP on
 * the next request without a second header registration). Keeps the last known
 * value on a transient read failure or before the context is built. (AD-6/AD-7.)
 */
async function refreshOnlineSettings(): Promise<void> {
  if (appContext === null) return;
  try {
    const settings = await appContext.services.getSettings();
    onlineSettingsCache = settings.online;
  } catch {
    // Keep the last known value on a transient read failure.
  }
}

/**
 * React to a successful `settings:update` (Story 8.1 + 8.6). Refreshes the
 * online-toggle cache for the dynamic CSP (AD-7), then — if `fxRefresh` is now on
 * — triggers one FX rate refresh (Story 8.6). This REUSES the existing
 * settings-mutation seam, so there is NO second timer subsystem: the toggle-on
 * flip is one of the only two FX triggers (the other is launch). The FX job
 * itself self-gates on the toggle and the ≤24h cadence, so a flip-off-then-on
 * burst never beats the network cap. Fire-and-forget; a throw is swallowed by the
 * IPC-layer guard around this hook so it never fails the IPC call.
 */
async function onSettingsMutated(): Promise<void> {
  // Capture the PREVIOUS online toggles before the cache is refreshed, so we can
  // act on a true off→on TRANSITION rather than on every settings save.
  const prev = onlineSettingsCache;
  await refreshOnlineSettings();
  const next = onlineSettingsCache;

  // The cache now reflects the just-persisted toggles. Trigger an FX refresh only
  // when fxRefresh is on; the job no-ops otherwise and self-caps at ≤1×/24h.
  if (next.fxRefresh && appContext !== null) {
    appContext.services.enqueueFxRefresh();
  }
  // Story 9.1: backfill logos for EVERY existing subscription (not just rendered
  // rows) ONLY on the `liveLogoFetch` false→true TRANSITION — the story is about
  // the ENABLE event, not every subsequent settings save. Gating on the transition
  // (not merely "on") avoids a spurious full `listSubscriptions` disk read + N
  // enqueues (and the retry of every un-cached/failed domain) on an unrelated
  // change like theme or currency (PR #56 review). An already-enabled relaunch is
  // covered by the launch backfill in `startDeferredEnrichmentDrain`; a manual
  // re-pass is Sync Now. Fire-and-forget off the hot path (AD-9).
  if (!prev.liveLogoFetch && next.liveLogoFetch && appContext !== null && enrichment !== null) {
    void enrichment.backfillAllLogos();
  }
}

/** Begin a genuine quit: stop intercepting window close, then quit the app. */
function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

function applyProductionCsp(): void {
  // In production the renderer loads from file://; enforce the strict CSP at
  // the network layer as defense-in-depth alongside the index.html meta tag.
  if (isDev) return;
  // SINGLE registration. The callback is synchronous and cannot await a settings
  // read, so it builds the policy from the cached `settings.online` toggles
  // ({@link onlineSettingsCache}, refreshed post-barrier and on every
  // `settings:update`). `buildCsp` derives `connect-src` from the SAME
  // `allowedHosts` resolver the socket-level gate uses, so the CSP and the gate
  // can never allow different hosts (AD-6/AD-7). With both toggles off this is
  // byte-identical to the fully-offline 1.0 CSP (`connect-src 'self'`).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [buildCsp(onlineSettingsCache)],
      },
    });
  });
}

/**
 * Load persisted settings on startup and honor a `dataFolder` override so
 * storage targets the right place from the very first operation (Req 15.4).
 *
 * Bootstrap order matters: the context is first built against the default
 * `userData` directory, the persisted settings are read from there, and if a
 * `dataFolder` override is present the active folder is switched before any
 * window or handler touches the data. {@link createAppContext} could take the
 * override up front, but settings live inside `settings.json`, so the override
 * can only be known after the first read.
 */
async function bootstrapContext(): Promise<AppContext> {
  // `getWindow` is a LAZY closure (`() => mainWindow`), so passing it before the
  // window exists is safe — the EnrichmentService only reads it when a job
  // completes (long after launch), to broadcast a coalesced `evt:dataChanged`
  // through the SAME accessor the IPC handlers use (AD-8). The default data
  // folder / cloud-path predicate are kept (the override is applied below once
  // settings are read).
  const context = createAppContext(
    app.getPath("userData"),
    null,
    undefined,
    getWindow,
  );
  const settings = await context.services.getSettings();
  if (settings.dataFolder) {
    // Switch subsequent data file operations to the persisted folder (Req 15.3/15.4).
    await context.services.setDataFolder(settings.dataFolder);
  }
  return context;
}

/**
 * Surface a launch-time system fault as `evt:error` without crashing the process
 * (AD-28). Main-process launch work (bootstrap, the migration barrier) must
 * never throw into the event loop; a genuine fault here is caught, logged as a
 * structured non-telemetry diagnostic, and broadcast to whatever window exists
 * so the renderer can show a global error — not swallowed, and not escalated to
 * an unhandled rejection.
 */
function surfaceLaunchFault(stage: string, err: unknown): void {
  const message =
    err instanceof Error ? err.message : "A startup error occurred.";
  // Structured, non-telemetry diagnostic (AD-28). Stays local to the console.
  console.error(`[subby] launch fault during "${stage}": ${message}`);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    const error: AppError = { code: "unknown", message };
    win.webContents.send(CH.events.error, error);
  }
}

/**
 * Register the dialog-driven `settings:chooseDataFolder` channel (Req 15.3).
 *
 * This closes the gap that the core IPC handlers (task 13.2) intentionally
 * deferred: that module registers every channel EXCEPT the native-dialog ones.
 * The folder picker lives here so it can be composed with the live window and
 * the assembled services.
 *
 * Returns an {@link IpcResult}: `data: null` when the user cancels (a no-op,
 * not an error), otherwise the merged {@link Settings} after the switch. A
 * successful switch broadcasts `evt:dataChanged` so every view refreshes.
 */
function registerDialogChannels(context: AppContext): void {
  // Duplicate-safe: clear any prior handler before re-registering.
  ipcMain.removeHandler(CH.settings.chooseDataFolder);
  ipcMain.handle(
    CH.settings.chooseDataFolder,
    async (): Promise<IpcResult<SettingsV2 | null>> => {
      const win = getWindow();
      if (win === null || win.isDestroyed()) {
        return { ok: true, data: null };
      }
      try {
        const result = await runChooseDataFolder(win, context.services);
        if (result.cancelled) {
          return { ok: true, data: null };
        }
        // The data folder switch changes what the renderer should display.
        if (!win.isDestroyed()) {
          win.webContents.send(CH.events.dataChanged);
        }
        return { ok: true, data: result.settings };
      } catch (err) {
        const error: AppError = {
          code: "unknown",
          message:
            err instanceof Error
              ? err.message
              : "Failed to choose a data folder.",
        };
        return { ok: false, error };
      }
    },
  );
}

/** Tear down the dialog-driven channel registered by {@link registerDialogChannels}. */
function unregisterDialogChannels(): void {
  ipcMain.removeHandler(CH.settings.chooseDataFolder);
}

/**
 * Deferred scheduler first-tick (Req 21.1, 13.1).
 *
 * Starts the real {@link Scheduler} slightly after first paint so reminder
 * evaluation does not compete with cold-start work (Req 21.1). {@link Scheduler.start}
 * runs the launch CATCH-UP pass (Story 4.3) FIRST — firing reminders missed
 * while the app was closed, within the 24h look-back anchored on `lastRunAt` —
 * then an immediate launch evaluation, then keeps a periodic timer ticking for
 * the process lifetime, so reminders fire regardless of window visibility when
 * Tray_Mode is on (Req 13.3). The catch-up therefore runs here, AFTER the
 * migration barrier (the scheduler is constructed and started post-barrier in
 * the `whenReady` sequence — AD-28), exactly once per launch. Safe to invoke
 * more than once: `start()` is idempotent and will not duplicate the interval.
 */
function scheduleDeferredSchedulerFirstTick(): void {
  setTimeout(() => {
    if (scheduler === null) return;
    void scheduler.start();
  }, SCHEDULER_FIRST_TICK_DELAY_MS);
}

/**
 * Permit the EnrichmentService to drain its queue (Story 8.4, AD-28).
 *
 * Called from the window's `ready-to-show` so a logo fetch never competes with
 * first paint and the window is painted before any `evt:dataChanged` swap-in.
 * Combined with the migration barrier (the service is constructed post-barrier
 * in the `whenReady` sequence), this is the AD-28 "drain only after barrier AND
 * ready-to-show" ordering. `start()` is idempotent and a no-op before the
 * service exists or after it is stopped.
 */
function startDeferredEnrichmentDrain(): void {
  if (enrichment === null) return;
  enrichment.start();
  // Launch FX refresh trigger (Story 8.6): if `fxRefresh` is on at launch, request
  // ONE refresh now that the service may drain (post-barrier + ready-to-show,
  // AD-28). This is one of the only two FX triggers (the other is the toggle-on
  // flip via `onSettingsMutated`) — NO second timer. The job self-gates on the
  // ≤24h cadence, so a relaunch within 24h of a successful fetch hits no network.
  // `onlineSettingsCache` was seeded post-barrier, so it reflects the real toggle.
  if (onlineSettingsCache.fxRefresh) {
    enrichment.enqueueFxRefresh();
  }
  // Launch logo backfill (Story 9.1 + PR #56 review): if `liveLogoFetch` is ALREADY
  // on at launch, backfill all existing subscriptions once now that the service may
  // drain (post-barrier + ready-to-show, AD-28). This covers the already-enabled
  // relaunch case the `onSettingsMutated` off→on transition does NOT — and retries
  // any logo a prior session failed to fetch (an un-cached domain has no blob, so
  // the never-refetch `has()` lets it through again). De-dup + `has()` + the gateway
  // gate keep it cheap and gated; fire-and-forget, off first paint.
  if (onlineSettingsCache.liveLogoFetch) {
    void enrichment.backfillAllLogos();
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: "Subby",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      // Security posture (Req 2.5): renderer is fully isolated and sandboxed
      // and has no Node integration. The only bridge is the preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Phone-home silence (AD-7): disable Chromium's spellchecker so it never
      // downloads a Hunspell dictionary from Google at first focus of a text
      // field. One of the few phone-home surfaces that is a per-window
      // `webPreferences` flag rather than a global command-line switch.
      spellcheck: false,
    },
  });

  mainWindow = window;

  // Present the window only once content is ready to protect cold-start
  // perceived performance (Req 21.1), then defer the scheduler first-tick so
  // reminder evaluation does not compete with first paint.
  window.once("ready-to-show", () => {
    window.show();
    scheduleDeferredSchedulerFirstTick();
    // Permit the enrichment worker to drain now that the window is painted and
    // the barrier has passed (AD-28). The queue is empty until Story 8.5 wires
    // the production auto-enqueue trigger, so this is dormant for real users.
    startDeferredEnrichmentDrain();
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Tray_Mode behavior (Req 13.3, 13.4). The `close` event is intercepted so we
  // can decide on the freshest setting: ON → hide to the tray (keep the
  // scheduler running, reminders keep firing); OFF → let the window close/quit
  // normally. The decision needs an async settings read, so we always hold the
  // close first, then either hide or force-destroy.
  window.on("close", (event) => {
    // A genuine quit (before-quit / tray "Quit") must be allowed through.
    if (isQuitting) return;

    // Hold the close until we know the current Tray_Mode.
    event.preventDefault();
    void (async () => {
      const trayMode = await refreshTrayMode();
      if (window.isDestroyed()) return;
      if (trayMode) {
        // Req 13.3: keep running in the tray instead of closing.
        ensureTray(getWindow, requestQuit);
        window.hide();
      } else {
        // Req 13.4: no tray — close for real (destroy bypasses this handler and
        // triggers `window-all-closed`, which quits on non-macOS).
        window.destroy();
      }
    })();
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (isDev && devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  // Silence Chromium's own phone-home surfaces at init before the window loads
  // (AD-7): the session-level dictionary-download override here, the
  // command-line switches already set at module load, and `spellcheck: false`
  // on the window below. Nothing may leak underneath the gated-network boundary.
  disablePhoneHomeSurfacesOnReady();
  applyProductionCsp();

  // Ordered launch sequence with a migration barrier (AD-28). The steps run in a
  // fixed order and the barrier (step 2) is a HARD gate: no scheduler and no IPC
  // handler reads user data until any pending migration has completed (or safely
  // no-opped at the live current=1). The whole sequence is wrapped so a genuine
  // system fault degrades to `evt:error` and never throws into the event loop.
  //
  // `stage` is advanced explicitly at each step so a caught fault is labeled by
  // the step that actually failed — never inferred from a module-level singleton
  // (which a dev hot-reload re-init could leave non-null and mislabel).
  let stage = "bootstrap";
  try {
    // (1) Bootstrap: build services + load/apply persisted settings and the
    //     data-folder override before any window or handler touches data.
    appContext = await bootstrapContext();

    // (2) Migration BARRIER: bring every user-data file to the current schema
    //     version before anything reads it. Inert (no-op pass) at current=1;
    //     load-bearing once Epic 3 flips CURRENT_VERSION. Nothing below runs
    //     until this resolves. A migration fault propagates to the catch below,
    //     so the scheduler is never constructed/started on un-migrated state.
    stage = "barrier";
    await runMigrationBarrier(appContext.storage);

    // (3) Scheduler: constructed now, STARTED later at the deferred first-tick
    //     (post `ready-to-show`). Construction-to-start sits entirely after the
    //     barrier so a catch-up/periodic read can only ever see migrated data.
    stage = "scheduler";
    scheduler = new Scheduler({
      // `AppServices` structurally satisfies `SchedulerServices`, including the
      // ledger-backed dedupe methods (`readReminderLedger` lock-free /
      // `writeReminderLedger` under `lock("reminderLedger")`) added for 4.2.
      services: appContext.services,
      notifier: new NotificationService(),
      // `offsetMinutes` is omitted: the SchedulerOptions default is already the
      // live OS local offset (`-new Date().getTimezoneOffset()`), so the offset
      // convention (AD-18) has a single source rather than a duplicated literal.
    });

    // Capture the EnrichmentService. It was CONSTRUCTED during bootstrap (step 1,
    // inside `createAppContext`) — construction itself touches no user data, so
    // its timing is not load-bearing. The AD-28 safety comes from the START gate,
    // not construction order: it is only permitted to DRAIN at `ready-to-show`
    // via `startDeferredEnrichmentDrain`, which runs after this barrier has
    // passed — so a job can only ever see migrated state.
    enrichment = appContext.enrichment;

    // Seed the Tray_Mode cache from (now barrier-passed) persisted settings so
    // the synchronous `window-all-closed` handler has a sane initial value
    // (Req 13.3/13.4). This reads user data, so it must follow the barrier.
    await refreshTrayMode();

    // Seed the online-toggle cache from (now barrier-passed) persisted settings
    // so the synchronous `onHeadersReceived` CSP builder reflects the user's
    // actual toggles from the first request (AD-7). Reads user data → after the
    // barrier. For a fresh/offline user this is all-false, so `connect-src`
    // stays `'self'`.
    await refreshOnlineSettings();

    // Register IPC handlers once over the assembled services, after the barrier
    // so a handler read never observes un-migrated data. Tearing down first makes
    // registration idempotent and avoids duplicate-handler errors on a dev
    // hot-reload re-init.
    stage = "handlers";
    unregisterIpcHandlers();
    unregisterDialogChannels();
    // The `onSettingsMutated` hook refreshes the online-toggle cache whenever a
    // `settings:update` succeeds, so enabling an online feature at runtime
    // (Story 8.2) widens the CSP on the next request — no second
    // `onHeadersReceived` registration (AD-7). It ALSO triggers an FX refresh when
    // `fxRefresh` is now on (Story 8.6) — reusing the SAME settings-mutation seam,
    // no second timer. Fire-and-forget: the refresh is a lock-free read, the CSP
    // only needs to be current by the next request, and the FX job self-gates on
    // the toggle + the ≤24h cadence (so a flip-off-then-on burst is still ≤1×/24h).
    registerIpcHandlers(appContext.services, getWindow, () => {
      void onSettingsMutated();
    });
    registerDialogChannels(appContext);

    // (4) Window: on `ready-to-show` it presents and defers the scheduler
    //     first-tick (that deferral still sits after this barrier — the barrier
    //     gates construction-to-start, the deferral gates first-tick timing).
    stage = "window";
    createWindow();
  } catch (err) {
    // A bootstrap/barrier fault: degrade, do not crash (AD-28). The scheduler
    // was not started on bad state, and because the fault occurred before
    // handler registration there are NO IPC handlers — so the window opened here
    // is an ERROR-SURFACE ONLY: it loads to display the `evt:error` toast and has
    // no app functionality until the user relaunches. (We do not stand up a
    // degraded-handler shim: with bootstrap failed there are no services to
    // serve, so a shim would hang the same renderer invokes it pretends to fix.)
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        createWindow();
      } catch (windowErr) {
        surfaceLaunchFault("createWindow", windowErr);
      }
    }
    // Deliver the fault to the renderer EXACTLY ONCE. If a window already exists
    // and is visible (fault late in launch), surface immediately. Otherwise the
    // window is not yet painted (just created above, or still loading), so defer
    // to its `ready-to-show` — surfacing now would send to a renderer that can't
    // yet show a toast. Never both: a visible window skips the deferral.
    const win = getWindow();
    if (win && !win.isDestroyed() && win.isVisible()) {
      surfaceLaunchFault(stage, err);
    } else if (win && !win.isDestroyed()) {
      win.once("ready-to-show", () => surfaceLaunchFault(stage, err));
    } else {
      // No window at all (createWindow itself failed above): log the fault so it
      // is not swallowed, even though no renderer can receive it.
      surfaceLaunchFault(stage, err);
    }
  }
});

// `activate` (macOS dock re-click) must survive a degraded launch: it is
// registered at top level, OUTSIDE the launch try/catch, so a caught fault never
// leaves the dock icon unable to recreate the window. Guarded to recreate only
// when no window exists.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  // When Tray_Mode is ON the window hides (it is never destroyed) so this event
  // does not fire while running in the tray; reaching here means a genuine
  // close. Quit on non-macOS only when Tray_Mode is OFF so reminders keep
  // firing in the tray when it is ON (Req 13.3, 13.4).
  if (trayModeCache) return;
  if (process.platform !== "darwin") app.quit();
});

// Mark a genuine quit so the window `close` handler stops hiding to the tray
// and lets the app actually exit (Req 13.3 vs 13.4).
app.on("before-quit", () => {
  isQuitting = true;
});

// Tear down main-process resources on quit.
app.on("quit", () => {
  scheduler?.stop();
  enrichment?.stop();
  destroyTray();
});
