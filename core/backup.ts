/**
 * Backup logic — pure parts (Req 18.1).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * This module owns only the pure, side-effect-free parts of the
 * Backup_Service: generating a timestamped backup file name and assembling
 * the restore payload that will be written to disk. The actual file write
 * (and read) lives in the Electron storage adapter (`JsonFileStorage`,
 * task 12.1), keeping `core/` free of platform dependencies.
 */

import type { Subscription, SubscriptionsFile } from "./models/subscription";

/**
 * Current on-disk schema version for the subscriptions backup payload.
 *
 * Matches the `version` field of {@link SubscriptionsFile}. Kept as a single
 * source of truth so backup payloads stay consistent with the live data file.
 */
export const BACKUP_SCHEMA_VERSION = 1;

/**
 * Zero-pad a non-negative integer to the given width.
 *
 * Used to format date/time components (e.g. `5` -> `"05"`) so every part of
 * the backup file name has a fixed width.
 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Optional per-call uniqueness input for {@link backupFileName}, supplied by the
 * adapter (AD-16). It exists so that two backups taken within the same UTC
 * **minute** — e.g. a Story-1.4 pre-migration backup followed by a same-minute
 * scheduled or pre-destructive backup — can never collide and clobber each other.
 *
 * Purity (AD-1) is preserved: this is **injected** by the Electron adapter, which
 * is the only place that reads the real clock/counter. `core/` never calls
 * `Date.now()`/`Math.random()`/`fs`; it only formats what it is handed. The
 * instant's own sub-minute precision (seconds + milliseconds) is read from the
 * **injected** `now` Date — exactly as the existing minute/hour components already
 * are — so no new impurity is introduced.
 *
 *   - `seq` — an optional, adapter-owned monotonic in-process counter. It is the
 *     last line of defence: when two backups land in the *same millisecond*
 *     (seconds + millis identical), a differing `seq` still yields distinct,
 *     prefix-sortable names. Omit it (or pass `undefined`) to leave it off the
 *     name.
 */
export interface BackupNameUniqueness {
  /** Monotonic in-process counter appended as the final tie-breaking segment. */
  seq?: number;
}

/**
 * Generate a **collision-proof**, timestamped backup file name of the form
 * `YYYY-MM-DD-HH-MM-SS-mmm[-SSSS].json` (Req 18.1, AD-16).
 *
 * The leading `YYYY-MM-DD-HH-MM` is unchanged from the original minute-
 * granularity format, so newest-first lexicographic ordering (AD-27) still holds
 * for the common, load-bearing case: any two backups in *different* minutes order
 * entirely by this shared, zero-padded prefix, exactly as before. Pre-existing
 * legacy `YYYY-MM-DD-HH-MM.json` files continue to list and restore.
 *
 * One benign same-minute edge: when a legacy `...-HH-MM.json` name and a
 * same-minute new-format `...-HH-MM-SS...json` name coexist, the legacy name
 * sorts *after* (i.e. shows as newer than) the new one — because at the point the
 * two diverge the legacy name has `.` (0x2E) where the new name has `-` (0x2D),
 * and `.` > `-`. This is harmless and waived: a legacy name only ever exists from
 * before the collision-proof format shipped, so a same-minute pairing is
 * vanishingly rare, and cross-minute ordering (what actually matters) is always
 * correct.
 *
 * The appended **seconds** (`SS`) and **milliseconds** (`mmm`) make two backups
 * in the same minute distinct; an optional, adapter-injected **monotonic
 * counter** (`SSSS`, zero-padded to 4) breaks ties within the same millisecond.
 * Every appended segment is zero-padded so the whole name stays
 * lexicographically = chronologically ordered.
 *
 * Time zone choice: components are derived in **UTC** (via the `getUTC*`
 * accessors). UTC is chosen deliberately so the function is deterministic and
 * independent of the host machine's local time zone, which keeps `core/` pure
 * and its tests stable regardless of where they run. The Electron adapter is
 * responsible only for placing the resulting file inside the `backup/`
 * subdirectory and for enforcing never-overwrite at the filesystem level.
 *
 * All components are zero-padded:
 *   - year    -> 4 digits
 *   - month   -> 2 digits (01–12; `getUTCMonth()` is 0-based, so +1)
 *   - day     -> 2 digits (01–31)
 *   - hour    -> 2 digits (00–23)
 *   - minute  -> 2 digits (00–59)
 *   - second  -> 2 digits (00–59)
 *   - millis  -> 3 digits (000–999)
 *   - seq     -> 4 digits (0000–9999), only when `uniqueness.seq` is supplied
 *
 * Purity (AD-1): no wall-clock or entropy read happens here. `now` and any
 * `seq` are injected by the adapter. There is no `Date.now()`/`Math.random()`.
 *
 * @param now        - The instant to stamp the backup with (injected).
 * @param uniqueness - Optional adapter-injected tie-breaker (`seq`).
 * @returns A file name such as `2025-03-07-09-05-42-137-0003.json`.
 */
export function backupFileName(
  now: Date,
  uniqueness: BackupNameUniqueness = {},
): string {
  const year = pad(now.getUTCFullYear(), 4);
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  const hour = pad(now.getUTCHours());
  const minute = pad(now.getUTCMinutes());
  const second = pad(now.getUTCSeconds());
  const millis = pad(now.getUTCMilliseconds(), 3);
  const seqSuffix =
    uniqueness.seq !== undefined ? `-${pad(uniqueness.seq, 4)}` : "";
  return `${year}-${month}-${day}-${hour}-${minute}-${second}-${millis}${seqSuffix}.json`;
}

/**
 * Assemble the restore/backup payload to be written to disk (Req 18.1).
 *
 * Pure helper: given the current subscriptions (or an existing
 * {@link SubscriptionsFile}), it builds the versioned root file shape that the
 * adapter serializes to a backup file. No I/O is performed here.
 *
 * Accepting either a `Subscription[]` or a `SubscriptionsFile` lets callers
 * pass whichever they have on hand; when a file is supplied its existing
 * `version` is preserved, otherwise {@link BACKUP_SCHEMA_VERSION} is used.
 *
 * @param source - The subscriptions array, or a full subscriptions file.
 * @returns A {@link SubscriptionsFile} ready to be serialized as a backup.
 */
export function assembleBackupPayload(
  source: Subscription[] | SubscriptionsFile,
): SubscriptionsFile {
  if (Array.isArray(source)) {
    return {
      version: BACKUP_SCHEMA_VERSION,
      subscriptions: [...source],
    };
  }
  return {
    version: source.version,
    subscriptions: [...source.subscriptions],
  };
}
