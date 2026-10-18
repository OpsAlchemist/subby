/**
 * About view (Story 3.2; Req 23; ECB attribution reworked for Story 8.6).
 *
 * Presents the product name "Subby" and the tagline
 * "Take control of your subscriptions." (Req 23.1), the ECB exchange-rate
 * attribution, an app-version line read from the build-time {@link APP_VERSION}
 * constant, and non-intrusive attribution to Mr. K, the handle @KubeMonk, and the
 * organization OpsAlchemist (Req 23.2, 23.3).
 *
 * ECB attribution (Story 8.6 — truthful with FX refresh available): the rates are
 * bundled with the app and used offline BY DEFAULT, and the optional opt-in FX
 * refresh (when enabled in Settings → Online Features) updates them from the ECB
 * via Frankfurter. The copy MUST NOT claim an unconditional "no network request is
 * ever made" — that is only true while the toggle is off. The shown "as of" date
 * reflects the EFFECTIVE snapshot (bundle or the fresher refresh override),
 * fetched over the read-only `fx:snapshot` IPC and re-read on `evt:dataChanged`
 * so a refresh swap-in updates it; it degrades to a neutral line when unavailable.
 *
 * Reworked onto {@link SettingsScaffold} / {@link SettingsSection}: each panel is
 * a labelled landmark section hosted through the shared section-insert primitive.
 *
 * The renderer stays sandboxed — this view imports only build-time constants, the
 * read-only FX bridge, and the settings store; no `fs`/`path`/`electron`.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";

import { SettingsScaffold, SettingsSection } from "@/components/SettingsSection";
import { getFxSnapshotSafe, onDataChanged } from "@/api/subby";
import { settingsStore } from "@/stores/settingsStore";
import { useStoreData } from "@/stores/hooks";
import { APP_VERSION } from "@/version";

/** Format an ISO date (`YYYY-MM-DD`) for display, falling back to the raw value. */
function formatDate(iso: string): string {
  // Parse `YYYY-MM-DD` as LOCAL midnight (append `T00:00:00`), not the bare string
  // — `new Date("YYYY-MM-DD")` is UTC midnight, which `toLocaleDateString` would
  // render as the PREVIOUS day for users west of UTC. The effective snapshot's
  // `asOf` is always `YYYY-MM-DD`; anything else falls back to the raw value.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T00:00:00`)
    : new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Fetch the EFFECTIVE FX snapshot's `asOf` for the current Home Currency, and
 * re-fetch on `onDataChanged` so an opt-in refresh that writes a fresher override
 * updates the shown date (the override is transparent — same `RateSnapshot`).
 * Resolves to `null` when rates are unavailable (missing/corrupt bundle + no
 * override); the About copy then omits the date rather than asserting a wrong one.
 */
function useEffectiveAsOf(homeCurrency: string): string | null {
  const [asOf, setAsOf] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void getFxSnapshotSafe(homeCurrency).then((snapshot) => {
        if (!cancelled) setAsOf(snapshot?.asOf ?? null);
      });
    };
    load();
    // Re-read when any data changes (an FX refresh broadcasts evt:dataChanged
    // after writing the override — the same path the stores reload through).
    const off = onDataChanged(load);
    return () => {
      cancelled = true;
      off();
    };
  }, [homeCurrency]);

  return asOf;
}

export default function About(): JSX.Element {
  const settings = useStoreData(settingsStore);
  const asOf = useEffectiveAsOf(settings.homeCurrency);

  return (
    <SettingsScaffold title="About" description="About Subby.">
      <SettingsSection title="Subby">
        <div className="flex items-center gap-3">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-foreground"
            aria-hidden="true"
          >
            <Wallet className="h-6 w-6" />
          </span>
          <div>
            <p className="text-3xl font-bold tracking-tight text-foreground">
              Subby
            </p>
            <p className="text-lg text-muted-foreground">
              Take control of your subscriptions.
            </p>
          </div>
        </div>

        <p className="max-w-prose text-sm text-muted-foreground">
          A privacy-first subscription tracker. Your data stays on your device —
          no accounts, no tracking, no cloud.
        </p>

        <p className="text-sm text-muted-foreground">
          Version <span className="font-medium text-foreground">{APP_VERSION}</span>
        </p>
      </SettingsSection>

      <SettingsSection title="Exchange rates">
        <p className="max-w-prose text-sm text-muted-foreground">
          European Central Bank (ECB) euro foreign exchange reference rates
          {asOf !== null ? (
            <>
              , as of{" "}
              <span className="font-medium text-foreground">
                {formatDate(asOf)}
              </span>
            </>
          ) : null}
          . Rates are bundled with the app and used offline by default. When you
          enable “Refresh exchange rates” in Settings, Subby updates them from the
          ECB via Frankfurter (api.frankfurter.dev) at most once a day; it fetches
          the whole rate table, revealing nothing about which currencies or
          subscriptions you track.
        </p>
      </SettingsSection>

      <footer className="text-sm text-muted-foreground">
        <p>
          Crafted by{" "}
          <span className="font-medium text-foreground">Mr. K</span> (
          <span className="font-medium text-foreground">@KubeMonk</span>) at{" "}
          <span className="font-medium text-foreground">OpsAlchemist</span>.
        </p>
      </footer>
    </SettingsScaffold>
  );
}
