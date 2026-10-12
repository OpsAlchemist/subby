/**
 * App data path resolution (Req 1.1, 1.4).
 *
 * Electron MAIN process module. Node imports (`node:path`) and the Electron
 * `app` API are allowed here. The `App_Data_Directory` is resolved from the
 * per-platform `userData` directory (`~/.config/Subby` on Linux,
 * `~/Library/Application Support/Subby` on macOS, `AppData/Roaming/Subby` on
 * Windows) unless the user configured a custom data folder (Req 15.3).
 *
 * Testability: `resolveDataDir` takes the base `userData` directory as an
 * explicit parameter rather than calling `app.getPath('userData')` internally.
 * This keeps the function a pure string transform that can be unit-tested
 * without booting Electron. The storage adapter supplies the real value via
 * `app.getPath('userData')` at call time.
 */

/**
 * Canonical file names within the `App_Data_Directory` (Req 1.2, 1.3).
 */
export const fileNames = {
  subscriptions: "subscriptions.json",
  settings: "settings.json",
  categories: "categories.json",
  backupDir: "backup",
} as const;

/**
 * Resolve the active `App_Data_Directory`.
 *
 * @param override        The user-configured data folder (`settings.dataFolder`).
 *                        When non-null and non-empty, it wins (Req 15.3).
 * @param defaultUserData The platform `userData` directory, typically supplied
 *                        by the adapter as `app.getPath('userData')` (Req 1.1).
 *                        Electron already maps this to the correct per-platform
 *                        Roaming / Application Support / .config location.
 * @returns The directory in which Subby's JSON files and `backup/` live.
 */
export function resolveDataDir(
  override: string | null,
  defaultUserData: string,
): string {
  if (override !== null && override.trim() !== "") {
    return override;
  }
  return defaultUserData;
}

/**
 * A pure predicate deciding whether a data directory is a **synced cloud path**
 * (iCloud / Dropbox / Google Drive / OneDrive / …) — the detection half of the
 * cloud-folder safe-read guardrail (AD-31, Story 1.7).
 *
 * The contract is deliberately narrow and pure (AD-1): a single directory string
 * in, a boolean out. No wall-clock, no network, no filesystem probe — it must be
 * a synchronous string classification so the storage adapter can consult it on
 * every read without introducing I/O or non-determinism into the hot path.
 */
export type CloudPathPredicate = (dir: string) => boolean;

/**
 * The **safe-default** cloud-path predicate: a no-op that classifies **no path**
 * as a cloud path (AD-31; PRD Q7 explicitly deferred).
 *
 * This is the shipped default behind the storage adapter's `isCloudPath` seam.
 * With this predicate in place the cloud guardrail is **dormant** and production
 * behavior is byte-identical to before Story 1.7: a missing file is recreated
 * with defaults exactly as today, because no path is ever treated as cloud-synced.
 *
 * ---------------------------------------------------------------------------
 * PRD Q7 PLACEHOLDER — real per-OS cloud-path detection goes HERE (not shipped).
 * ---------------------------------------------------------------------------
 * The *mechanism* for recognizing a synced path (how an iCloud / Dropbox / Drive
 * / OneDrive directory is identified across macOS / Windows / Linux) is an open
 * product decision (PRD §15 Q7) and is intentionally NOT implemented in this
 * story. When Q7 resolves, the real per-OS detector replaces this stub behind the
 * exact same `CloudPathPredicate` seam — the storage adapter, the guardrail logic,
 * and the wiring do not change; only this one function is swapped. Defaulting to
 * "never a cloud path" is the correct safe default: a false negative merely leaves
 * the extra protection the app never had turned off, whereas a false positive
 * would wrongly block legitimate recreate-on-missing — so we err toward never
 * guarding until a vetted rule exists.
 *
 * Do NOT hardcode path substrings here as the shipped default (the "Never" rule
 * in the spec's Boundaries & Constraints).
 */
export const defaultIsCloudPath: CloudPathPredicate = () => false;
