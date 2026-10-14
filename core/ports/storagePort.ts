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

import type { Category } from "../models/category";
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

  // Backups
  createBackup(reason: string): Promise<string>; // returns backup filename
  listBackups(): Promise<string[]>;
  readBackup(name: string): Promise<SubscriptionsFileV2>;

  // Data folder (Req 15.3)
  getDataFolder(): string;
  setDataFolder(path: string | null): Promise<void>;
}
