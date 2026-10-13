# UI Guide

The renderer is a single-window React + TypeScript app styled with TailwindCSS
and shadcn/ui-style CSS-variable tokens. It owns no file access — all data flows
through `window.subby` (see [IPC & Renderer API](./ipc-api.md)).

## Application shell (`src/App.tsx`)

- **Left navigation rail** — a labelled landmark (`<nav aria-label="Primary">`)
  with six items: Dashboard, List, Calendar, Analytics, Settings, About. Each is
  a keyboard-focusable button with a visible focus ring.
- **Top bar** — a Global Search trigger (with a Cmd/Ctrl-K affordance), a theme
  toggle button, and an "Add subscription" primary action.
- **Routing** — lightweight in-memory `useState` view switching (no router
  dependency), appropriate for Electron's single-file renderer. Calendar and
  Analytics are `React.lazy` + `Suspense` to protect cold-start.
- **Skip-navigation link** as the first tab stop; semantic `<header>`/`<nav>`/
  `<main>` landmarks.

## Views (`src/views/`)

| View | File | Purpose |
| --- | --- | --- |
| Dashboard | `Dashboard.tsx` | Metric cards (monthly/yearly/active), "renewing in 7 days", "recently changed". |
| Subscription List | `SubscriptionList.tsx` | Table/card layout; search, sort, filter, group, multi-select bulk actions, inline quick-edit. |
| Calendar | `CalendarView.tsx` (lazy) | Monthly grid with renewal indicators + per-day side panel. Pure grid helpers in `calendarGrid.ts`. |
| Analytics | `AnalyticsView.tsx` (lazy) | Monthly spend, category distribution, yearly projection, most-expensive, renewal timeline — inline SVG charts. |
| Settings | `Settings.tsx` | Currency, notifications + lead times, backup frequency, theme, accent, Tray_Mode, data folder; persists each change. Built on the section-insert scaffold (see below). |
| About | `About.tsx` | Name, tagline, ECB exchange-rate attribution, app version (`src/version.ts`), and author credit. Built on the same section-insert scaffold. |

All views derive their figures from `core/` functions (e.g. `core/analytics`,
`core/search`) rather than re-implementing logic, and re-render on data change.

## Settings & About section-insert pattern

Settings (nav key `settings`, digit `5`) and About (nav key `about`, digit `6`)
are the two Epic-3 nav destinations. Both are a **single stacked, scrolling
column of titled sections** built on the shared scaffold in
`src/components/SettingsSection.tsx`:

- **`SettingsScaffold`** — the page `<header>` (screen title + optional
  description) above the stacked column that renders its section children in
  reading order. No sub-nav, no router.
- **`SettingsSection`** — one titled panel. It renders a landmark `<section>`
  whose **accessible name is its own visible `<h3>` heading** (wired via a
  generated `aria-labelledby`), an optional description, and the section's own
  controls. It owns the resting-card surface and vertical rhythm.

Six later epics (Home Currency, notifications/Tray Mode, Backups, Online
Features, and About's attribution/version/donate) contribute panels to these two
screens. The contract they build against is deliberately small — **insert,
don't restructure**:

```tsx
<SettingsScaffold title="Settings" description="…">
  <SettingsSection title="General" description="Default currency…">…</SettingsSection>
  {/* A later epic appends ONE child in reading order: */}
  <SettingsSection title="Home Currency">{/* its own controls */}</SettingsSection>
</SettingsScaffold>
```

Rules for later epics:

1. **Append one `<SettingsSection title="…">` child** in reading order. The
   primitive gives it a labelled landmark + heading + spacing/elevation, so the
   insertion never re-lays-out sibling sections.
2. **Never create a second Settings route.** There is exactly one `settings`
   destination (and one `about`). Do not add a router or a two-column sub-nav.
3. **Don't re-skin the card anatomy or add a per-section brand hue** — every
   section inherits the same Warm Graphite resting-card surface.

The accent control in Settings presents the Warm Graphite accent **honestly as a
theme token** (ochre in light, amber in dark) rather than a free-hex color input:
the 1.0 accent follows the active theme (DESIGN "one-accent-and-stop"), so the
control shows the two theme accents with a note rather than a swatch that could
disagree with the painted accent.

The About version line reads from `src/version.ts` (`APP_VERSION`), which
re-exports a build-time `__APP_VERSION__` literal injected by Vite (`define` in
`electron.vite.config.ts` and `vitest.config.ts`) with a `"0.0.0-dev"` fallback.
This is a compile-time constant — no IPC, no `fs`/`electron` — so the renderer
sandbox stays intact.

## Components (`src/components/`)

- **`SubscriptionModal.tsx`** — a single accessible dialog for both create and
  edit. Edit mode pre-populates from the subscription; create mode pre-fills
  currency from `settings.defaultCurrency`. A custom-interval control appears
  only for the Custom billing cycle. Client validation mirrors
  `subscriptionSchema` with inline, field-named messages. Cancel/Escape/backdrop
  close without persisting.
- **`GlobalSearch.tsx`** — a Cmd/Ctrl-K command palette using
  `core/search.fuzzySearch`. Keyboard-first (arrows to move, Enter to select,
  Escape to close), `role="combobox"`/`listbox` semantics, empty query lists all.
- **`SettingsSection.tsx`** — `SettingsScaffold` + `SettingsSection`, the shared
  section-insert scaffold used by both Settings and About. See
  [Settings & About section-insert pattern](#settings--about-section-insert-pattern).

## Client stores (`src/stores/`)

Framework-light stores compatible with React's `useSyncExternalStore` — plain
TypeScript, so they're testable without a DOM.

- **`createStore.ts`** — a factory producing `{ subscribe, getSnapshot, load,
  reset }` with an immutable snapshot `{ data, loading, error, loaded }`.
  Overlapping loads are coalesced via a token.
- **`subscriptionsStore`, `categoriesStore`, `settingsStore`** — singletons,
  each fetching via the typed `src/api/subby.ts` wrapper.
- **`errorStore`** — captures the latest system `AppError` from `onError` for a
  global toast.
- **`index.ts` → `initStores()`** — subscribes to `onDataChanged` (reload all
  stores), subscribes to `onError` (record in `errorStore`), kicks off the
  initial load, and returns a teardown. Called once from `src/main.tsx`.
- **`hooks.ts`** — `useStore`, `useStoreData`, `useErrorState` adapters.

Because mutations broadcast `evt:dataChanged`, any change made through one view
reactively updates every view (Dashboard totals, list rows, calendar, etc.).

## Theming (`src/theme/themeManager.ts`)

- Theme tokens are CSS custom properties in `src/styles/globals.css`; Tailwind
  reads from them. Switching theme sets `data-theme="dark"|"light"` on `<html>`.
- `applyTheme`, `applyAccent`, `applySettingsTheme`, `resolveTheme`,
  `subscribeSystemTheme`, `initTheme` are all DOM-guarded and accept an
  injectable media-query provider for testing.
- `system` resolves via `prefers-color-scheme` and follows OS changes live.
- Dark is the first-run default; `index.html` ships `data-theme="dark"` so the
  very first paint is dark before settings load.
- The accent color writes the `--accent` CSS variable.

## Accessibility

- **Keyboard navigation** across all interactive elements with visible focus
  rings; a skip-to-content link.
- **Keyboard shortcuts** (suppressed while typing in a field or when a modal/
  search overlay is open):

  | Shortcut | Action |
  | --- | --- |
  | `N` | Open the Add subscription modal |
  | `Cmd/Ctrl + K` | Open Global Search |
  | `1`–`6` | Switch to Dashboard / List / Calendar / Analytics / Settings / About |

- **ARIA labels** on icon-only controls; charts carry visually-hidden text
  summaries as text alternatives.
- **High contrast** via a `@media (prefers-contrast: more)` block that
  strengthens border/foreground/ring tokens.
- **Scalable fonts** — `html { font-size: 100% }` plus rem-based Tailwind sizing
  so OS font scaling applies.

> Note: automated axe checks (jsdom) verify no serious/critical violations.
> Full WCAG conformance still requires manual testing with assistive technology.
