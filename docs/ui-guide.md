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
| Settings | `Settings.tsx` | Currency, notifications + lead times, backup frequency, theme, accent, Tray_Mode, data folder; persists each change. |
| About | `About.tsx` | Name, tagline, and attribution. |

All views derive their figures from `core/` functions (e.g. `core/analytics`,
`core/search`) rather than re-implementing logic, and re-render on data change.

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
