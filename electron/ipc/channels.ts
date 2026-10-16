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
    setState: "subs:setState",
  },
  categories: {
    list: "cat:list",
    create: "cat:create",
    update: "cat:update", // {id, color} — color-only; rename is out of scope (Story 3.4)
    remove: "cat:remove",
  },
  settings: {
    get: "settings:get",
    update: "settings:update",
    chooseDataFolder: "settings:chooseDataFolder",
  },
  price: {
    // Read-only suggested-price lookup for the Add modal (FR-13, Story 5.4).
    suggest: "price:suggest",
  },
  fx: {
    // Read-only bundled FX-snapshot lookup, rebased to the queried Home
    // Currency (Story 6.1). Mirrors `price:suggest`: no `evt:dataChanged`,
    // returns an `IpcResult`, degrades to an error outcome on a bad bundle.
    snapshot: "fx:snapshot",
  },
  data: {
    importFile: "data:import", // {format, conflictMode, path}
    exportFile: "data:export", // {format, path}
    listBackups: "backup:list",
    restoreBackup: "backup:restore",
    createBackup: "backup:create", // manual "Back up now" → backupNow("manual")
  },
  events: {
    dataChanged: "evt:dataChanged", // main → renderer broadcast
    error: "evt:error", // user-friendly error surface
  },
} as const;
