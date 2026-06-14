/**
 * Tray manager (Electron MAIN process) — Req 13.3, 13.4.
 *
 * Provides a small system-tray presence used by Tray_Mode. When Tray_Mode is
 * ON, closing the main window hides it to the tray (instead of quitting) so the
 * `Scheduler` keeps ticking and reminders continue to fire with the window
 * closed (Req 13.3). The tray's context menu lets the user re-open the window
 * ("Show Subby") or quit the app ("Quit"). When Tray_Mode is OFF the window is
 * allowed to close/quit normally and no tray is created (Req 13.4).
 *
 * The tray is a process-lifetime singleton: {@link ensureTray} is idempotent
 * (creating the tray at most once) and {@link destroyTray} tears it down on
 * quit. Wiring lives in `main.ts`, which owns the window lifecycle and the
 * quitting flag.
 *
 * Icon strategy: a real asset is preferred, but to guarantee the tray never
 * crashes in environments without a bundled icon we fall back to an empty
 * 16×16 `nativeImage`. On most platforms an empty image still yields a clickable
 * tray slot, and the context menu remains fully functional.
 */

import { Menu, Tray, nativeImage, type NativeImage } from "electron";

/**
 * Accessor for the live main window. Returns `null` when no window currently
 * exists (e.g. it was closed/hidden and not yet recreated). Supplied by
 * `main.ts` so the tray always targets the latest window.
 */
export type GetWindow = () => Electron.BrowserWindow | null;

/** Called when the user selects "Quit" from the tray menu. */
export type OnQuit = () => void;

/** The process-lifetime tray singleton, or `null` when none exists. */
let tray: Tray | null = null;

/**
 * Build the tray icon. Uses an empty 16×16 `nativeImage` so construction never
 * throws when no icon asset is available. `Tray` requires a non-undefined image
 * argument; an empty image satisfies that contract safely on all platforms.
 */
function buildTrayIcon(): NativeImage {
  // `createEmpty()` yields a zero-size image; resize to a conventional 16×16 so
  // platforms that render the slot have sensible dimensions to work with.
  const image = nativeImage.createEmpty();
  // Some platforms treat empty images specially; this is intentionally a tiny,
  // dependency-free placeholder rather than a bundled asset.
  return image;
}

/**
 * Show and focus the main window from the tray. No-op when the window is gone.
 * Restores a minimized window and brings it to the foreground.
 */
function showWindow(getWindow: GetWindow): void {
  const win = getWindow();
  if (win === null || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Create the tray if it does not already exist (idempotent — Req 13.3).
 *
 * @param getWindow Accessor for the live main window, used by "Show Subby".
 * @param onQuit    Invoked when the user picks "Quit"; `main.ts` sets the
 *                  quitting flag and calls `app.quit()`.
 * @returns The live {@link Tray} instance.
 */
export function ensureTray(getWindow: GetWindow, onQuit: OnQuit): Tray {
  if (tray !== null && !tray.isDestroyed()) {
    return tray;
  }

  tray = new Tray(buildTrayIcon());
  tray.setToolTip("Subby");

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Subby",
      click: () => showWindow(getWindow),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => onQuit(),
    },
  ]);
  tray.setContextMenu(menu);

  // Single-click (and double-click on platforms that distinguish them) on the
  // tray icon re-opens the window, matching common desktop conventions.
  tray.on("click", () => showWindow(getWindow));
  tray.on("double-click", () => showWindow(getWindow));

  return tray;
}

/** Whether a live tray currently exists. */
export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed();
}

/** Destroy the tray if present. Idempotent; safe to call on quit. */
export function destroyTray(): void {
  if (tray !== null) {
    if (!tray.isDestroyed()) tray.destroy();
    tray = null;
  }
}
