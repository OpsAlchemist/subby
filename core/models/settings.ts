/**
 * Settings model (Req 15.1, 6.2, 6.3).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 */

export type ReminderLeadTime = "same-day" | "one-day" | "three-days";

export interface Settings {
  defaultCurrency: string; // "INR" for this build
  notification: {
    enabled: boolean;
    leadTimes: ReminderLeadTime[]; // any subset enabled
  };
  backupFrequency: "off" | "daily" | "weekly";
  theme: "dark" | "light" | "system";
  accentColor: string; // hex
  trayMode: boolean;
  dataFolder: string | null; // null = default App_Data_Directory
}

/**
 * Root file shape for `settings.json` (Req 1.2).
 * `settings.json` is the Settings object directly with a version field.
 */
export interface SettingsFile extends Settings {
  version: number;
}

// --- v2 shapes (additive; AD-22) ---------------------------------------------
// Added as new definitions; v1 `Settings` above stays unchanged. The renderer
// and storage keep using v1 until Epic 3/Story 1.4 flip them. No `version: 2`
// settings file is read or written on disk in this story.

/**
 * Opt-in online-feature toggles (AD-22). Every field defaults **false** and is
 * migrated in as all-false for existing users. This block is the single source
 * of truth the network gateway, the dynamic CSP, and the privacy test all key
 * off; a new online feature adds a field here (and in `net/hosts.ts`), nowhere
 * else.
 */
export interface OnlineSettingsV2 {
  liveLogoFetch: boolean; // fetch service logos from a provider
  fxRefresh: boolean; // refresh FX rates (≤1×/24h)
}

/**
 * v2 Settings (AD-22). Differences from v1:
 *   - `defaultCurrency` -> `homeCurrency` (the currency totals convert to).
 *   - adds the `online` toggle block (all-default-false).
 * All other fields carry over unchanged from v1.
 */
export interface SettingsV2 {
  homeCurrency: string; // Home Currency (replaces v1 defaultCurrency)
  notification: {
    enabled: boolean;
    leadTimes: ReminderLeadTime[];
  };
  backupFrequency: "off" | "daily" | "weekly";
  theme: "dark" | "light" | "system";
  accentColor: string; // hex
  trayMode: boolean;
  dataFolder: string | null; // null = default App_Data_Directory
  online: OnlineSettingsV2; // AD-22
}

/** Root file shape for `settings.json` under schema v2 (`version: 2`). */
export interface SettingsFileV2 extends SettingsV2 {
  version: 2;
}
