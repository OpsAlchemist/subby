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
