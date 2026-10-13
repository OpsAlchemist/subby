/**
 * Bundled read-only resource reader (FR-12, AD-23, AD-24, AD-30; Story 2.3).
 *
 * Electron MAIN process module. Node imports (`node:fs`, `node:path`) are
 * allowed here. This reader resolves and reads the app's bundled, READ-ONLY
 * `resources/` directory — the home of `fx-snapshot.json`, the offline ECB
 * daily-reference-rate dataset multi-currency totals convert from.
 *
 * It is deliberately NOT the {@link StoragePort}/`JsonFileStorage`: that port is
 * JSON-only for *mutable user data* in the Data Folder. This reader is for
 * *immutable, shipped* data and writes NOTHING. It is also NOT a network
 * primitive — it reads from the local filesystem via `node:fs` only, so the
 * privacy scan stays green.
 *
 * asar-awareness (AD-24, AD-30): the bundled `resources/` ships OUTSIDE the asar
 * archive via electron-builder `extraResources`, so in a packaged app it lives
 * under `process.resourcesPath` (e.g. `.../Subby.app/Contents/Resources/
 * resources/`), reachable with ordinary `node:fs` (files inside the asar would
 * need the asar-aware fs shim; `extraResources` sidesteps that). In dev
 * (unpackaged) the repo's `resources/` directory is used directly.
 *
 * Testability (mirrors `paths.ts`): {@link resolveResourceDir} is a PURE string
 * transform taking the Electron-supplied values as parameters, so dev-vs-
 * packaged resolution is unit-testable without booting Electron. The thin
 * `node:fs` read ({@link readBundledResource}) is the only impure part.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import {
  parseBundledSnapshot,
  type BundledFxSnapshot,
} from "core/fxSnapshot";

/** The canonical name of the bundled FX snapshot resource. */
export const FX_SNAPSHOT_RESOURCE = "fx-snapshot.json" as const;

/**
 * Inputs for {@link resolveResourceDir}, supplied by the app-wiring layer at the
 * Electron boundary. Kept as plain data so the resolution is a pure, testable
 * transform.
 *
 *   - `isPackaged`    — `app.isPackaged`: `true` in a built/installed app.
 *   - `resourcesPath` — `process.resourcesPath`: the packaged app's Resources
 *                       directory. Only consulted when `isPackaged`.
 *   - `appPath`       — `app.getAppPath()` in production, or the repo root in
 *                       dev. The dev `resources/` directory is resolved relative
 *                       to this.
 */
export interface ResolveResourceDirOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/**
 * Resolve the directory that holds the bundled read-only `resources/` identical
 * to how it ships in every target — PURE string transform (no I/O).
 *
 *   - Packaged → `<process.resourcesPath>/resources` (outside the asar, placed
 *     there by electron-builder `extraResources`).
 *   - Dev      → `<appPath>/resources` (the repo's `resources/` directory).
 *
 * This is NOT the Data Folder — the bundle is immutable shipped data, never read
 * from or written to the user's mutable data directory.
 */
export function resolveResourceDir(opts: ResolveResourceDirOptions): string {
  const base = opts.isPackaged ? opts.resourcesPath : opts.appPath;
  return join(base, "resources");
}

/**
 * Thrown when a bundled resource cannot be read: it is missing, unreadable, or
 * not valid JSON. LOUD by design — a corrupt/absent bundle is an explicit error
 * the caller surfaces, never a silent empty `{}` that would become a silent
 * wrong total.
 *
 *   - `resource` — the resource name requested (e.g. `fx-snapshot.json`).
 *   - `reason`   — `"missing"` (not found / unreadable) or `"malformed"`
 *                  (present but not valid JSON).
 */
export class ResourceReadError extends Error {
  readonly resource: string;
  readonly reason: "missing" | "malformed";

  constructor(resource: string, reason: "missing" | "malformed", cause?: unknown) {
    super(
      `Bundled resource "${resource}" is ${reason} and could not be read.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "ResourceReadError";
    this.resource = resource;
    this.reason = reason;
  }
}

/**
 * Read a bundled resource by name and return its parsed JSON (`unknown`), from
 * the asar-aware `resources/` directory, READ-ONLY via `node:fs`.
 *
 * A missing/unreadable file throws a {@link ResourceReadError} (`"missing"`);
 * a present-but-not-JSON file throws one (`"malformed"`). Never returns a silent
 * empty object.
 *
 * @param name The resource file name (e.g. `fx-snapshot.json`).
 * @param opts The resolution inputs (defaults read from the Electron globals,
 *             so production callers need pass nothing; tests inject explicit
 *             values).
 */
export function readBundledResource(
  name: string,
  opts: ResolveResourceDirOptions = defaultResolveOptions(),
): unknown {
  const path = join(resolveResourceDir(opts), name);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // ENOENT or any read failure → treat as missing (loud, never silent {}).
    throw new ResourceReadError(name, "missing", err);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ResourceReadError(name, "malformed", err);
  }
}

/**
 * Convenience: read AND validate the bundled FX snapshot into a typed
 * {@link BundledFxSnapshot}. Delegates parsing/validation to the pure
 * {@link parseBundledSnapshot} (loud on a bad shape / schema / currency / rate),
 * so a corrupt bundle is an explicit error here, never a silent wrong total.
 */
export function readBundledFxSnapshot(
  opts: ResolveResourceDirOptions = defaultResolveOptions(),
): BundledFxSnapshot {
  return parseBundledSnapshot(readBundledResource(FX_SNAPSHOT_RESOURCE, opts));
}

/**
 * Read the resolution inputs from the Electron globals. Isolated so the pure
 * {@link resolveResourceDir} and the reader stay injectable in tests — tests
 * supply explicit options and never reach this function, so they never touch
 * Electron. Only a production caller that omits options reads the globals here.
 */
function defaultResolveOptions(): ResolveResourceDirOptions {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
}
