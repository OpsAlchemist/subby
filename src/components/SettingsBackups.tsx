/**
 * SettingsBackups — the Backups section for the Settings screen
 * (Story 7.3 + Story 7.4; FR-18, Req 18).
 *
 * Rendered as ONE `<SettingsSection title="Backups">` dropped into the Settings
 * scaffold via the Story-3.2 slot pattern (insert, don't restructure). It hosts,
 * top to bottom:
 *
 *   - BACKUP FREQUENCY (Story 7.3): the scheduled-cadence select, persisted
 *     through `settingsApi.update({ backupFrequency })`.
 *   - "BACK UP NOW" + "LAST BACKUP" (Story 7.3): a manual, non-destructive
 *     backup button (every press backs up — the at-most-once cap is scheduled-
 *     only) and the last routine-backup instant (an explicit "Never" when
 *     null/absent). Errors go to the global toast; disabled while in flight.
 *   - BACKUP HISTORY (Story 7.4): the newest-first list from `backupsStore`
 *     (the adapter already sorts newest-first). Each row shows the human,
 *     locale-formatted time derived from the file name via the pure
 *     `backupTimestamp` (falling back to the raw name when it is `null`, so an
 *     unparseable/legacy name stays visible AND restorable) and a "Restore"
 *     button. Restoring opens the shared branded {@link ConfirmDialog} (NEVER
 *     `window.confirm`) naming the exact impact and that a pre-restore backup is
 *     taken first (so restore is reversible); the safe/cancel option is the
 *     focus default. On confirm, `dataApi.restoreBackup(name)` runs; the store
 *     reload via the `evt:dataChanged` broadcast refreshes the history and every
 *     view. An IPC failure is normalized to an {@link AppError} and recorded for
 *     the global toast — the view never crashes. An empty history shows an
 *     explicit "No backups yet" state.
 *
 * All controls are labelled, keyboard-operable, and show visible focus rings.
 * The renderer stays sandboxed — only `window.subby` (via `@/api/subby`), stores,
 * and the pure `core/backup.backupTimestamp` display helper.
 */

import { useState } from "react";
import { RotateCcw, Save } from "lucide-react";

import type { SettingsV2 as SettingsModel } from "core/models/settings";
import { backupTimestamp } from "core/backup";
import { dataApi, settingsApi, toAppError } from "@/api/subby";
import { backupsStore } from "@/stores/backupsStore";
import { errorStore } from "@/stores/errorStore";
import { useStore, useStoreData } from "@/stores/hooks";
import { settingsStore } from "@/stores/settingsStore";
import { SettingsSection } from "@/components/SettingsSection";
import ConfirmDialog from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";

/** Shared focus-ring utility, consistent with the app shell (Req 22.1, 22.3). */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const SELECT_CLASS = `w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ${FOCUS_RING}`;

const BACKUP_FREQUENCIES: readonly {
  value: SettingsModel["backupFrequency"];
  label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/**
 * Format a backup file name for display: the locale-formatted instant when the
 * pure {@link backupTimestamp} can parse the name, otherwise the raw name (so an
 * unparseable/legacy name is never hidden — it stays visible and restorable).
 */
function formatBackup(name: string): string {
  const iso = backupTimestamp(name);
  return iso !== null ? new Date(iso).toLocaleString() : name;
}

export default function SettingsBackups(): JSX.Element {
  const { data: settings } = useStore(settingsStore);
  const backups = useStoreData(backupsStore);

  const [backingUp, setBackingUp] = useState(false);
  // The backup name awaiting a branded restore confirmation (null = closed).
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);

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

  /**
   * Take a routine backup immediately ("Back up now", Story 7.3). Non-destructive
   * (no confirm dialog). Any IPC failure is normalized to an {@link AppError} and
   * recorded for the global toast; the "Last backup" line and the history list
   * refresh via the `onDataChanged` broadcast the handler emits.
   */
  async function backUpNow(): Promise<void> {
    setBackingUp(true);
    try {
      await dataApi.createBackup();
    } catch (err) {
      errorStore.set(toAppError(err));
    } finally {
      setBackingUp(false);
    }
  }

  /**
   * Confirm a pending restore (Story 7.4). Calls `dataApi.restoreBackup(target)`;
   * the pre-restore backup is taken first by the service (restore is reversible),
   * and the `evt:dataChanged` broadcast reloads every store (including the
   * history). A failure routes to the global toast; the view never crashes.
   */
  async function confirmRestore(): Promise<void> {
    const target = restoreTarget;
    setRestoreTarget(null);
    if (target === null) return;
    try {
      await dataApi.restoreBackup(target);
    } catch (err) {
      errorStore.set(toAppError(err));
    }
  }

  return (
    <SettingsSection
      title="Backups"
      description="How often Subby creates an automatic backup, and the backups you can restore."
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

      {/*
        Last backup + manual "Back up now" (Story 7.3). The line reads
        settings.lastBackupAt (an explicit "Never" when null/absent); the button
        takes a routine backup every press (the at-most-once cap is scheduled-
        only). Non-destructive → no confirm dialog; errors go to the global
        toast; disabled while in flight.
      */}
      <div className="space-y-2">
        <span className="text-sm font-medium text-foreground">Last backup</span>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void backUpNow()}
            disabled={backingUp}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            Back up now
          </button>
          <span className="text-sm text-muted-foreground">
            {settings.lastBackupAt
              ? new Date(settings.lastBackupAt).toLocaleString()
              : "Never"}
          </span>
        </div>
      </div>

      {/*
        Backup history (Story 7.4) — newest-first from the backupsStore (the
        adapter already sorts newest-first). Each row shows the human time (or the
        raw name when unparseable) + a Restore button driving the branded confirm.
      */}
      <div className="space-y-2">
        <span className="text-sm font-medium text-foreground">
          Backup history
        </span>
        {backups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups yet</p>
        ) : (
          <ul className="space-y-2" aria-label="Backup history">
            {backups.map((name) => (
              <li
                key={name}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {formatBackup(name)}
                </span>
                <button
                  type="button"
                  aria-label={`Restore backup from ${formatBackup(name)}`}
                  onClick={() => setRestoreTarget(name)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/60",
                    FOCUS_RING,
                  )}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Branded in-app confirmation for restoring a backup. */}
      <ConfirmDialog
        open={restoreTarget !== null}
        title="Restore this backup?"
        message={
          restoreTarget !== null
            ? `Replace all current subscriptions with the backup from ${formatBackup(
                restoreTarget,
              )}? Your current data is backed up first so you can undo this.`
            : ""
        }
        confirmLabel="Restore"
        onConfirm={() => void confirmRestore()}
        onCancel={() => setRestoreTarget(null)}
      />
    </SettingsSection>
  );
}

/** A label + control row with an accessible association (local copy of Field). */
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
