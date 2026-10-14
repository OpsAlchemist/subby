/**
 * Reminder Scheduler (Electron MAIN process) — Req 13.1, 13.2, 13.5.
 *
 * Periodically (and once on launch) evaluates which subscriptions have a
 * renewal reminder due "today" and emits one desktop notification per due
 * `(subscription, leadTime)` pair. The WHICH-is-due decision is delegated to
 * the pure `core/notify.dueLeadTimes`; emission is delegated to a
 * {@link SubscriptionNotifier} (the `NotificationService`).
 *
 * Design seams (all injectable so task 28.3 can test without real timers, a
 * real clock, or the real Electron `Notification` API):
 *  - `intervalMs` — how often the periodic cycle runs.
 *  - `now()`      — the wall clock, so "today" is deterministic in tests.
 *  - `notifier`   — emits the desktop notification.
 *  - `services`   — reads settings + subscriptions each cycle.
 *
 * Key behaviors made explicit:
 *  - Settings are read on EVERY cycle (Req 13.5) so updated notification timing
 *    (enabled flag + lead times) applies to subsequent evaluations.
 *  - When `notification.enabled` is false, a cycle is a no-op.
 *  - In-memory dedupe keyed by `${sub.id}|${leadTime}|${today}` ensures the same
 *    reminder is not emitted twice within the same day, even across the launch
 *    tick + periodic cycles (Req 13.1).
 *
 * Whether evaluation continues while the window is closed (Tray_Mode) is a
 * concern of `tray.ts` + `main.ts` wiring (task 28.2): this scheduler simply
 * keeps ticking until {@link Scheduler.stop} is called.
 */

import { dueLeadTimes } from "core/notify";
import { rollForward, type ISODate } from "core/renewal";
import type { ReminderLeadTime, SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";

/** Emits one desktop reminder for a `(subscription, leadTime)` pair. */
export interface SubscriptionNotifier {
  notify(sub: SubscriptionV2, leadTime: ReminderLeadTime): void;
}

/**
 * The subset of app services the scheduler needs. Matches `AppServices` so the
 * production context can be passed directly, while tests can supply a tiny
 * stub.
 */
export interface SchedulerServices {
  /** Read the persisted settings (re-read each cycle — Req 13.5). */
  getSettings(): Promise<SettingsV2>;
  /** Read all subscriptions. */
  listSubscriptions(): Promise<SubscriptionV2[]>;
}

/** Default periodic evaluation interval: every 30 minutes. */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/** Construction options for {@link Scheduler}. */
export interface SchedulerOptions {
  /** Reads settings + subscriptions each cycle. */
  services: SchedulerServices;
  /** Emits desktop reminders (the `NotificationService`). */
  notifier: SubscriptionNotifier;
  /** Periodic interval in ms. Defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Injectable wall clock. Defaults to `() => new Date()`. Tests pass a fixed
   * clock so "today" is deterministic.
   */
  now?: () => Date;
}

/** Derive the UTC `YYYY-MM-DD` "today" from a `Date`. */
function toISODate(date: Date): ISODate {
  // UTC slice keeps "today" consistent with core's UTC date arithmetic.
  return date.toISOString().slice(0, 10);
}

/**
 * Periodic + launch reminder evaluator. Construct with injected seams, then
 * call {@link start} (begins ticking, runs an immediate launch evaluation) or
 * {@link evaluateNow} to run a single cycle directly (used by the deferred
 * launch tick and by tests).
 */
export class Scheduler {
  private readonly services: SchedulerServices;
  private readonly notifier: SubscriptionNotifier;
  private readonly intervalMs: number;
  private readonly now: () => Date;

  /**
   * In-memory dedupe of already-emitted reminders, keyed by
   * `${sub.id}|${leadTime}|${today}`. Prevents duplicate notifications for the
   * same reminder within a day across the launch tick and periodic cycles
   * (Req 13.1). Lives only for the process lifetime.
   */
  private readonly emitted = new Set<string>();

  /** The active periodic timer handle, or `null` when stopped. */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Guards against overlapping async cycles (re-entrancy). */
  private evaluating = false;

  constructor(opts: SchedulerOptions) {
    this.services = opts.services;
    this.notifier = opts.notifier;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Begin periodic evaluation and run an immediate launch evaluation. Safe to
   * call repeatedly: a second call without {@link stop} is a no-op so the timer
   * is never duplicated. Returns the promise for the launch cycle so callers
   * (and tests) can await the first evaluation.
   */
  start(): Promise<void> {
    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.evaluateNow();
      }, this.intervalMs);
      // Don't let the timer keep the (headless/test) event loop alive.
      this.timer.unref?.();
    }
    // Launch evaluation (Req 13.1): evaluate once immediately on start.
    return this.evaluateNow();
  }

  /** Stop periodic evaluation. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Alias for {@link evaluateNow}: run a single evaluation cycle. */
  tick(): Promise<void> {
    return this.evaluateNow();
  }

  /**
   * Run a single evaluation cycle:
   *  1. Read settings (Req 13.5). If notifications are disabled, do nothing.
   *  2. Read subscriptions; roll each forward to today (autoRenew only) so the
   *     evaluated `nextRenewal` is current.
   *  3. For each ACTIVE subscription, compute the due lead times via
   *     `core/notify.dueLeadTimes` against the enabled lead times.
   *  4. Emit one notification per due `(sub, leadTime)` that has not already
   *     been emitted today (in-memory dedupe — Req 13.1).
   *
   * Re-entrant calls while a cycle is in flight are skipped.
   */
  async evaluateNow(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      // (1) Re-read settings each cycle so timing changes apply (Req 13.5).
      const settings = await this.services.getSettings();
      if (!settings.notification.enabled) return;

      const enabled = settings.notification.leadTimes;
      const today = toISODate(this.now());

      // (2) Current subscription set.
      const subs = await this.services.listSubscriptions();

      for (const sub of subs) {
        // Roll a past renewal forward (autoRenew only) so the evaluated date is
        // the genuine upcoming renewal.
        const evaluated = rollForward(sub, today);
        // Paused subscriptions never generate reminders (AD-17); Active and
        // Trial are both reminder-eligible.
        if (evaluated.state === "Paused") continue;

        // (3) Pure due-decision.
        const due = dueLeadTimes(evaluated, today, enabled);

        // (4) Emit once per due pair, with per-sub/per-lead-time/per-day dedupe.
        for (const leadTime of due) {
          const key = `${evaluated.id}|${leadTime}|${today}`;
          if (this.emitted.has(key)) continue;
          this.emitted.add(key);
          this.notifier.notify(evaluated, leadTime);
        }
      }
    } finally {
      this.evaluating = false;
    }
  }
}
