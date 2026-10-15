/**
 * Preload context bridge (task 13.3, Req 2.4, 2.5).
 *
 * The preload is the ONLY renderer ↔ main bridge. It exposes a single typed
 * facade at `window.subby` ({@link SubbyApi}) over the centralized IPC channels
 * in {@link CH}. Every request/response method forwards to `ipcRenderer.invoke`
 * and resolves to a discriminated {@link IpcResult}; the two event hooks wrap
 * `ipcRenderer.on` and return an unsubscribe function.
 *
 * Security posture (Req 2.5): with `contextIsolation: true` + `sandbox: true`,
 * the renderer cannot import `electron`, `fs`, or `path`. It only ever sees
 * this facade — raw channel strings ({@link CH}) never reach the renderer.
 *
 * Built as CommonJS (see `electron.vite.config.ts`) because sandboxed preloads
 * cannot be ES modules.
 */

import { contextBridge, ipcRenderer } from "electron";

import type { AppError } from "shared/types";
import type { SubbyApi } from "shared/subbyApi";

import { CH } from "./ipc/channels";

const api: SubbyApi = {
  // --- Subscriptions (Req 3) ---
  listSubscriptions: () => ipcRenderer.invoke(CH.subs.list),
  createSubscription: (input) => ipcRenderer.invoke(CH.subs.create, input),
  updateSubscription: (id, patch) =>
    ipcRenderer.invoke(CH.subs.update, { id, patch }),
  deleteSubscription: (id) => ipcRenderer.invoke(CH.subs.remove, id),
  setState: (id, state) =>
    ipcRenderer.invoke(CH.subs.setState, { id, state }),

  // --- Categories (Req 7) ---
  listCategories: () => ipcRenderer.invoke(CH.categories.list),
  createCategory: (name) => ipcRenderer.invoke(CH.categories.create, name),
  updateCategory: (id, patch) =>
    ipcRenderer.invoke(CH.categories.update, { id, color: patch.color }),
  deleteCategory: (id, opts) =>
    ipcRenderer.invoke(CH.categories.remove, { id, opts }),

  // --- Settings (Req 15) ---
  getSettings: () => ipcRenderer.invoke(CH.settings.get),
  updateSettings: (patch) => ipcRenderer.invoke(CH.settings.update, patch),
  chooseDataFolder: () => ipcRenderer.invoke(CH.settings.chooseDataFolder),

  // --- Suggested price (FR-13, Story 5.4) ---
  getPriceSuggestion: (name) => ipcRenderer.invoke(CH.price.suggest, name),

  // --- Data: import / export / backups (Req 16, 17, 18) ---
  importData: (req) => ipcRenderer.invoke(CH.data.importFile, req),
  exportData: (req) => ipcRenderer.invoke(CH.data.exportFile, req),
  listBackups: () => ipcRenderer.invoke(CH.data.listBackups),
  restoreBackup: (name) => ipcRenderer.invoke(CH.data.restoreBackup, name),

  // --- Events (main → renderer) ---
  onDataChanged: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on(CH.events.dataChanged, listener);
    return () => {
      ipcRenderer.removeListener(CH.events.dataChanged, listener);
    };
  },
  onError: (cb) => {
    const listener = (_event: unknown, error: AppError): void => cb(error);
    ipcRenderer.on(CH.events.error, listener as never);
    return () => {
      ipcRenderer.removeListener(CH.events.error, listener as never);
    };
  },
};

contextBridge.exposeInMainWorld("subby", api);
