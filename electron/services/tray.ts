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
 * Icon strategy: a real, bundled monochrome PNG (`resources/trayTemplate.png`)
 * is the primary icon. It ships OUTSIDE the asar via the same `extraResources`
 * mapping the FX snapshot uses, so it resolves through the shared
 * {@link resolveResourceDir} seam (dev → repo `resources/`, packaged →
 * `process.resourcesPath/resources`) with ordinary `node:fs`-backed
 * `nativeImage.createFromPath` — no network, no asar shim (AD-24, AD-30).
 *
 * On macOS the icon is marked a TEMPLATE image (`setTemplateImage(true)`; the
 * `…Template` filename is the matching Electron convention) so macOS
 * auto-inverts the monochrome glyph for light/dark menu bars. Windows/Linux
 * render the same PNG as-is — one asset, correct on all three.
 *
 * Crash-safety is the governing constraint: `new Tray(...)` can throw on some
 * platforms if handed a bad image, and the app must launch even if the asset is
 * somehow absent (a dev checkout before the PNG landed, a packaging slip) or
 * unreadable/corrupt. So {@link loadTrayImage} ALWAYS returns a valid
 * `NativeImage` — the real one when it reads as non-empty, otherwise an empty
 * `nativeImage` fallback — and NEVER throws. An empty image still yields a
 * clickable tray slot on most platforms, and the context menu stays functional.
 */

import { app, Menu, Tray, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";

import { resolveResourceDir } from "../storage/resourceReader";

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
 * The bundled tray-icon resource file name. The `…Template` suffix is the
 * Electron convention that signals a macOS template image; the file lives under
 * the shared `resources/` directory (see {@link resolveResourceDir}).
 */
export const TRAY_ICON_RESOURCE = "trayTemplate.png" as const;

/**
 * Load a tray `NativeImage` from a filesystem path, crash-safely.
 *
 * Pure-ish and exported so the loader can be unit-tested with a real path (the
 * committed asset → a non-empty image) and a bogus path (→ the empty fallback,
 * no throw) WITHOUT constructing a real {@link Tray} (which needs a running
 * app). The resource-dir resolution and singleton wiring stay in
 * {@link buildTrayIcon}/{@link ensureTray}; this helper is just
 * `path → NativeImage with fallback`.
 *
 * Contract: ALWAYS returns a valid `NativeImage` and NEVER throws.
 *   - A readable file → the loaded image. On macOS it is marked a template
 *     image (`setTemplateImage(true)`) so it adapts to light/dark menu bars.
 *   - A missing / unreadable / corrupt path (`createFromPath` yields an empty
 *     image, or throws) → the empty `nativeImage` fallback, so a subsequent
 *     `new Tray(...)` still constructs safely on every platform.
 *
 * @param iconPath Absolute path to the tray icon PNG.
 */
export function loadTrayImage(iconPath: string): NativeImage {
  try {
    const img = nativeImage.createFromPath(iconPath);
    // `createFromPath` does not throw on a missing/unreadable file — it returns
    // an empty image. Treat empty (missing or corrupt) as "no icon" and fall
    // back, so `new Tray(...)` is never handed a bad image.
    if (img.isEmpty()) {
      return nativeImage.createEmpty();
    }
    // macOS auto-inverts a monochrome template image for light/dark menu bars.
    // No-op visually on Windows/Linux, which render the PNG as-is.
    if (process.platform === "darwin") {
      img.setTemplateImage(true);
    }
    return img;
  } catch {
    // Any unexpected failure (e.g. a platform quirk) degrades to the empty
    // fallback rather than crashing tray construction.
    return nativeImage.createEmpty();
  }
}

/**
 * Build the tray icon from the bundled asset, crash-safely.
 *
 * Resolves the shared read-only `resources/` directory via the same
 * {@link resolveResourceDir} seam the FX snapshot uses (dev → repo `resources/`,
 * packaged → `process.resourcesPath/resources`), then loads
 * `resources/trayTemplate.png` through {@link loadTrayImage}. The whole resolve
 * + read is wrapped so a resolution failure (e.g. an Electron global unavailable
 * in some edge) still degrades to the empty `nativeImage` fallback — `new Tray`
 * always receives a valid, non-undefined image.
 *
 * Exported so the resolve+fallback path is unit-testable without constructing a
 * real {@link Tray}; `ensureTray` is its only production caller.
 */
export function buildTrayIcon(): NativeImage {
  try {
    const dir = resolveResourceDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
    return loadTrayImage(join(dir, TRAY_ICON_RESOURCE));
  } catch {
    // Resolver/global access failed — never let the tray fail to construct.
    return nativeImage.createEmpty();
  }
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
