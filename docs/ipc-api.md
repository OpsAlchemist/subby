# IPC & Renderer API

The renderer never accesses the filesystem or Electron directly. Every data
operation flows over IPC through a typed preload bridge exposed as
`window.subby`. The renderer never sees raw channel strings.

## Channels

Channel names are centralized in `electron/ipc/channels.ts` as `CH`:

```ts
const CH = {
  subs:       { list, create, update, remove, toggleActive },  // "subs:list", …
  categories: { list, create, remove },                        // "cat:list", …
  settings:   { get, update, chooseDataFolder },               // "settings:get", …
  data:       { importFile: "data:import", exportFile: "data:export",
                listBackups: "backup:list", restoreBackup: "backup:restore" },
  events:     { dataChanged: "evt:dataChanged", error: "evt:error" },
};
```

All request/response channels use `ipcRenderer.invoke` / `ipcMain.handle`. The
`events` group is for main → renderer broadcasts via `webContents.send`.

## Result & error contracts

Defined in `shared/types.ts`. Exceptions never cross the bridge — every handler
returns a discriminated result:

```ts
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppError };

interface AppError {
  code: "validation" | "io" | "corrupt" | "conflict" | "not_found" | "unknown";
  message: string;          // user-friendly
  field?: string;           // e.g. "name", "amount" (validation)
  file?: string;            // affected file (io/corrupt)
  canRestoreBackup?: boolean;
}
```

Other shared contracts:

```ts
type SubscriptionInput = Omit<Subscription, "id" | "createdAt" | "updatedAt">;
type ConflictMode = "Replace" | "Merge" | "Skip";
interface ImportRequest { format: "json" | "csv"; conflictMode: ConflictMode; path: string; }
interface ExportRequest { format: "json" | "csv"; path: string; }
```

## The `window.subby` facade

Typed by `shared/subbyApi.ts` (`SubbyApi`) and implemented by
`electron/preload.ts`. Every method resolves to an `IpcResult<T>`; the two event
hooks return an unsubscribe function.

```ts
interface SubbyApi {
  // Subscriptions
  listSubscriptions(): Promise<IpcResult<Subscription[]>>;
  createSubscription(input: SubscriptionInput): Promise<IpcResult<Subscription[]>>;
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<IpcResult<Subscription[]>>;
  deleteSubscription(id: string): Promise<IpcResult<Subscription[]>>;
  toggleActive(id: string, value: boolean): Promise<IpcResult<Subscription[]>>;

  // Categories
  listCategories(): Promise<IpcResult<Category[]>>;
  createCategory(name: string): Promise<IpcResult<CreateCategoryData>>;
  deleteCategory(id: string, opts?: { confirmed: boolean }): Promise<IpcResult<DeleteCategoryData>>;

  // Settings
  getSettings(): Promise<IpcResult<Settings>>;
  updateSettings(patch: Partial<Settings>): Promise<IpcResult<Settings>>;
  chooseDataFolder(): Promise<IpcResult<Settings | null>>;  // null when the dialog is cancelled

  // Data: import / export / backups
  importData(req: ImportRequest): Promise<IpcResult<ImportOutcome>>;
  exportData(req: ExportRequest): Promise<IpcResult<{ path: string; bytes: number }>>;
  listBackups(): Promise<IpcResult<string[]>>;
  restoreBackup(name: string): Promise<IpcResult<Subscription[]>>;

  // Events (main → renderer)
  onDataChanged(cb: () => void): Unsubscribe;
  onError(cb: (error: AppError) => void): Unsubscribe;
}
```

### Category result shapes

Creating returns the new list plus the created category. Deleting a category
that is still assigned to subscriptions is **not** an error — it is a
confirmation flow:

```ts
interface CreateCategoryData { categories: Category[]; created: Category; }

type DeleteCategoryData =
  | { needsConfirmation: false; categories: Category[] }                 // actually deleted
  | { needsConfirmation: true; name: string; inUseCount: number };       // prompt, then re-invoke with { confirmed: true }
```

## Handler behavior

`electron/ipc/handlers.ts` registers one `ipcMain.handle` per channel and:

- Wraps every service call in try/catch so failures become `IpcResult`
  failures, never thrown exceptions (`StorageCorruptError` → `corrupt`,
  zod `ZodError` → `validation` with `field`, duplicate category → `conflict`,
  unknown → `unknown`).
- Broadcasts `evt:dataChanged` after any successful **mutation** so all views
  refresh; read-only ops don't broadcast.
- Broadcasts `evt:error` only for **system-level** failures (`io`, `corrupt`,
  `unknown`) for a global toast; inline-resolvable errors (`validation`,
  `conflict`, `not_found`) are returned to the caller only.
- Registers idempotently (each channel is removed before re-adding) so dev
  hot-reload never throws.

Destructive sequencing (backup-before-destructive) and validate-before-import
are handled in the service/core layer, not re-implemented in handlers. The
native dialog channels (`settings:chooseDataFolder`, and the dialog-driven parts
of import/export) are wired in `main.ts` via `electron/services/dialog.ts`.

## Renderer wrapper

`src/api/subby.ts` is an ergonomic wrapper over `window.subby`:

- It **unwraps** `IpcResult<T>` — returning `data` on success or throwing a typed
  `SubbyError` (carrying the `AppError`) on failure — so callers can use plain
  `await`/`try-catch`.
- It re-exports `onDataChanged` / `onError`.
- It reads the facade through `getSubby()`, which prefers an injected fake
  (`setSubby(...)`) — the seam the renderer tests use to run without Electron.

Grouped helpers: `subscriptionsApi`, `categoriesApi`, `settingsApi`, `dataApi`.
