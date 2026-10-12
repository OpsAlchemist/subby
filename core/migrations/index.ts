/**
 * Migration dispatch (AD-15 / FR-29).
 *
 * Platform-independent and pure (AD-1): no `electron`/`react`/`fs`, no
 * wall-clock, no filesystem. This is the single entry Story 1.4's storage
 * adapter calls after it has read a raw file and detected its `version`.
 *
 * `migrate(file, fromVersion)`:
 *   - chains the known upgrade steps to the **current** schema version
 *     (today: v1 -> v2; room for v2 -> v3 later), and
 *   - **no-ops** an already-current file (`fromVersion === SCHEMA_VERSION`):
 *     the file is returned unchanged.
 *
 * The migrator owns only known **upgrade** steps. An unknown/older-than-known
 * or a *newer* `fromVersion` is the caller's concern: Story 1.4 refuses a newer
 * file with a typed error and never downgrades. Here, an unhandled version is a
 * loud `MigrationError`, never a silent pass or a partial result.
 */

import {
  migrateSubscriptionsFileV1toV2,
  migrateSettingsFileV1toV2,
  MigrationError,
} from "core/migrations/v1_to_v2";
import type { SubscriptionsFile, SubscriptionsFileV2 } from "core/models/subscription";
import type { SettingsFile, SettingsFileV2 } from "core/models/settings";

export { MigrationError } from "core/migrations/v1_to_v2";
export {
  migrateSubscriptionV1toV2,
  migrateSettingsV1toV2,
  migrateSubscriptionsFileV1toV2,
  migrateSettingsFileV1toV2,
  migrateAmountToMinor,
  roundHalfUpToExponent,
} from "core/migrations/v1_to_v2";

/**
 * The current on-disk schema version. The single source every migration step
 * and the no-op check agree on; bumping it (plus adding the vN-1 -> vN step in
 * {@link migrate}) is how a future schema version lands.
 */
export const SCHEMA_VERSION = 2 as const;

/** The two whole-file shapes the migrator transforms. */
type SubscriptionsFileAny = SubscriptionsFile | SubscriptionsFileV2;
type SettingsFileAny = SettingsFile | SettingsFileV2;

/** Structural guard: a subscriptions file carries a `subscriptions` array. */
function isSubscriptionsFile(file: SubscriptionsFileAny | SettingsFileAny): file is SubscriptionsFileAny {
  return Array.isArray((file as { subscriptions?: unknown }).subscriptions);
}

/**
 * Migrate a whole `subscriptions.json` file to the current schema version,
 * chaining known upgrade steps and no-opping an already-current file.
 */
export function migrate(file: SubscriptionsFileAny, fromVersion: number): SubscriptionsFileV2;
/**
 * Migrate a whole `settings.json` file to the current schema version, chaining
 * known upgrade steps and no-opping an already-current file.
 */
export function migrate(file: SettingsFileAny, fromVersion: number): SettingsFileV2;
export function migrate(
  file: SubscriptionsFileAny | SettingsFileAny,
  fromVersion: number,
): SubscriptionsFileV2 | SettingsFileV2 {
  // `fromVersion` must agree with the file's own `version` field. Trusting a
  // caller-supplied version that disagrees would let `migrate(v1File, 2)`
  // no-op and return unvalidated v1 data masquerading as v2.
  if (file.version !== fromVersion) {
    throw new MigrationError(
      `fromVersion (${fromVersion}) does not match the file's own version (${file.version})`,
    );
  }

  // No-op: an already-current file is returned unchanged.
  if (fromVersion === SCHEMA_VERSION) {
    return file as SubscriptionsFileV2 | SettingsFileV2;
  }

  // Known upgrade step: v1 -> v2. (A future v2 -> v3 chains after this one.)
  if (fromVersion === 1) {
    return isSubscriptionsFile(file)
      ? migrateSubscriptionsFileV1toV2(file as SubscriptionsFile)
      : migrateSettingsFileV1toV2(file as SettingsFile);
  }

  // Any other version is not a known upgrade step. The caller (Story 1.4) owns
  // the newer-than-current refusal; here an unhandled version is a loud error.
  throw new MigrationError(
    `no migration path from version ${fromVersion} to ${SCHEMA_VERSION}`,
  );
}
