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
  logos: {
    // Read-only bundled Logo Pack delivery (Story 8.3). Mirrors `fx:snapshot`:
    // no `evt:dataChanged`, returns an `IpcResult`, and degrades to an EMPTY
    // pack (never an error) so every row renders a lettered fallback. The
    // renderer hydrates this ONCE at launch into `logoPackStore` so each row
    // resolves its tile synchronously with no per-row IPC (AD-9).
    pack: "logos:pack",
    // Read-only fetched-logo cache map (Story 8.4). Returns a domain→data-URI
    // record from the `logos/` blob cache (`{}` until a logo is fetched). The
    // renderer hydrates it into `logoCacheStore` at launch AND reloads it on
    // `evt:dataChanged`, so a persisted logo swaps in with no fs access.
    cache: "logos:cache",
  },
  enrich: {
    // Enqueue a domain for background logo enrichment (Story 8.4). Returns an
    // ACK immediately (`IpcResult<null>`) — the UI never awaits the fetch
    // (AD-9); the serial worker processes the job later and broadcasts a
    // coalesced `evt:dataChanged` on completion.
    enqueue: "enrich:enqueue",
    // On-demand "Sync Now" (Story 9.2). Fire-and-forget like `enrich:enqueue`:
    // returns an ACK immediately (`IpcResult<null>`) — the UI never awaits a
    // fetch (AD-9). The main-side handler dispatches a logo backfill (if
    // `liveLogoFetch` on) and a FORCED FX refresh (if `fxRefresh` on) through the
    // SAME background queue; results swap in later via the coalesced
    // `evt:dataChanged`. Each sub-dispatch is independently gated on its toggle.
    syncNow: "enrich:syncNow",
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
