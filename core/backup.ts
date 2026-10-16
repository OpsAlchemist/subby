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

import type { SettingsV2 } from "./models/settings";
import type {
  Subscription,
  SubscriptionsFile,
  SubscriptionV2,
} from "./models/subscription";

// --- Scheduled-backup cadence (Story 7.3) ------------------------------------

/** Milliseconds in a day — the `"daily"` scheduled-backup period. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds in a week — the `"weekly"` scheduled-backup period. */
export const WEEK_MS = 7 * DAY_MS;

/**
 * Decide whether a routine (SCHEDULED) backup is DUE (Story 7.3). PURE — reads
 * NO ambient clock: it parses only the injected `nowIso`/`lastBackupAt` ISO
 * instants (never `Date.now()` / argless `new Date()`), so it is deterministic
 * and offset-independent (an elapsed-instant comparison, not a local-day bucket).
 *
 * This is the SCHEDULED cadence cap only — the manual "Back up now" action
 * ALWAYS backs up and bypasses this predicate. The decision table:
 *   - `"off"`                       → `false` (routine backups disabled)
 *   - `lastBackupAt === null`       → `true`  (never backed up → due)
 *   - `elapsed` is `NaN`
 *     (unparseable `lastBackupAt`)  → `true`  (safe over-backup; re-stamped valid
 *                                              on the next backup. NOTE: the only
 *                                              callers pass a schema-validated
 *                                              `lastBackupAt` — a valid ISO instant
 *                                              or null — and a `nowIso` from
 *                                              `new Date().toISOString()`, so this
 *                                              branch is a defensive backstop, not
 *                                              a path the live app reaches.)
 *   - `elapsed < 0`
 *     (future `lastBackupAt`, skew) → `false` (no spurious backup on clock skew)
 *   - `"daily"`                     → `true` when `elapsed >= DAY_MS`
 *   - `"weekly"`                    → `true` when `elapsed >= WEEK_MS`
 *
 * where `elapsed = parse(nowIso) - parse(lastBackupAt)`.
 */
export function backupDue(
  frequency: SettingsV2["backupFrequency"],
  lastBackupAt: string | null,
  nowIso: string,
): boolean {
  if (frequency === "off") return false;
  if (lastBackupAt === null) return true;

  const elapsed = Date.parse(nowIso) - Date.parse(lastBackupAt);
  // Unparseable last-backup (or now) → NaN elapsed: over-backup (self-heals on
  // the next stamp). A future last-backup (negative elapsed, clock skew) → not due.
  if (Number.isNaN(elapsed)) return true;
  if (elapsed < 0) return false;

  return frequency === "daily" ? elapsed >= DAY_MS : elapsed >= WEEK_MS;
}

/**
 * Current on-disk schema version for the subscriptions backup payload when
 * assembling from a bare array (no source `version` to preserve).
 *
 * Matches the live data file version (now 2, Story 3.3) so a backup taken from
 * the current subscriptions set round-trips at the live schema. When a full
 * file is supplied its own `version` is preserved instead (a RAW v1 pre-
 * migration snapshot keeps `version: 1`).
 */
export const BACKUP_SCHEMA_VERSION = 2;

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
 * Accepting either a subscriptions array or a full subscriptions file lets
 * callers pass whichever they have on hand; when a file is supplied its existing
 * `version` is preserved, otherwise {@link BACKUP_SCHEMA_VERSION} is used.
 *
 * Version-agnostic over the subscription element shape: the live v2 adapter
 * passes `SubscriptionV2[]` / a v2 file, while the pre-migration backup passes a
 * RAW v1 file (whose `version: 1` is preserved). The payload is a plain
 * `{ version, subscriptions }` record either way; the element type is carried
 * through generically so no casting is needed at the call sites.
 *
 * @param source - The subscriptions array, or a full subscriptions file.
 * @returns A `{ version, subscriptions }` payload ready to be serialized.
 */
export function assembleBackupPayload<
  TSub extends Subscription | SubscriptionV2,
>(
  source: TSub[] | { version: number; subscriptions: TSub[] },
): { version: number; subscriptions: TSub[] } {
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

/** Compatibility re-export: {@link SubscriptionsFile} shape kept for callers. */
export type { SubscriptionsFile };
