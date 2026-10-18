/**
 * Storage port (Req 1.1, 2.1, 2.2).
 *
 * Platform-independent repository interface (the "port") defining read and
 * write operations for subscriptions, settings, and categories, plus backups
 * and data-folder management.
 *
 * MUST NOT import from `electron`, `react`, or Node's `fs`. The Electron
 * adapter (`JsonFileStorage`) implements this interface in the main process
 * using local JSON files; future Tauri / Web (PWA) / mobile backends provide
 * their own implementations without touching the core or the UI.
 */

import type { FxOverride } from "../fxSnapshot";
import type { Category } from "../models/category";
import type { ReminderLedger } from "../models/reminder";
import type { SettingsV2 } from "../models/settings";
import type {
  SubscriptionsFileV2,
  SubscriptionV2,
} from "../models/subscription";

export interface StoragePort {
  // Subscriptions (v2 live model — Story 3.3 cutover)
  readSubscriptions(): Promise<SubscriptionV2[]>;
  writeSubscriptions(subs: SubscriptionV2[]): Promise<void>;

  // Settings (v2: `homeCurrency` + the `online` block — AD-22)
  readSettings(): Promise<SettingsV2>;
  writeSettings(settings: SettingsV2): Promise<void>;

  // Categories
  readCategories(): Promise<Category[]>;
  writeCategories(categories: Category[]): Promise<void>;

  // Reminder ledger (Epic 4): the persisted, versioned exactly-once dedupe
  // memory for fired reminders. `readReminderLedger` degrades a missing/corrupt/
  // transiently-unreadable file to a fresh empty ledger (see the adapter for the
  // amended recovery policy — only a MISSING file is ever recreated on read). The
  // one case it does NOT degrade is a file whose `version` is NEWER than the
  // current ledger version: that THROWS `StorageNewerVersionError` and leaves the
  // file untouched (never downgrade-overwrite).
  readReminderLedger(): Promise<ReminderLedger>;
  writeReminderLedger(ledger: ReminderLedger): Promise<void>;

  // FX refresh override (Epic 8, Story 8.6 — AD-23): the optional, opt-in
  // Data-Folder `fx-snapshot.json` written by the EnrichmentService (the SOLE
  // writer) when `fxRefresh` is on. JSON, through the port (unlike the logo blob
  // cache, AD-13). `readFxOverride` DEGRADES a missing/corrupt/transiently-
  // unreadable override to `null` (the bundle still totals), never throwing — a
  // malformed override is "no override", not a crash. `writeFxOverride` validates
  // LOUDLY (a bad rate throws) and writes atomically under the settings-family
  // lock, so there is a single serialized writer and no torn mid-write read.
  readFxOverride(): Promise<FxOverride | null>;
  writeFxOverride(override: FxOverride): Promise<void>;

  // Backups
  createBackup(reason: string): Promise<string>; // returns backup filename
  listBackups(): Promise<string[]>;
  readBackup(name: string): Promise<SubscriptionsFileV2>;

  // Data folder (Req 15.3)
  getDataFolder(): string;
  setDataFolder(path: string | null): Promise<void>;
}
