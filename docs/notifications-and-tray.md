# Notifications & Tray

Renewal reminders and the system tray live in the **main process** so they work
independently of the renderer/window. They are wired up in `electron/main.ts`.

## Components

- **`core/notify.ts`** — the pure decision: `dueLeadTimes(sub, today, enabled)`
  returns which enabled lead times are due today (see [Core Reference](./core-reference.md)).
- **`electron/services/notificationService.ts`** — emits a desktop notification
  via the Electron `Notification` API. Emission goes through an injectable
  `Notifier` seam (`electronNotifier` in production; a spy in tests).
  `renderReminder(sub, leadTime)` builds the title/body text.
- **`electron/services/scheduler.ts`** — the periodic evaluator.
- **`electron/services/tray.ts`** — the Tray_Mode tray and menu.

## Scheduler

```ts
new Scheduler({ services, notifier, intervalMs?, now? })
  .start()        // launch evaluation + periodic timer
  .stop()
  .evaluateNow()  // run one cycle (alias: tick())
```

Each cycle:

1. Reads settings **every cycle** (so timing changes apply immediately). If
   `notification.enabled` is false, the cycle is a no-op.
2. Reads subscriptions and rolls each forward to today (`autoRenew` only).
3. For each **active** subscription, computes
   `dueLeadTimes(sub, today, settings.notification.leadTimes)`.
4. Emits one notification per due `(subscription, leadTime)` pair.

**Dedupe.** An in-memory `Set` keyed by `${id}|${leadTime}|${today}` ensures the
same reminder is not emitted twice in a day across the launch tick and periodic
cycles. A new day (different `now`) produces a new key, so daily reminders fire
again.

**Defaults & seams.** The interval defaults to 30 minutes; `now` defaults to
`() => new Date()`. Both the interval and clock are injectable, and the notifier
is injectable, so the scheduler is fully testable without real timers or the OS
notification center.

**Cold-start.** The first scheduler tick is deferred slightly after first paint
(via `ready-to-show`) so reminder evaluation doesn't compete with startup.

## Offline (Req 13.2)

Electron notifications are delivered locally by the OS notification center and
require no network. Subby emits reminders fully offline.

## Tray_Mode (Req 13.3 / 13.4)

Controlled by `settings.trayMode`:

- **Tray_Mode ON** — closing the window hides it to the tray instead of
  quitting. The scheduler keeps running, so reminders continue to fire while the
  window is closed. The tray menu offers "Show Subby" and "Quit".
- **Tray_Mode OFF** — closing the window closes/quits the app normally
  (on non-macOS, `window-all-closed` quits); evaluation only runs while the app
  is open.

Implementation details in `main.ts`:

- An `isQuitting` flag (set on `before-quit` and the tray "Quit" action) lets a
  genuine quit pass through the window `close` handler.
- The window `close` handler re-reads the freshest `trayMode` (an async settings
  read) before deciding to hide vs. destroy, so a just-toggled setting is
  honored.
- A cached `trayMode` value backs the synchronous `window-all-closed` handler.
- The scheduler is stopped and the tray destroyed on `quit`.

## Icon

The tray uses an empty `nativeImage` placeholder so it never crashes without a
bundled asset. Add a real tray/app icon under `build/` to brand it (see
`build/README.md`).
