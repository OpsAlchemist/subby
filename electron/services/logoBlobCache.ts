/**
 * Logo blob cache (Electron MAIN process; Story 8.4, AD-13).
 *
 * A tiny file-cache helper that persists FETCHED brand logos as raw blobs under
 * `<App_Data_Directory>/logos/<domain>.<ext>`, keyed by the SAME registrable
 * domain the pure resolver (`core/logo.domainFromWebsite`) produces. It is the
 * local-persistence half of the enrichment pipeline (the fetch itself is the
 * `logoFetcher` provider through the 8.1 gateway).
 *
 * Deliberately PARALLEL to the StoragePort, never part of it (AD-13): the port
 * stays JSON-only and gains no blob API. This helper owns its own filesystem
 * I/O under the data folder.
 *
 * Three properties the design leans on:
 *  - **Relocation is a re-point, not a move.** The active data directory is read
 *    FRESH on EVERY op via the injected `getDataDir()` accessor (which maps to
 *    the storage adapter's `getDataFolder()`), so after the user relocates the
 *    Data Folder the next cache op simply targets the new `<folder>/logos/`.
 *    Old blobs under the previous folder are left in place — not migrated.
 *  - **Never-refetch is a `has()` check.** The EnrichmentService consults
 *    {@link has} before fetching, so a domain already on disk is never fetched
 *    or re-written (the single serial queue is the enforcement point).
 *  - **Crash-safe writes.** {@link write} uses the binary {@link writeFileAtomic}
 *    (temp-then-rename), so an interrupted write never leaves a torn blob.
 *
 * The cache is delivered to the renderer as a domain→`data:<mime>;base64,…` map
 * ({@link readAllAsDataUris}) so the sandboxed renderer needs NO filesystem
 * access and `resolveLogo`'s cache tier renders synchronously from a plain
 * string. No network primitive, no telemetry — this file only touches the local
 * filesystem.
 */

import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { fileNames } from "../storage/paths";
import { writeFileAtomic } from "../storage/safeJson";

/**
 * The content-types the cache knows how to persist and the file extension it
 * stores each under. The provider returns a `contentType`; the cache maps it to
 * a stable, lowercase extension so a domain's blob path is deterministic and the
 * data-URI mime is recoverable from the extension on read.
 *
 * SVG (Simple-Icon-style) and the common raster logo formats are covered; the
 * Story 8.5 provider of record (Google faviconV2) returns PNG. An unknown
 * content-type is refused by {@link extensionFor} so a mystery blob is never
 * written with a guessed extension.
 */
const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/ico": "ico",
};

/** The reverse map: a stored extension → its data-URI mime type (read path). */
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
};

/**
 * Resolve a provider `contentType` to a stable file extension, or `null` for an
 * unknown type. The content-type is normalized (lowercased, any `; charset=…`
 * parameter stripped) before lookup. A `null` return means the blob is NOT
 * cacheable (the caller silently drops it — never a guessed extension).
 */
export function extensionFor(contentType: string): string | null {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[normalized] ?? null;
}

/**
 * The ONE authoritative domain-key normalization + shape guard, used by BOTH the
 * blob-cache path (`has`/`write`) AND the EnrichmentService's queue de-dup so the
 * two can never diverge. It is a SECURITY gate, not cosmetics: the key becomes a
 * filename segment (`join(logosDir, `${key}.${ext}`)`), so a renderer-supplied
 * value like `../../evil` must be refused BEFORE it can escape the `logos/`
 * directory (path traversal). Fail-closed: a key that is not a plain registrable
 * domain returns `null` and the caller drops it (no fetch, no write, no read).
 *
 * A valid key is the trimmed, lowercased input that:
 *   - contains ONLY `[a-z0-9.-]` (no `/`, `\`, path separators, or whitespace),
 *   - contains at least one `.` (a registrable domain always does, matching the
 *     resolver's `domainFromWebsite` output), and
 *   - has no `..` traversal segment and no leading/trailing/doubled dot that
 *     could form an empty or dot-only path segment.
 *
 * @returns the normalized key, or `null` when the input is not domain-shaped.
 */
export function normalizeDomainKey(domain: string): string | null {
  if (typeof domain !== "string") return null;
  const key = domain.trim().toLowerCase();
  if (key === "") return null;
  // Shape: only domain characters, and at least one dot.
  if (!/^[a-z0-9.-]+$/.test(key)) return null;
  if (!key.includes(".")) return null;
  // No empty label (leading/trailing/doubled dot) and therefore no `..` segment.
  if (key.split(".").some((label) => label === "")) return null;
  return key;
}

/**
 * The subset of a filename that is the domain key: everything before the final
 * extension. Only files whose extension is a known logo extension are treated as
 * cache entries, so a stray `.tmp` (a temp file mid-write) or an unrelated file
 * is ignored by {@link LogoBlobCache.readAllAsDataUris}.
 */
function parseEntry(fileName: string): { domain: string; ext: string } | null {
  const ext = extname(fileName).replace(/^\./, "").toLowerCase();
  if (ext === "" || EXTENSION_CONTENT_TYPES[ext] === undefined) return null;
  const domain = fileName.slice(0, fileName.length - ext.length - 1);
  if (domain === "") return null;
  return { domain, ext };
}

/**
 * The file-cache for fetched logos. Construct with a `getDataDir` accessor that
 * returns the CURRENTLY-active data directory (the storage adapter's
 * `getDataFolder()`), so every op reads the live folder and Data-Folder
 * relocation needs no explicit move.
 */
export class LogoBlobCache {
  private readonly getDataDir: () => string;

  /**
   * @param getDataDir Returns the active `App_Data_Directory` fresh on each
   *                   call (typically `storage.getDataFolder`). The cache joins
   *                   `logos/` under it per op, so a folder re-point is picked
   *                   up on the very next operation.
   */
  constructor(getDataDir: () => string) {
    this.getDataDir = getDataDir;
  }

  /** The active `<App_Data_Directory>/logos/` directory, resolved fresh. */
  private logosDir(): string {
    return join(this.getDataDir(), fileNames.logosDir);
  }

  /**
   * Whether a logo blob for `domain` already exists on disk (any known
   * extension). The never-refetch gate: the EnrichmentService checks this before
   * fetching so a cached domain is never re-fetched or re-written. Never throws —
   * an unreadable/absent `logos/` directory is simply "not cached".
   */
  async has(domain: string): Promise<boolean> {
    // Fail-closed path-traversal guard (SECURITY): a non-domain-shaped key never
    // forms a filename, so it is treated as "not cached" (never a fetch trigger).
    const key = normalizeDomainKey(domain);
    if (key === null) return false;
    let entries: string[];
    try {
      entries = await readdir(this.logosDir());
    } catch {
      // No logos/ dir yet (fresh install / never fetched) → not cached.
      return false;
    }
    for (const name of entries) {
      const parsed = parseEntry(name);
      if (parsed !== null && parsed.domain.toLowerCase() === key) return true;
    }
    return false;
  }

  /**
   * Persist `bytes` for `domain` as `<logos>/<domain>.<ext>` where `<ext>` is
   * derived from `contentType`. The write is atomic (temp-then-rename). Returns
   * `true` when the blob was written, `false` when the content-type is unknown
   * (an uncacheable type is dropped silently — never a guessed extension, never
   * a throw to the caller for a bad type). A genuine filesystem fault still
   * rejects so the service's catch can log and degrade.
   *
   * The domain key is lowercased to match `domainFromWebsite`'s lowercased
   * output and {@link readAllAsDataUris}'s lowercased keys.
   */
  async write(
    domain: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<boolean> {
    // Fail-closed path-traversal guard (SECURITY): refuse a non-domain-shaped key
    // BEFORE it becomes a filename segment — write nothing outside logos/.
    const key = normalizeDomainKey(domain);
    if (key === null) return false;
    const ext = extensionFor(contentType);
    if (ext === null) return false; // uncacheable content-type → drop silently
    const file = join(this.logosDir(), `${key}.${ext}`);
    await writeFileAtomic(file, bytes);
    return true;
  }

  /**
   * Read every cached blob and return a `domain → data:<mime>;base64,…` map —
   * the exact shape `resolveLogo`'s cache tier and the renderer's
   * `logoCacheStore` consume. The renderer therefore needs NO filesystem access
   * and the tile renders synchronously from a string.
   *
   * Never throws: an absent/unreadable `logos/` directory yields `{}`; a single
   * unreadable blob is skipped (it just falls back to the lettered tile) rather
   * than failing the whole map. When a domain somehow has multiple extensions on
   * disk, the first entry encountered in the `readdir` listing wins (the OS does
   * not guarantee a stable listing order, but a domain never has two blobs in
   * normal operation — the never-refetch gate writes one extension per domain).
   */
  async readAllAsDataUris(): Promise<Record<string, string>> {
    const dir = this.logosDir();
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const name of entries) {
      const parsed = parseEntry(name);
      if (parsed === null) continue;
      const key = parsed.domain.toLowerCase();
      if (out[key] !== undefined) continue; // first readable entry per domain wins
      const mime = EXTENSION_CONTENT_TYPES[parsed.ext];
      try {
        const bytes = await readFile(join(dir, name));
        out[key] = `data:${mime};base64,${bytes.toString("base64")}`;
      } catch {
        // Skip an unreadable blob — the row falls back to the lettered tile.
      }
    }
    return out;
  }
}
