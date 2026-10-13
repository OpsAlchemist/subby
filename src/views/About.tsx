/**
 * About view (Story 3.2; Req 23).
 *
 * Presents the product name "Subby" and the tagline
 * "Take control of your subscriptions." (Req 23.1), the Story-2.3 ECB
 * exchange-rate attribution placeholder, an app-version line read from the
 * build-time {@link APP_VERSION} constant, and non-intrusive attribution to
 * Mr. K, the handle @KubeMonk, and the organization OpsAlchemist (Req 23.2,
 * 23.3). Static, display-only content — no data access.
 *
 * Reworked onto {@link SettingsScaffold} / {@link SettingsSection}: each panel is
 * a labelled landmark section hosted through the shared section-insert primitive
 * (see `SettingsSection.tsx`). The single ECB attribution section lives here —
 * it is NOT duplicated; later epics (Home Currency's attribution, donate link)
 * insert additional sections through the same scaffold.
 *
 * The renderer stays sandboxed — this view imports only build-time constants and
 * no `fs`/`path`/`electron`.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */

import { Wallet } from "lucide-react";

import { SettingsScaffold, SettingsSection } from "@/components/SettingsSection";
import { APP_VERSION } from "@/version";

export default function About(): JSX.Element {
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
          European Central Bank (ECB) euro foreign exchange reference rates, as
          of Oct 1, 2026. Rates are bundled with the app and used offline — no
          network request is ever made.
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
