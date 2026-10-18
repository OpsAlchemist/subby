/**
 * Settings view (Story 3.2; Req 14, 15, 23).
 *
 * Renders the persisted {@link Settings} from {@link settingsStore} (via the
 * `useStore` hook, so the view re-renders whenever settings reload after a
 * mutation broadcast). Every control persists its change immediately through
 * `settingsApi.update(...)` (Req 15.2); the data-folder chooser uses the native
 * dialog via `settingsApi.chooseDataFolder()` and switches subsequent file ops
 * (Req 15.3). The store reload triggered by the resulting `onDataChanged`
 * broadcast keeps the UI in sync.
 *
 * Reworked onto {@link SettingsScaffold} / {@link SettingsSection} (the shared
 * section-insert primitive) with full capability parity: every v1 control —
 * Default currency, Notifications enable + the three Lead Times, Backup
 * frequency, Theme, Accent color, Tray Mode, and the Data folder chooser — is
 * still present and operable with its original accessible name, and each still
 * persists through `settingsApi.update(...)`. Later epics (Home Currency,
 * notifications/Tray, Backups, Online Features) append one `<SettingsSection>`
 * child through the scaffold — they never restructure the screen or add a route.
 *
 * The accent control is reconciled to the 1.0 Warm Graphite theme-token model
 * (DESIGN "one-accent-and-stop"): the accent is a per-theme token (ochre
 * `#92400e` light / amber `#f59e0b` dark — the `--accent` values in
 * `src/styles/globals.css`, applied by `applyAccent` in
 * `src/theme/themeManager.ts`), not a free user hex, so the v1 free-hex
 * `<input type="color">` showed a swatch that disagreed with the painted accent
 * in dark. The control now presents the two theme accents honestly as labelled
 * swatches — marking the one for the active theme as current — with a note that
 * the accent follows the active theme, while keeping the discoverable "Accent
 * color" grouping (parity). This closes the Story-3.1 deferred seam.
 *
 * Failures from the IPC bridge ({@link SubbyError}) are caught and recorded in
 * the global {@link errorStore} for a non-blocking toast — the view never
 * crashes (Req 19.4). The renderer stays sandboxed — this view imports only
 * `window.subby` (via `@/api/subby`), stores, and build-time constants; no
 * `fs`/`path`/`electron`.
 *
 * _Requirements: 15.1, 15.2, 15.3, 23.2, 23.3_
 */

import { useState } from "react";
import { FolderOpen } from "lucide-react";

import type {
  ReminderLeadTime,
  SettingsV2 as SettingsModel,
} from "core/models/settings";
import { settingsApi, toAppError } from "@/api/subby";
import { settingsStore } from "@/stores/settingsStore";
import { errorStore } from "@/stores/errorStore";
import { useStore } from "@/stores/hooks";
import { SettingsScaffold, SettingsSection } from "@/components/SettingsSection";
import SettingsCategories from "@/components/SettingsCategories";
import SettingsBackups from "@/components/SettingsBackups";
import {
  resolveTheme,
  type ResolvedTheme,
} from "@/theme/themeManager";

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

const THEMES: readonly { value: SettingsModel["theme"]; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

/**
 * The two Warm Graphite theme accents, shown honestly in the Accent control.
 * These are the per-theme `--accent` tokens (DESIGN: Colors) authored in
 * `src/styles/globals.css` and applied by `applyAccent` in
 * `src/theme/themeManager.ts` — ochre in light, amber in dark. The accent is a
 * theme token in 1.0, not a free user hex. `theme` keys each swatch to the
 * resolved appearance so the control can mark the active one as current.
 */
const THEME_ACCENTS: readonly {
  theme: ResolvedTheme;
  label: string;
  hex: string;
}[] = [
  { theme: "light", label: "Light", hex: "#92400e" }, // ochre
  { theme: "dark", label: "Dark", hex: "#f59e0b" }, // amber
];

/** Shared focus-ring + control styling tokens. */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const SELECT_CLASS =
  `w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ${FOCUS_RING}`;

export default function Settings(): JSX.Element {
  const { data: settings } = useStore(settingsStore);
  const [choosingFolder, setChoosingFolder] = useState(false);

  // The appearance currently painted (dark/light), so the accent swatch for the
  // active theme can be marked current — matching the token applyAccent paints.
  const activeTheme: ResolvedTheme = resolveTheme(settings.theme);

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
    <SettingsScaffold
      title="Settings"
      description="Configure application preferences. Changes are saved automatically."
    >
      {/* General */}
      <SettingsSection
        title="General"
        description="Default currency used when adding subscriptions."
      >
        <Field htmlFor="setting-currency" label="Default currency">
          <select
            id="setting-currency"
            className={SELECT_CLASS}
            value={settings.homeCurrency}
            onChange={(e) => void persist({ homeCurrency: e.target.value })}
          >
            {/* Ensure the current value is selectable even if not in the list. */}
            {!CURRENCIES.includes(settings.homeCurrency) && (
              <option value={settings.homeCurrency}>
                {settings.homeCurrency}
              </option>
            )}
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </SettingsSection>

      {/* Notifications */}
      <SettingsSection
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
      </SettingsSection>

      {/*
        Backups (Story 7.3 frequency + "Back up now" / "Last backup", Story 7.4
        restore history) — inserted via the section-insert slot pattern. Its own
        component (mirroring SettingsCategories) so Settings.tsx stays a thin host.
      */}
      <SettingsBackups />

      {/* Categories (Story 3.4) — inserted via the section-insert slot pattern. */}
      <SettingsCategories />

      {/* Appearance */}
      <SettingsSection
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

        {/*
          Accent color — reconciled to the Warm Graphite theme-token model.
          The accent is a per-theme token (ochre light / amber dark), not a free
          user hex, so instead of a misleading free-hex color input we present
          the two theme accents honestly as read-only labelled swatches with a
          note that the accent follows the active theme. The swatch for the
          active appearance is marked current (text + aria-current, not color
          alone) so the control reflects reality. The group keeps the "Accent
          color" accessible name so the control stays discoverable.
        */}
        <div
          className="max-w-sm space-y-2"
          role="group"
          aria-label="Accent color"
        >
          <span className="block text-sm font-medium text-foreground">
            Accent color
          </span>
          <div className="flex items-center gap-4">
            {THEME_ACCENTS.map(({ theme, label, hex }) => {
              const current = theme === activeTheme;
              return (
                <span
                  key={label}
                  aria-current={current ? "true" : undefined}
                  className={`inline-flex items-center gap-2 text-sm ${
                    current
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-5 w-5 rounded-md border border-border ${
                      current ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""
                    }`}
                    style={{ backgroundColor: hex }}
                  />
                  {label}
                  {current && " (current)"}
                </span>
              );
            })}
          </div>
          <p className="text-sm text-muted-foreground">
            The accent follows the active theme — ochre in light, amber in dark.
          </p>
        </div>
      </SettingsSection>

      {/* System */}
      <SettingsSection
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
      </SettingsSection>

      {/*
        Online Features (Story 8.2; FR-25, AD-22) — the ONE place every
        network-using capability is listed, each off by default. Each feature's
        always-visible data-exposure notice sits ABOVE its switch and is wired to
        the switch via `aria-describedby`, so the disclosure is announced WITH the
        control and is readable BEFORE it is enabled. Enabling only persists
        `settings.online.*` through the existing optimistic `persist` path — the
        UI awaits no fetch and spawns no enrichment here (that is Stories
        8.4–8.6). Recipient names mirror `electron/net/hosts.ts` (FEATURE_HOSTS).
      */}
      <SettingsSection
        title="Online Features"
        description="Everything here is off by default. Each feature says what leaves your device before you turn it on."
      >
        <div className="space-y-2">
          <p
            id="online-logos-notice"
            className="text-sm text-muted-foreground"
          >
            Over time this reveals the full set of services you track to Google
            (t2.gstatic.com), linked to your IP address.
          </p>
          <Toggle
            id="setting-online-logos"
            label="Fetch brand logos for services Subby doesn't bundle"
            describedBy="online-logos-notice"
            checked={settings.online.liveLogoFetch}
            onChange={(checked) =>
              void persist({
                online: { ...settings.online, liveLogoFetch: checked },
              })
            }
          />
        </div>

        <div className="space-y-2">
          <p id="online-fx-notice" className="text-sm text-muted-foreground">
            Fetches the whole exchange-rate table from Frankfurter
            (api.frankfurter.dev), at most once a day. Reveals nothing about
            which currencies or subscriptions you track.
          </p>
          <Toggle
            id="setting-online-fx"
            label="Refresh exchange rates"
            describedBy="online-fx-notice"
            checked={settings.online.fxRefresh}
            onChange={(checked) =>
              void persist({
                online: { ...settings.online, fxRefresh: checked },
              })
            }
          />
        </div>
      </SettingsSection>

      <AttributionFooter />
    </SettingsScaffold>
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

/**
 * An accessible switch-style boolean toggle backed by a checkbox.
 *
 * `description` (when provided WITHOUT `describedBy`) is rendered inside the
 * `<label>` and so becomes part of the switch's accessible NAME — the right
 * shape for a terse helper line like the tray hint.
 *
 * `describedBy` wires the switch to an EXTERNAL element via `aria-describedby`
 * so that element is announced as a *description* alongside the name, not folded
 * into it (Story 8.2: the Online Features exposure notice must be a description
 * the user can read before enabling, with the name being just feature + state).
 * The caller owns and renders that element (an always-visible `<p id>` sibling);
 * when `describedBy` is set, no `description` is folded into the name.
 */
function Toggle({
  id,
  label,
  description,
  describedBy,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  describedBy?: string;
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
        {!describedBy && description && (
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
          aria-describedby={describedBy}
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
