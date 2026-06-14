/**
 * Settings view (task 26.1, Req 14, 15, 23).
 *
 * Renders the persisted {@link Settings} from {@link settingsStore} (via the
 * `useStore` hook, so the view re-renders whenever settings reload after a
 * mutation broadcast). Every control persists its change immediately through
 * `settingsApi.update(...)` (Req 15.2); the data-folder chooser uses the native
 * dialog via `settingsApi.chooseDataFolder()` and switches subsequent file ops
 * (Req 15.3). The store reload triggered by the resulting `onDataChanged`
 * broadcast keeps the UI in sync.
 *
 * Failures from the IPC bridge ({@link SubbyError}) are caught and recorded in
 * the global {@link errorStore} for a non-blocking toast — the view never
 * crashes (Req 19.4).
 *
 * A non-intrusive footer credits the author (Req 23.2, 23.3).
 *
 * _Requirements: 15.1, 15.2, 15.3, 23.2, 23.3_
 */

import { useState } from "react";
import { FolderOpen } from "lucide-react";

import type {
  ReminderLeadTime,
  Settings as SettingsModel,
} from "core/models/settings";
import { settingsApi, toAppError } from "@/api/subby";
import { settingsStore } from "@/stores/settingsStore";
import { errorStore } from "@/stores/errorStore";
import { useStore } from "@/stores/hooks";

/** Currency options for this build (default INR, Req 6.3). */
const CURRENCIES: readonly string[] = [
  "INR",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "SGD",
];

/** Lead-time checkbox options in display order (Req 13.1). */
const LEAD_TIMES: readonly { value: ReminderLeadTime; label: string }[] = [
  { value: "same-day", label: "Same day" },
  { value: "one-day", label: "One day before" },
  { value: "three-days", label: "Three days before" },
];

const BACKUP_FREQUENCIES: readonly {
  value: SettingsModel["backupFrequency"];
  label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const THEMES: readonly { value: SettingsModel["theme"]; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

/** Shared focus-ring + control styling tokens. */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const SELECT_CLASS =
  `w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ${FOCUS_RING}`;

export default function Settings(): JSX.Element {
  const { data: settings } = useStore(settingsStore);
  const [choosingFolder, setChoosingFolder] = useState(false);

  /**
   * Persist a settings patch (Req 15.2). Any IPC failure is normalized to an
   * {@link AppError} and recorded for the global toast instead of throwing.
   */
  async function persist(patch: Partial<SettingsModel>): Promise<void> {
    try {
      await settingsApi.update(patch);
    } catch (err) {
      errorStore.set(toAppError(err));
    }
  }

  /** Toggle a single reminder lead time on/off (Req 13.1). */
  function toggleLeadTime(value: ReminderLeadTime, checked: boolean): void {
    const current = settings.notification.leadTimes;
    const next = checked
      ? Array.from(new Set([...current, value]))
      : current.filter((lt) => lt !== value);
    void persist({
      notification: { ...settings.notification, leadTimes: next },
    });
  }

  /** Open the native folder dialog and switch the data folder (Req 15.3). */
  async function chooseFolder(): Promise<void> {
    setChoosingFolder(true);
    try {
      // The native dialog persists the new folder and resolves with the
      // updated Settings (or null if the user cancelled). The store reloads via
      // the onDataChanged broadcast, so no manual state update is needed here.
      await settingsApi.chooseDataFolder();
    } catch (err) {
      errorStore.set(toAppError(err));
    } finally {
      setChoosingFolder(false);
    }
  }

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">
          Configure application preferences. Changes are saved automatically.
        </p>
      </header>

      {/* General */}
      <Section
        title="General"
        description="Default currency used when adding subscriptions."
      >
        <Field htmlFor="setting-currency" label="Default currency">
          <select
            id="setting-currency"
            className={SELECT_CLASS}
            value={settings.defaultCurrency}
            onChange={(e) => void persist({ defaultCurrency: e.target.value })}
          >
            {/* Ensure the current value is selectable even if not in the list. */}
            {!CURRENCIES.includes(settings.defaultCurrency) && (
              <option value={settings.defaultCurrency}>
                {settings.defaultCurrency}
              </option>
            )}
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {/* Notifications */}
      <Section
        title="Notifications"
        description="Desktop reminders before a subscription renews."
      >
        <Toggle
          id="setting-notifications-enabled"
          label="Enable renewal reminders"
          checked={settings.notification.enabled}
          onChange={(checked) =>
            void persist({
              notification: { ...settings.notification, enabled: checked },
            })
          }
        />

        <fieldset
          className="space-y-2 disabled:opacity-50"
          disabled={!settings.notification.enabled}
        >
          <legend className="text-sm font-medium text-foreground">
            Reminder lead times
          </legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            {LEAD_TIMES.map(({ value, label }) => {
              const id = `setting-leadtime-${value}`;
              return (
                <label
                  key={value}
                  htmlFor={id}
                  className="inline-flex items-center gap-2 text-sm text-foreground"
                >
                  <input
                    id={id}
                    type="checkbox"
                    className={`h-4 w-4 rounded border-input accent-accent ${FOCUS_RING}`}
                    checked={settings.notification.leadTimes.includes(value)}
                    onChange={(e) => toggleLeadTime(value, e.target.checked)}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>
      </Section>

      {/* Backups */}
      <Section
        title="Backups"
        description="How often Subby creates an automatic backup."
      >
        <Field htmlFor="setting-backup" label="Backup frequency">
          <select
            id="setting-backup"
            className={SELECT_CLASS}
            value={settings.backupFrequency}
            onChange={(e) =>
              void persist({
                backupFrequency: e.target
                  .value as SettingsModel["backupFrequency"],
              })
            }
          >
            {BACKUP_FREQUENCIES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {/* Appearance */}
      <Section
        title="Appearance"
        description="Theme and accent color for the interface."
      >
        <Field htmlFor="setting-theme" label="Theme">
          <select
            id="setting-theme"
            className={SELECT_CLASS}
            value={settings.theme}
            onChange={(e) =>
              void persist({ theme: e.target.value as SettingsModel["theme"] })
            }
          >
            {THEMES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field htmlFor="setting-accent" label="Accent color">
          <div className="flex items-center gap-3">
            <input
              id="setting-accent"
              type="color"
              className={`h-9 w-16 cursor-pointer rounded-md border border-input bg-background ${FOCUS_RING}`}
              value={settings.accentColor}
              onChange={(e) => void persist({ accentColor: e.target.value })}
            />
            <span className="text-sm text-muted-foreground">
              {settings.accentColor}
            </span>
          </div>
        </Field>
      </Section>

      {/* System */}
      <Section
        title="System"
        description="Background behavior and where your data is stored."
      >
        <Toggle
          id="setting-tray-mode"
          label="Keep running in the system tray"
          description="Lets renewal reminders fire while the window is closed."
          checked={settings.trayMode}
          onChange={(checked) => void persist({ trayMode: checked })}
        />

        <div className="space-y-2">
          <span className="text-sm font-medium text-foreground">
            Data folder
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void chooseFolder()}
              disabled={choosingFolder}
              className={`inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 ${FOCUS_RING}`}
            >
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              Choose folder…
            </button>
            <span
              className="truncate text-sm text-muted-foreground"
              title={settings.dataFolder ?? "Default"}
            >
              {settings.dataFolder ?? "Default"}
            </span>
          </div>
        </div>
      </Section>

      <AttributionFooter />
    </div>
  );
}

/** A labelled settings group with a heading and helper text. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      aria-label={title}
      className="space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground"
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** A label + control row with an accessible association. */
function Field({
  htmlFor,
  label,
  children,
}: {
  htmlFor: string;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="max-w-sm space-y-2">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/** An accessible switch-style boolean toggle backed by a checkbox. */
function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center justify-between gap-4"
    >
      <span className="space-y-0.5">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        {description && (
          <span className="block text-sm text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      <span className="relative inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className={`peer sr-only ${FOCUS_RING}`}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden="true"
          className="h-6 w-11 rounded-full bg-input transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
        />
        <span
          aria-hidden="true"
          className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5"
        />
      </span>
    </label>
  );
}

/** Non-intrusive authorship attribution (Req 23.2, 23.3). */
function AttributionFooter(): JSX.Element {
  return (
    <footer className="border-t border-border pt-4 text-xs text-muted-foreground">
      <p>
        Subby — crafted by Mr. K (
        <span className="font-medium">@KubeMonk</span>) at OpsAlchemist.
      </p>
    </footer>
  );
}
