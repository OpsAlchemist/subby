/**
 * SettingsSection + SettingsScaffold — the Settings/About section-insert scaffold.
 *
 * ============================ SECTION-INSERT PATTERN ============================
 *
 * Settings and About are the two Epic-3 nav destinations (nav keys `settings` /
 * `about`, digits 5 / 6). They are a SINGLE stacked, scrolling column of titled
 * sections. Six later epics (Home Currency, notifications/Tray, Backups, Online
 * Features, and About's ECB attribution/version/donate) must each contribute a
 * titled panel to one of these two screens.
 *
 * The contract those epics build against is deliberately tiny:
 *
 *   INSERT, DON'T RESTRUCTURE.
 *
 * A later epic appends ONE `<SettingsSection title="…">…</SettingsSection>` child
 * in DOM reading order and nothing else:
 *
 *   <SettingsScaffold title="Settings" description="…">
 *     <SettingsSection title="General" description="Default currency…">…</SettingsSection>
 *     {/* Epic 2 appends here — insert, don't restructure: *\/}
 *     <SettingsSection title="Home Currency">{/* its own controls *\/}</SettingsSection>
 *   </SettingsScaffold>
 *
 * The primitive owns the section's spacing, resting-card elevation, and heading,
 * so inserting a new section NEVER re-lays-out its siblings and NEVER requires a
 * second Settings route (there is exactly one `settings` destination — do not add
 * a router or a sub-nav). Each `SettingsSection` is a landmark `<section>` whose
 * accessible name comes from its OWN visible heading via `aria-labelledby`
 * (heading id ↔ section wired here by `useId()`), so the slot is self-labelling —
 * a single source of truth for the section name, not a duplicated `aria-label`.
 *
 * Do NOT re-skin the card anatomy or add a brand hue per section; the scaffold is
 * the one documented slot pattern, and every section inherits the same Warm
 * Graphite resting-card surface. See `docs/ui-guide.md` → "Settings & About
 * section-insert pattern" for the developer-facing write-up.
 *
 * ==============================================================================
 */

import { useId } from "react";

/**
 * A single titled section in the Settings/About scaffold.
 *
 * Renders a landmark `<section>` whose accessible name is its own `<h3>` heading
 * (wired via a generated `aria-labelledby`), an optional description paragraph,
 * and the section's own controls. Owns the resting-card surface and vertical
 * rhythm so sibling sections stay independent — appending one never reflows the
 * layout contract.
 *
 * @param title       the section's visible heading AND its accessible name.
 * @param description optional helper text under the heading; omitted entirely
 *                    (no empty paragraph) when not provided.
 * @param children    the section's controls, in reading order.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-card"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-base font-semibold">
          {title}
        </h3>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * The host for a Settings/About screen: a page `<header>` with the screen title
 * (and optional description) above a single stacked, scrolling column that
 * renders its children in reading order. Children are normally
 * `SettingsSection`s, but a screen may also include a sanctioned non-section
 * element — e.g. the Settings/About attribution `<footer>` — rendered inline in
 * the same column.
 *
 * There is no sub-nav and no router — a later epic that needs a new panel adds
 * one `<SettingsSection>` child (see the SECTION-INSERT PATTERN block above),
 * never a second route.
 *
 * @param title       the screen title (e.g. "Settings", "About").
 * @param description optional one-line screen description under the title.
 * @param children    the screen's `SettingsSection`s (and any sanctioned
 *                    non-section element such as the attribution footer), in
 *                    reading order.
 */
export function SettingsScaffold({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-muted-foreground">{description}</p>}
      </header>
      {children}
    </div>
  );
}
