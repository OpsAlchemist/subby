# Storage & Recovery

All persistence is local JSON files. There is no database. The main process is
the only place that touches the filesystem; the renderer reaches storage solely
through IPC.

## The storage port + adapter

The platform-independent `StoragePort` interface (`core/ports/storagePort.ts`)
defines read/write operations. The Electron implementation,
`JsonFileStorage` (`electron/storage/jsonFileStorage.ts`), fulfils it using JSON
files. A future Tauri/Web backend can provide its own implementation without
touching the core or the UI.

## Path resolution

`electron/storage/paths.ts`:

```ts
const fileNames = {
  subscriptions: "subscriptions.json",
  settings: "settings.json",
  categories: "categories.json",
  backupDir: "backup",
};
resolveDataDir(override: string | null, defaultUserData: string): string
```

`resolveDataDir` returns the user's `settings.dataFolder` override when set,
otherwise the platform `userData` directory (`app.getPath('userData')`). It is a
pure string transform — the adapter injects the real `userData` path — so it is
unit-testable without booting Electron.

## Bootstrap

On the first read, `JsonFileStorage`:

1. Ensures the directory tree exists — creates the App Data Directory and the
   `backup/` subdirectory if missing.
2. Lazily creates any missing JSON file with valid default content
   (empty subscriptions; `DEFAULT_SETTINGS`; the 11 default categories).

This means a fresh install or a deleted file self-heals on next launch.

## Safe reads

`electron/storage/safeJson.ts` guarantees reads never crash the app:

```ts
type SafeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "missing" | "malformed" | "corrupt"; raw?: string };

safeReadJson<T>(file: string, validate: (data: unknown) => T): Promise<SafeReadResult<T>>
writeJsonAtomic(file: string, data: unknown): Promise<void>
```

- `missing` — file does not exist (`ENOENT`). The adapter recreates it with
  defaults and returns them.
- `malformed` — bytes are not valid JSON (or unreadable). Not overwritten.
- `corrupt` — valid JSON that fails zod validation. Not overwritten.

`writeJsonAtomic` writes to a temp file then renames over the target, so an
interrupted write can never corrupt the existing file.

## Recovery policy & error contract

When a file is malformed or corrupt, the adapter does **not** overwrite it.
Instead it throws a typed `StorageCorruptError`:

```ts
class StorageCorruptError extends Error {
  isStorageCorruptError: true;
  file: string;                       // e.g. "subscriptions.json"
  reason: "malformed" | "corrupt";
  canRestoreBackup: boolean;          // true only for subscriptions.json when a backup exists
}
isStorageCorruptError(err): err is StorageCorruptError
```

The IPC layer catches this and surfaces an `AppError` of code `"corrupt"` to the
renderer (carrying `file` and `canRestoreBackup`), so the UI can show which file
is affected and offer "Restore latest backup" — or "reset to defaults" for
settings/categories, which have no backup stream.

## Backups

Pure parts live in `core/backup.ts`; the writes live in the adapter.

- `createBackup(reason)` writes the current subscriptions to
  `backup/<YYYY-MM-DD-HH-MM>.json` (UTC, zero-padded) and returns the filename.
- `listBackups()` returns backup file names newest-first (zero-padded timestamps
  sort lexicographically = chronologically).
- `readBackup(name)` validates and returns a `SubscriptionsFile`; the name is
  reduced to its base name to prevent path traversal.

**Backup-before-destructive sequencing.** The app services create a backup
*before* any destructive operation:

| Operation | Backup reason |
| --- | --- |
| Delete subscription | `pre-delete` |
| Apply import | `pre-import` |
| Restore backup | `pre-restore` |

Restore therefore always snapshots the current data first, so a restore is
itself reversible.

## Changing the data folder

`setDataFolder(path)` switches the active directory and ensures the tree exists
at the new location; subsequent reads/writes target it. The chosen folder is
persisted in `settings.dataFolder`, and on startup the app honors it before any
window or handler touches data.

## Error handling summary

| Situation | Handling |
| --- | --- |
| Malformed JSON | Keep running; surface `{ code: "corrupt", file }`. |
| Corrupt JSON | Don't overwrite; offer "Restore latest backup" when available. |
| Missing file | Recreate with valid defaults; continue. |
| Any failed op | Return a friendly `AppError`; never throw across the IPC bridge. |
| Validation | `{ code: "validation", field }` so the UI can point at the field. |
