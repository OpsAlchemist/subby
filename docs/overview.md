# Overview

## What is Subby?

Subby is a desktop application for tracking recurring subscriptions (streaming,
SaaS, cloud hosting, memberships, etc.). It answers questions like *"how much am
I spending per month?"*, *"what renews this week?"*, and *"where is my money
going by category?"* — entirely on your own machine.

It is delivered first as an **Electron** desktop app, but its business logic is
deliberately platform-independent so the same core can later power Tauri, web
(PWA), or mobile builds.

## Design principles

Four principles drive every architectural decision:

1. **No database.** All persistent data is stored as human-readable JSON files
   in a per-platform application data directory. You own your data and can read,
   back up, or move it with ordinary tools.
2. **No network.** Subby is fully offline. There are no accounts, no telemetry,
   no analytics, no cloud sync, and no outbound requests of any kind. A renderer
   Content-Security-Policy and a process sandbox enforce this.
3. **Never crash on bad data.** Reads go through a safe parser that classifies
   failures (missing / malformed / corrupt) and recovers — recreating missing
   files from defaults and offering to restore corrupt data from a backup —
   instead of throwing.
4. **Portable core.** Billing, renewal, search, analytics, import/export, and
   backup logic are pure TypeScript with zero Electron/React/Node imports, so
   they are trivially testable and reusable on other platforms.

## Feature summary

- **Subscription management** — add, edit, delete, and activate/deactivate
  subscriptions with rich fields (provider, category, amount, billing cycle,
  renewal dates, payment method, color, icon, notes, and more).
- **Dashboard** — total monthly/yearly spend, active count, "renewing in 7
  days", and "recently changed".
- **Subscription list** — searchable, sortable, filterable, groupable table/card
  view with multi-select bulk actions and inline quick-edit.
- **Calendar** — a monthly grid with renewal indicators and a per-day detail
  panel.
- **Analytics** — monthly spend, category distribution, yearly projection,
  most-expensive list, and an upcoming renewal timeline, drawn with lightweight
  inline SVG charts.
- **Global fuzzy search** — a Cmd/Ctrl-K command palette that matches by
  subsequence on name or provider.
- **Notifications** — configurable desktop renewal reminders (same-day, one day
  before, three days before) that work offline.
- **Theming** — dark, light, and system themes with a configurable accent color.
- **Import / export** — JSON and CSV, with per-record validation and
  Replace/Merge/Skip conflict resolution.
- **Backups** — timestamped backups created automatically before destructive
  operations, with restore.
- **Settings** — currency, notification timing, backup frequency, theme, accent,
  Tray_Mode, and a custom data-folder location.
- **Accessibility** — keyboard navigation and shortcuts, ARIA labels, chart text
  alternatives, high-contrast support, and rem-based scalable fonts.

## Single-currency note (this build)

All monetary amounts are treated as a single currency (**INR**). Dashboard and
analytics totals sum amounts directly with no currency conversion. A
per-subscription `currency` field is retained for future multi-currency support,
which is deferred.

## Technology stack

| Concern | Choice |
| --- | --- |
| Desktop shell | Electron 33 (main + preload + renderer) |
| UI | React 18 + TypeScript (strict mode) |
| Build / dev | electron-vite (Vite 5), multi-target build |
| Styling | TailwindCSS 3.4 + shadcn/ui-style CSS-variable tokens |
| Icons | lucide-react |
| Validation | zod |
| Persistence | local JSON files (no DB) |
| Charts | hand-rolled inline SVG (no chart library) |
| Notifications | Electron `Notification` API |
| Theming | CSS variables + `prefers-color-scheme` |
| Testing | Vitest 2, fast-check 3 (property-based), Testing Library, jsdom, jest-axe |
| Packaging | electron-builder 24 (dmg/zip, nsis, AppImage/deb) |

See [Architecture](./architecture.md) for how these fit together.
