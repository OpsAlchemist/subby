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
