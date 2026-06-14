import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";

import type { Settings } from "core/models/settings";
import type { AppError, IpcResult } from "shared/types";

import { createAppContext, type AppContext } from "./appWiring";
import { CH } from "./ipc/channels";
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
} from "./ipc/handlers";
import { runChooseDataFolder } from "./services/dialog";
import { NotificationService } from "./services/notificationService";
import { Scheduler } from "./services/scheduler";
import { destroyTray, ensureTray } from "./services/tray";

/** Strict production CSP: same-origin only, zero remote origins (Req 20.2). */
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

const isDev = !app.isPackaged && Boolean(process.env["ELECTRON_RENDERER_URL"]);

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

/** Begin a genuine quit: stop intercepting window close, then quit the app. */
function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

function applyProductionCsp(): void {
  // In production the renderer loads from file://; enforce the strict CSP at
  // the network layer as defense-in-depth alongside the index.html meta tag.
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [PROD_CSP],
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
  const context = createAppContext(app.getPath("userData"));
  const settings = await context.services.getSettings();
  if (settings.dataFolder) {
    // Switch subsequent data file operations to the persisted folder (Req 15.3/15.4).
    await context.services.setDataFolder(settings.dataFolder);
  }
  return context;
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
    async (): Promise<IpcResult<Settings | null>> => {
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
 * runs an immediate launch evaluation and then keeps a periodic timer ticking
 * for the process lifetime, so reminders fire regardless of window visibility
 * when Tray_Mode is on (Req 13.3). Safe to invoke more than once: `start()` is
 * idempotent and will not duplicate the interval.
 */
function scheduleDeferredSchedulerFirstTick(): void {
  setTimeout(() => {
    if (scheduler === null) return;
    void scheduler.start();
  }, SCHEDULER_FIRST_TICK_DELAY_MS);
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
    },
  });

  mainWindow = window;

  // Present the window only once content is ready to protect cold-start
  // perceived performance (Req 21.1), then defer the scheduler first-tick so
  // reminder evaluation does not compete with first paint.
  window.once("ready-to-show", () => {
    window.show();
    scheduleDeferredSchedulerFirstTick();
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
  applyProductionCsp();

  // Build services and load+apply persisted settings before any window or
  // handler touches data (Req 15.4).
  appContext = await bootstrapContext();

  // Seed the Tray_Mode cache from persisted settings so the synchronous
  // `window-all-closed` handler has a sane initial value (Req 13.3/13.4).
  await refreshTrayMode();

  // Construct the reminder scheduler now (started later, deferred after paint).
  // It lives in the main process so reminders fire regardless of window
  // visibility when Tray_Mode is on (Req 13.1, 13.2, 13.3).
  scheduler = new Scheduler({
    services: appContext.services,
    notifier: new NotificationService(),
  });

  // Register IPC handlers once over the assembled services. Tearing down first
  // makes registration idempotent and avoids duplicate-handler errors if the
  // app is ever re-initialized in the same process (e.g. dev hot-reload).
  unregisterIpcHandlers();
  unregisterDialogChannels();
  registerIpcHandlers(appContext.services, getWindow);
  registerDialogChannels(appContext);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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
  destroyTray();
});
