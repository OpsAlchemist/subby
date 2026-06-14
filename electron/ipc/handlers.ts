/**
 * IPC handlers with destructive-op sequencing (task 13.2).
 *
 * Electron MAIN process module. Registers one `ipcMain.handle` per request/
 * response channel in {@link CH} (subs / categories / settings / data) and
 * returns a discriminated {@link IpcResult} from every handler so that an
 * exception never crosses the renderer↔main bridge (Req 19.4). Scheduler-style
 * broadcasts (`evt:dataChanged`, `evt:error`) are sent to the renderer with
 * `webContents.send` so all views refresh after a successful mutation
 * (Req 8.6 wiring) and so system-level failures surface globally.
 *
 * Sequencing note: backup-before-destructive (delete, import-apply, restore —
 * Req 3.3, 16.4, 18.2, 18.3) and validate-before-import (Req 16.1) already live
 * inside the {@link AppServices} layer (`electron/appWiring.ts`) and `core`'s
 * `planImport`. These handlers rely on that and do not re-implement it.
 *
 * Out of scope (task 14 — dialog service): the `settings:chooseDataFolder`
 * channel (which opens a native folder picker) is intentionally NOT registered
 * here. The import/export handlers, however, do touch the filesystem at the
 * `path` supplied in the request: import reads the bytes at `req.path`, export
 * writes the serialized bytes to `req.path`. Selecting that path via a dialog
 * is task 14.
 *
 * ---
 * IpcResult mappings (documented contract):
 *   - success                          → `{ ok: true, data }`
 *   - {@link StorageCorruptError}      → `{ code: "corrupt", file, canRestoreBackup, message }`
 *   - zod `ZodError`                   → `{ code: "validation", field, message }`
 *   - createCategory duplicate         → `{ code: "conflict", field: "name", message }`
 *   - deleteCategory not_found         → `{ code: "not_found", message }`
 *   - deleteCategory needs_confirmation→ `{ ok: true, data: { needsConfirmation: true, name, inUseCount } }`
 *                                        (NOT an error — an expected flow the
 *                                         renderer acts on by prompting then
 *                                         re-invoking with `{ confirmed: true }`)
 *   - any other thrown error           → `{ code: "unknown", message }`
 *
 * `evt:error` is broadcast only for SYSTEM-level failures (`io`, `corrupt`,
 * `unknown`) so a global toast can surface them; inline-resolvable errors
 * (`validation`, `conflict`, `not_found`) are returned to the caller only.
 */

import { readFile, writeFile } from "node:fs/promises";

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { ZodError } from "zod";

import type { Category } from "core/models/category";
import type { Settings } from "core/models/settings";
import type { Subscription } from "core/models/subscription";
import type { SubscriptionPatch } from "core/subscriptions";
import type { CreateCategoryResult } from "core/categories";
import type { ImportOutcome } from "core/import";
import type {
  AppError,
  ExportRequest,
  ImportRequest,
  IpcResult,
} from "shared/types";

import type { AppServices } from "../appWiring";
import { isStorageCorruptError } from "../storage/jsonFileStorage";
import { CH } from "./channels";

/** Returns the live BrowserWindow used for renderer broadcasts, or null. */
export type GetWindow = () => BrowserWindow | null;

/**
 * Result data returned by the `cat:remove` handler.
 *
 * Deleting an in-use category is not an error — it is a confirmation flow
 * (Req 7.4). The handler surfaces `needsConfirmation: true` as a SUCCESS result
 * so the renderer can prompt the user and then re-invoke the same channel with
 * `{ confirmed: true }`.
 */
export type DeleteCategoryData =
  | { needsConfirmation: false; categories: Category[] }
  | { needsConfirmation: true; name: string; inUseCount: number };

/** Success data returned by the `cat:create` handler. */
export interface CreateCategoryData {
  categories: Category[];
  created: Category;
}

// --- Error mapping -----------------------------------------------------------

/**
 * Translate any thrown value into a user-friendly {@link AppError} so it can be
 * returned as an `IpcResult` failure instead of crashing the bridge (Req 19.4).
 */
function toAppError(err: unknown): AppError {
  if (isStorageCorruptError(err)) {
    return {
      code: "corrupt",
      message: err.message,
      file: err.file,
      canRestoreBackup: err.canRestoreBackup,
    };
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field =
      issue && issue.path.length > 0
        ? String(issue.path[issue.path.length - 1])
        : undefined;
    return {
      code: "validation",
      message: issue?.message ?? "Validation failed.",
      field,
    };
  }
  const message =
    err instanceof Error ? err.message : "An unexpected error occurred.";
  return { code: "unknown", message };
}

/** System-level codes worth surfacing globally via `evt:error`. */
const SYSTEM_ERROR_CODES: ReadonlySet<AppError["code"]> = new Set([
  "io",
  "corrupt",
  "unknown",
]);

// --- Handler registration ----------------------------------------------------

/**
 * Register all request/response IPC handlers over the given {@link AppServices}.
 *
 * Registration is duplicate-safe: each channel is `removeHandler`'d before
 * `handle`, so re-running this (e.g. on a dev hot-reload) never throws
 * "second handler" errors. Call {@link unregisterIpcHandlers} to tear down.
 *
 * @param services  The assembled application services (from `buildAppServices`).
 * @param getWindow Accessor for the renderer window used to broadcast
 *                  `evt:dataChanged` / `evt:error`. May return `null` if no
 *                  window is currently open (broadcasts are then skipped).
 */
export function registerIpcHandlers(
  services: AppServices,
  getWindow: GetWindow,
): void {
  const broadcastDataChanged = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(CH.events.dataChanged);
    }
  };

  const broadcastError = (error: AppError): void => {
    if (!SYSTEM_ERROR_CODES.has(error.code)) return;
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(CH.events.error, error);
    }
  };

  /** Duplicate-safe registration. */
  const handle = <T>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: never[]) => Promise<T> | T,
  ): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener as never);
  };

  /**
   * Run a read-only service call, wrapping success/failure into an IpcResult.
   * Never broadcasts `evt:dataChanged` (no mutation occurred).
   */
  const query = async <T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      const error = toAppError(err);
      broadcastError(error);
      return { ok: false, error };
    }
  };

  /**
   * Run a mutating service call. On success, broadcasts `evt:dataChanged` so
   * every view refreshes (Req 8.6 wiring), then returns the data.
   */
  const mutate = async <T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> => {
    try {
      const data = await fn();
      broadcastDataChanged();
      return { ok: true, data };
    } catch (err) {
      const error = toAppError(err);
      broadcastError(error);
      return { ok: false, error };
    }
  };

  // --- Subscriptions (Req 3) -------------------------------------------------

  handle<IpcResult<Subscription[]>>(CH.subs.list, () =>
    query(() => services.listSubscriptions()),
  );

  handle<IpcResult<Subscription[]>>(
    CH.subs.create,
    (_event, input: Parameters<AppServices["createSubscription"]>[0]) =>
      mutate(() => services.createSubscription(input)),
  );

  handle<IpcResult<Subscription[]>>(
    CH.subs.update,
    (_event, payload: { id: string; patch: SubscriptionPatch }) =>
      mutate(() => services.updateSubscription(payload.id, payload.patch)),
  );

  handle<IpcResult<Subscription[]>>(
    CH.subs.remove,
    // Backup-before-delete is sequenced inside the service (Req 3.3).
    (_event, id: string) => mutate(() => services.deleteSubscription(id)),
  );

  handle<IpcResult<Subscription[]>>(
    CH.subs.toggleActive,
    (_event, payload: { id: string; value: boolean }) =>
      mutate(() => services.toggleActive(payload.id, payload.value)),
  );

  // --- Categories (Req 7) ----------------------------------------------------

  handle<IpcResult<Category[]>>(CH.categories.list, () =>
    query(() => services.listCategories()),
  );

  handle<IpcResult<CreateCategoryData>>(
    CH.categories.create,
    async (_event, name: string): Promise<IpcResult<CreateCategoryData>> => {
      try {
        const result: CreateCategoryResult =
          await services.createCategory(name);
        if (result.ok) {
          broadcastDataChanged();
          return {
            ok: true,
            data: { categories: result.categories, created: result.created },
          };
        }
        // Duplicate name → conflict, naming the offending field (Req 7.3).
        return {
          ok: false,
          error: {
            code: "conflict",
            field: "name",
            message: `A category named "${result.name}" already exists.`,
          },
        };
      } catch (err) {
        const error = toAppError(err);
        broadcastError(error);
        return { ok: false, error };
      }
    },
  );

  handle<IpcResult<DeleteCategoryData>>(
    CH.categories.remove,
    async (
      _event,
      payload: { id: string; opts?: { confirmed: boolean } },
    ): Promise<IpcResult<DeleteCategoryData>> => {
      try {
        const outcome = await services.deleteCategory(
          payload.id,
          payload.opts,
        );
        if (outcome.ok) {
          broadcastDataChanged();
          return {
            ok: true,
            data: { needsConfirmation: false, categories: outcome.categories },
          };
        }
        if (outcome.reason === "needs_confirmation") {
          // Not an error: ask the renderer to confirm before deleting (Req 7.4).
          return {
            ok: true,
            data: {
              needsConfirmation: true,
              name: outcome.name,
              inUseCount: outcome.inUseCount,
            },
          };
        }
        return {
          ok: false,
          error: { code: "not_found", message: "Category not found." },
        };
      } catch (err) {
        const error = toAppError(err);
        broadcastError(error);
        return { ok: false, error };
      }
    },
  );

  // --- Settings (Req 15) -----------------------------------------------------
  // Note: `settings:chooseDataFolder` (native dialog) is registered by the
  // dialog service in task 14, not here.

  handle<IpcResult<Settings>>(CH.settings.get, () =>
    query(() => services.getSettings()),
  );

  handle<IpcResult<Settings>>(
    CH.settings.update,
    (_event, patch: Partial<Settings>) =>
      mutate(() => services.updateSettings(patch)),
  );

  // --- Data: import / export / backups (Req 16, 17, 18) ----------------------

  handle<IpcResult<ImportOutcome>>(
    CH.data.importFile,
    async (_event, req: ImportRequest): Promise<IpcResult<ImportOutcome>> => {
      // Read the file bytes at the chosen path, then hand off to the service,
      // which backs up first (Req 16.4) and validates per record (Req 16.1)
      // inside `planImport` before persisting.
      return mutate(async () => {
        const raw = await readFile(req.path, "utf8");
        return services.applyImport(raw, req.format, req.conflictMode);
      });
    },
  );

  handle<IpcResult<{ path: string; bytes: number }>>(
    CH.data.exportFile,
    async (
      _event,
      req: ExportRequest,
    ): Promise<IpcResult<{ path: string; bytes: number }>> => {
      // Export is read-only with respect to app data; serialize then write to
      // the chosen path. No `evt:dataChanged` (nothing in the store changed).
      return query(async () => {
        const serialized = await services.exportData(req.format);
        await writeFile(req.path, serialized, "utf8");
        return { path: req.path, bytes: Buffer.byteLength(serialized, "utf8") };
      });
    },
  );

  handle<IpcResult<string[]>>(CH.data.listBackups, () =>
    query(() => services.listBackups()),
  );

  handle<IpcResult<Subscription[]>>(
    CH.data.restoreBackup,
    // Backup-current-then-restore is sequenced inside the service (Req 18.3).
    (_event, name: string) => mutate(() => services.restoreBackup(name)),
  );
}

/**
 * Every channel this module registers. Used by {@link unregisterIpcHandlers}
 * to tear down cleanly (e.g. before re-registering on a window recreate).
 */
const REGISTERED_CHANNELS: readonly string[] = [
  CH.subs.list,
  CH.subs.create,
  CH.subs.update,
  CH.subs.remove,
  CH.subs.toggleActive,
  CH.categories.list,
  CH.categories.create,
  CH.categories.remove,
  CH.settings.get,
  CH.settings.update,
  CH.data.importFile,
  CH.data.exportFile,
  CH.data.listBackups,
  CH.data.restoreBackup,
];

/** Remove all handlers registered by {@link registerIpcHandlers}. */
export function unregisterIpcHandlers(): void {
  for (const channel of REGISTERED_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
