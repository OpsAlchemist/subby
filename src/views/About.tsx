/**
 * About view (task 26.1, Req 23).
 *
 * Presents the product name "Subby" and the tagline
 * "Take control of your subscriptions." (Req 23.1), with non-intrusive
 * attribution to Mr. K, the handle @KubeMonk, and the organization OpsAlchemist
 * (Req 23.2, 23.3). Static, display-only content — no data access.
 *
 * _Requirements: 23.1, 23.2, 23.3_
 */

import { Wallet } from "lucide-react";

export default function About(): JSX.Element {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">About</h2>
        <p className="text-muted-foreground">About Subby.</p>
      </header>

      <section
        aria-label="Subby"
        className="space-y-4 rounded-lg border border-border bg-card p-8 text-card-foreground"
      >
        <div className="flex items-center gap-3">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-foreground"
            aria-hidden="true"
          >
            <Wallet className="h-6 w-6" />
          </span>
          <div>
            <h3 className="text-3xl font-bold tracking-tight">Subby</h3>
            <p className="text-lg text-muted-foreground">
              Take control of your subscriptions.
            </p>
          </div>
        </div>

        <p className="max-w-prose text-sm text-muted-foreground">
          A privacy-first subscription tracker. Your data stays on your device —
          no accounts, no tracking, no cloud.
        </p>
      </section>

      <section
        aria-label="Exchange rate attribution"
        className="space-y-2 rounded-lg border border-border bg-card p-6 text-card-foreground"
      >
        <h3 className="text-sm font-semibold">Exchange rates</h3>
        <p className="max-w-prose text-sm text-muted-foreground">
          European Central Bank (ECB) euro foreign exchange reference rates, as
          of Oct 1, 2026. Rates are bundled with the app and used offline — no
          network request is ever made.
        </p>
      </section>

      <footer className="text-sm text-muted-foreground">
        <p>
          Crafted by{" "}
          <span className="font-medium text-foreground">Mr. K</span> (
          <span className="font-medium text-foreground">@KubeMonk</span>) at{" "}
          <span className="font-medium text-foreground">OpsAlchemist</span>.
        </p>
      </footer>
    </div>
  );
}
