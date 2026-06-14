/**
 * Native open/save dialogs and data-folder chooser (Electron MAIN process).
 *
 * Requirements:
 *  - 15.3 Data folder chooser: pick a directory; subsequent file ops use it.
 *  - 16.1 Import: select a JSON/CSV file to validate + import.
 *  - 17.1 Export: write all subscriptions (+ settings) to a user-chosen path.
 *  - 17.2 Export format: write JSON or CSV per the selected format.
 *
 * This module is split into two layers:
 *
 *  1. **Pure dialog primitives** — `chooseImportFile`, `chooseExportFile`,
 *     `chooseDataFolder`. Each opens the right native dialog and returns the
 *     user's chosen path, or `null` when the dialog is cancelled. They perform
 *     NO file I/O and touch NO services, so they are trivially composable and
 *     safe to call from anywhere in the main process.
 *
 *  2. **Composable channel helpers** — `runChooseDataFolder`,
 *     `runImportFromDialog`, `runExportToDialog`. These compose a dialog
 *     primitive with the injected {@link AppServices} (and `node:fs/promises`)
 *     to implement the full behavior behind the `settings:chooseDataFolder`,
 *     `data:import`, and `data:export` channels. The IPC handlers (task 13.2)
 *     call these so the dialog/file plumbing lives here and the handlers stay
 *     thin.
 *
 * --------------------------------------------------------------------------
 * INTEGRATION CONTRACT for `electron/ipc/handlers.ts` (task 13.2)
 * --------------------------------------------------------------------------
 * The three dialog-driven channels should be wired like so (each returns an
 * `IpcResult<T>` — wrap the helper result and broadcast `evt:dataChanged` on
 * any mutation):
 *
 *  • CH.settings.chooseDataFolder →
 *      const r = await runChooseDataFolder(window, services);
 *      if (r.cancelled) return { ok: true, data: null };       // no change
 *      // r.settings is the merged Settings AFTER the folder switch (Req 15.3)
 *      broadcast(evt:dataChanged); return { ok: true, data: r.settings };
 *
 *  • CH.data.importFile → the request MAY carry an explicit `path` (renderer
 *    already chose a file) or omit it (open a dialog here):
 *      const r = await runImportFromDialog(window, services, {
 *        path: req.path, format: req.format, mode: req.conflictMode,
 *      });
 *      if (r.cancelled) return { ok: true, data: null };
 *      broadcast(evt:dataChanged); return { ok: true, data: r.outcome };
 *    Validation/backup-before-import are handled inside
 *    `services.applyImport` (see appWiring): the helper only resolves the path,
 *    reads the bytes, and infers the format from the file extension when the
 *    request does not pin one.
 *
 *  • CH.data.exportFile →
 *      const r = await runExportToDialog(window, services, req.format);
 *      if (r.cancelled) return { ok: true, data: null };
 *      return { ok: true, data: { path: r.path } };            // not a mutation
 *
 * All three helpers return a `{ cancelled: true }` shape when the user
 * dismisses the dialog so the handler can return a non-error "no-op" result
 * rather than surfacing a spurious `AppError`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";

import { dialog, type BrowserWindow, type FileFilter } from "electron";

import type { AppServices, DataFormat } from "../appWiring";
import type { ImportOutcome } from "core/import";
import type { Settings } from "core/models/settings";
import type { ConflictMode } from "shared/types";

/** Default file name suggested in the export save dialog (Req 17.1, 17.2). */
const EXPORT_BASENAME = "subby-export";

/** Native dialog filters reused across open/save dialogs. */
const FILTERS: Record<"json" | "csv" | "both", FileFilter> = {
  json: { name: "JSON", extensions: ["json"] },
  csv: { name: "CSV", extensions: ["csv"] },
  both: { name: "Subby data (JSON or CSV)", extensions: ["json", "csv"] },
};

/**
 * Map a file path to a supported data format by its extension.
 *
 * Returns `null` for unrecognized extensions so callers can fall back to a
 * caller-supplied format or reject the selection.
 */
export function formatForPath(path: string): DataFormat | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".csv") return "csv";
  return null;
}

// ---------------------------------------------------------------------------
// 1. Pure dialog primitives
// ---------------------------------------------------------------------------

/**
 * Open a file picker for importing data and return the selected file path
 * (Req 16.1). Shows a combined JSON/CSV filter plus dedicated JSON and CSV
 * filters and an "All files" escape hatch.
 *
 * @returns the absolute path of the chosen file, or `null` if cancelled.
 */
export async function chooseImportFile(
  window: BrowserWindow,
): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: "Import subscriptions",
    buttonLabel: "Import",
    properties: ["openFile"],
    filters: [
      FILTERS.both,
      FILTERS.json,
      FILTERS.csv,
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/**
 * Open a save dialog for exporting data and return the chosen destination path
 * (Req 17.1, 17.2). Suggests `subby-export.json` / `subby-export.csv` and shows
 * the filter matching the requested format.
 *
 * @param format the export serialization format selected by the user.
 * @returns the absolute destination path, or `null` if cancelled.
 */
export async function chooseExportFile(
  window: BrowserWindow,
  format: DataFormat,
): Promise<string | null> {
  const ext = format === "csv" ? "csv" : "json";
  const result = await dialog.showSaveDialog(window, {
    title: "Export subscriptions",
    buttonLabel: "Export",
    defaultPath: `${EXPORT_BASENAME}.${ext}`,
    filters: [format === "csv" ? FILTERS.csv : FILTERS.json],
  });
  if (result.canceled || result.filePath === undefined) return null;
  return result.filePath.length > 0 ? result.filePath : null;
}

/**
 * Open a directory picker for choosing the data folder (Req 15.3) and return
 * the selected directory path.
 *
 * @returns the absolute directory path, or `null` if cancelled.
 */
export async function chooseDataFolder(
  window: BrowserWindow,
): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: "Choose data folder",
    buttonLabel: "Use folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

// ---------------------------------------------------------------------------
// 2. Composable channel helpers
// ---------------------------------------------------------------------------

/** The subset of {@link AppServices} the channel helpers depend on. */
export type DialogServices = Pick<
  AppServices,
  "setDataFolder" | "applyImport" | "exportData"
>;

/** Result of {@link runChooseDataFolder}. */
export type ChooseDataFolderResult =
  | { cancelled: true }
  | { cancelled: false; path: string; settings: Settings };

/** Result of {@link runImportFromDialog}. */
export type ImportFromDialogResult =
  | { cancelled: true }
  | { cancelled: false; path: string; format: DataFormat; outcome: ImportOutcome };

/** Result of {@link runExportToDialog}. */
export type ExportToDialogResult =
  | { cancelled: true }
  | { cancelled: false; path: string; format: DataFormat };

/**
 * Drive the `settings:chooseDataFolder` channel: open the directory picker and,
 * when the user picks a folder, switch the active data folder via
 * {@link AppServices.setDataFolder} so subsequent file operations use the new
 * location (Req 15.3).
 *
 * @returns `{ cancelled: true }` when dismissed; otherwise the chosen `path`
 *          and the merged {@link Settings} after the switch.
 */
export async function runChooseDataFolder(
  window: BrowserWindow,
  services: DialogServices,
): Promise<ChooseDataFolderResult> {
  const path = await chooseDataFolder(window);
  if (path === null) return { cancelled: true };
  const settings = await services.setDataFolder(path);
  return { cancelled: false, path, settings };
}

/** Options for {@link runImportFromDialog}. */
export interface ImportFromDialogOptions {
  /** Conflict resolution mode applied to duplicates (Req 16.3). */
  mode: ConflictMode;
  /**
   * Pre-selected source path. When omitted, an open dialog is shown (Req 16.1).
   */
  path?: string;
  /**
   * Explicit format. When omitted, the format is inferred from the file
   * extension (`.json` / `.csv`).
   */
  format?: DataFormat;
}

/**
 * Drive the `data:import` channel: resolve the source path (using the open
 * dialog when none is supplied — Req 16.1), read the file bytes, infer the
 * format when not pinned, and apply the import via
 * {@link AppServices.applyImport} (which validates and backs up before
 * applying — Req 16.4).
 *
 * @returns `{ cancelled: true }` when the dialog is dismissed; otherwise the
 *          resolved `path`, the `format` used, and the import `outcome`.
 * @throws when the chosen file has an unrecognized extension and no `format`
 *         was supplied — the handler maps this to an `AppError`.
 */
export async function runImportFromDialog(
  window: BrowserWindow,
  services: DialogServices,
  opts: ImportFromDialogOptions,
): Promise<ImportFromDialogResult> {
  const path = opts.path ?? (await chooseImportFile(window));
  if (path === null) return { cancelled: true };

  const format = opts.format ?? formatForPath(path);
  if (format === null) {
    throw new Error(
      `Unsupported import file type: "${path}". Choose a .json or .csv file.`,
    );
  }

  const raw = await readFile(path, "utf-8");
  const outcome = await services.applyImport(raw, format, opts.mode);
  return { cancelled: false, path, format, outcome };
}

/**
 * Drive the `data:export` channel: open the save dialog (Req 17.1), serialize
 * the data in the requested format via {@link AppServices.exportData}
 * (Req 17.2), and write the bytes to the chosen path.
 *
 * @returns `{ cancelled: true }` when the dialog is dismissed; otherwise the
 *          destination `path` and the `format` written.
 */
export async function runExportToDialog(
  window: BrowserWindow,
  services: DialogServices,
  format: DataFormat,
): Promise<ExportToDialogResult> {
  const path = await chooseExportFile(window, format);
  if (path === null) return { cancelled: true };

  const contents = await services.exportData(format);
  await writeFile(path, contents, "utf-8");
  return { cancelled: false, path, format };
}
