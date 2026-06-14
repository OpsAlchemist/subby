# Requirements

This is a human-readable summary of the functional requirements Subby
satisfies, grouped by area. Each area links conceptually to the code that
implements it; see the other docs for detail.

## 1. Local JSON storage

- All persistent data is stored as JSON files in the application data directory:
  `subscriptions.json`, `settings.json`, `categories.json`, plus a `backup/`
  subdirectory.
- On startup, missing directories and files are created and initialized with
  valid default content.
- The app operates without any database engine.

## 2. Platform-independent architecture

- A storage port defines platform-independent read/write operations.
- Business logic (billing, renewal, search, import, export, backup) is
  independent of the UI and platform.
- On Electron, the main process performs all file I/O; the renderer requests
  data operations over IPC and never touches the filesystem directly.

## 3–4. Subscription management & the Add/Edit modal

- Add, edit, delete, and toggle-active subscriptions, each persisted.
- A subscription has: id, name, provider, category, amount, currency,
  billingCycle, (optional) customInterval, nextRenewal, startDate, paymentMethod,
  website, notes, color, icon, isActive, autoRenew, createdAt, updatedAt.
- Create sets `createdAt === updatedAt`; edits advance `updatedAt`; delete is
  preceded by a backup.
- Validation: non-empty name and a non-negative numeric amount, with messages
  that identify the offending field.
- A single modal handles create and edit; edit pre-populates current values,
  create pre-fills the default currency, and cancel discards without persisting.

## 5–6. Billing, renewal & single-currency totals

- Normalized monthly amount per cycle (Yearly/12, Half-Yearly/6, Quarterly/3,
  Weekly×52/12, Custom by configured interval); yearly = monthly × 12.
- When a renewal passes and `autoRenew` is true, the next renewal advances by one
  billing interval; Custom uses the configured interval.
- Totals sum amounts directly (single currency, INR) with no conversion; the
  per-subscription currency field is retained for the future.

## 7. Categories

- Default categories are created on first run; custom categories can be added.
- Duplicate category names are rejected with a message naming the duplicate.
- Deleting a category that is in use prompts the user first.

## 8. Dashboard

- Total monthly spend, total yearly spend, and active count (over active
  subscriptions).
- "Renewing in the next 7 days" and "recently changed" (by `updatedAt` desc).
- Metrics update when subscription data changes.

## 9. Subscription list

- Shows name, category, amount, next renewal, billing cycle, and status.
- Text search, sortable columns, filters, grouping, multi-select bulk actions,
  and inline quick-edit (which advances `updatedAt`).

## 10. Calendar

- A monthly grid with renewal indicators on dates with renewals.
- Selecting a date shows that day's renewals; month navigation recomputes
  indicators.

## 11. Analytics

- Monthly spend, category distribution, yearly projection, most-expensive
  subscriptions (by normalized monthly amount), and an upcoming renewal
  timeline.

## 12. Global fuzzy search

- Approximate (subsequence) matching on name or provider; e.g. "net" matches
  "Netflix", "Internet", "Network". Clearing the query returns all.

## 13. Notifications

- Configurable desktop reminders at same-day / one-day / three-days lead times.
- Work offline. With Tray_Mode on, reminders fire while the window is closed;
  with it off, evaluation runs only while the app is open. Timing changes apply
  to subsequent evaluations.

## 14. Themes

- Dark, light, and system themes; system follows the OS appearance. A
  configurable accent color. Dark is the first-run default.

## 15. Settings

- Persists default currency, notification timing, backup frequency, theme, accent
  color, Tray_Mode, and data folder location. Changes persist to `settings.json`;
  changing the data folder switches subsequent file operations; preferences load
  and apply on startup.

## 16–18. Import, export & backups

- Import JSON or CSV with per-record validation and Replace/Merge/Skip conflict
  resolution; a backup is taken before applying; partial failures preserve
  existing valid data and report rejected records.
- Export all subscriptions and settings to a chosen location as JSON or CSV;
  exports are importer-compatible.
- Timestamped backups (`YYYY-MM-DD-HH-MM.json`) are created before destructive
  operations; restore replaces current data after first backing it up.

## 19. Error handling & recovery

- Malformed data never crashes the app; the affected file is identified.
- Corrupt files offer restore from the most recent backup.
- Missing files are recreated with defaults.
- Failed operations surface clear, user-friendly messages.

## 20. Privacy

- No analytics, telemetry, tracking, accounts, cloud sync, or outbound requests.
- All data is stored only on the local filesystem.

## 21. Performance

- Fast cold start (lazy-loaded heavy views; deferred scheduler first tick) and a
  lightweight footprint (no heavy chart libraries).

## 22. Accessibility

- Keyboard navigation and shortcuts, screen-reader labels, chart text
  alternatives, high-contrast support, and scalable fonts.

## 23. Branding & attribution

- The name "Subby" and tagline "Take control of your subscriptions." on the
  About page, with non-intrusive attribution to Mr. K (@KubeMonk) / OpsAlchemist
  on About and in the Settings footer.
