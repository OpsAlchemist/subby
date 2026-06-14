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
 * Generate a timestamped backup file name of the form `YYYY-MM-DD-HH-MM.json`
 * (Req 18.1).
 *
 * Time zone choice: components are derived in **UTC** (via the `getUTC*`
 * accessors). UTC is chosen deliberately so the function is deterministic and
 * independent of the host machine's local time zone, which keeps `core/` pure
 * and its tests stable regardless of where they run. The Electron adapter is
 * responsible only for placing the resulting file inside the `backup/`
 * subdirectory.
 *
 * All components are zero-padded:
 *   - year   -> 4 digits
 *   - month  -> 2 digits (01–12; `getUTCMonth()` is 0-based, so +1)
 *   - day    -> 2 digits (01–31)
 *   - hour   -> 2 digits (00–23)
 *   - minute -> 2 digits (00–59)
 *
 * @param now - The instant to stamp the backup with.
 * @returns A file name such as `2025-03-07-09-05.json`.
 */
export function backupFileName(now: Date): string {
  const year = pad(now.getUTCFullYear(), 4);
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  const hour = pad(now.getUTCHours());
  const minute = pad(now.getUTCMinutes());
  return `${year}-${month}-${day}-${hour}-${minute}.json`;
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
