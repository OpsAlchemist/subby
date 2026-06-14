/**
 * IPC channel name constants (Req 2.3, 2.4).
 *
 * Shared, centralized channel identifiers used by the main-process handlers
 * (`ipcMain.handle`, task 13.2) and the preload bridge (`ipcRenderer.invoke`,
 * task 13.3). The renderer never sees raw channel strings — it talks only to
 * the typed `window.subby` facade exposed by the preload.
 *
 * All request/response channels use `invoke`/`handle`; the `events` group is
 * for main → renderer broadcasts via `webContents.send`.
 *
 * Defined `as const` so each channel name is a literal type, letting the
 * handler and preload layers reference exact string constants without drift.
 */
export const CH = {
  subs: {
    list: "subs:list",
    create: "subs:create",
    update: "subs:update",
    remove: "subs:remove",
    toggleActive: "subs:toggleActive",
  },
  categories: { list: "cat:list", create: "cat:create", remove: "cat:remove" },
  settings: {
    get: "settings:get",
    update: "settings:update",
    chooseDataFolder: "settings:chooseDataFolder",
  },
  data: {
    importFile: "data:import", // {format, conflictMode, path}
    exportFile: "data:export", // {format, path}
    listBackups: "backup:list",
    restoreBackup: "backup:restore",
  },
  events: {
    dataChanged: "evt:dataChanged", // main → renderer broadcast
    error: "evt:error", // user-friendly error surface
  },
} as const;
