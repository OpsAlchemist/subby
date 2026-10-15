/**
 * Reminder Scheduler (Electron MAIN process) — Req 13.1, 13.2, 13.5; Epic 4 (4.2).
 *
 * Periodically (and once on launch) evaluates which subscriptions have a
 * renewal reminder due "today" and emits one desktop notification per due
 * `(subscription, leadTime)` pair. The WHICH-is-due decision is delegated to
 * the pure `core/notify.dueLeadTimes`; the exactly-once DEDUPE decision is
 * delegated to the pure `core/notify.unfired`; emission is delegated to a
 * {@link SubscriptionNotifier} (the `NotificationService`).
 *
 * Ledger-backed dedupe (4.2): the in-memory `Set` that any restart wiped is
 * GONE. The single dedupe source is now the PERSISTED reminder ledger
 * (`reminder-ledger.json`). Each cycle reads it, filters the due events through
 * `unfired`, emits the survivors, then appends the fired events + advances
 * `lastRunAt` + `prune`s to the retention window and atomically writes it back —
 * all under the per-file `lock("reminderLedger")` in `AppServices`, so the
 * scheduler is the single serialized ledger writer. A reminder therefore fires
 * EXACTLY ONCE per `(subscription, leadTime, localDay)` even across a same-day
 * restart (SM-2).
 *
 * Design seams (all injectable so tests run without real timers, a real clock,
 * the real OS timezone offset, or the real Electron `Notification` API):
 *  - `intervalMs`     — how often the periodic cycle runs.
 *  - `now()`          — the wall clock, so "today" is deterministic in tests.
 *  - `offsetMinutes()`— the OS timezone offset (minutes EAST of UTC, so IST=+330),
 *                       defaulting to the live OS local offset; tests inject a
 *                       fixed offset so the canonical local-day bucket is
 *                       deterministic.
 *  - `notifier`       — emits the desktop notification.
 *  - `services`       — reads settings + subscriptions + the ledger each cycle,
 *                       and writes the ledger back (locked) each enabled cycle.
 *
 * Key behaviors made explicit:
 *  - Settings are read on EVERY cycle (Req 13.5) so updated notification timing
 *    (enabled flag + lead times) applies to subsequent evaluations.
 *  - When `notification.enabled` is false, a cycle is a no-op AND writes nothing
 *    (`lastRunAt` is not advanced).
 *  - Dedupe is PERSISTED and bucketed by the ONE canonical local day from
 *    `core/notify.reminderDay(now, offsetMinutes)` (AD-18) — never a second
 *    UTC-vs-local keying. A same-day restart does NOT re-fire; a new local day
 *    re-arms.
 *  - The scheduler never throws into the event loop (AD-28): a ledger read/write
 *    failure is caught, the cycle degrades (emits nothing / does not advance
 *    `lastRunAt`), and does not crash.
 *
 * NOTE on the two date roles (see the spec's Design Notes): the RENEWAL-DUE
 * comparison inside `dueLeadTimes` uses a UTC `today` (`toISODate(now)`) — that
 * calendar-UTC arithmetic is unchanged. The DEDUPE BUCKET is the canonical LOCAL
 * day from `reminderDay`. They can differ by one near a midnight boundary, and
 * that is correct.
 *
 * The launch catch-up pass (reading `lastRunAt` to fire reminders missed while
 * the app was closed) is Story 4.3 — NOT this story. 4.2 only ADVANCES
 * `lastRunAt` so 4.3 has an anchor to read.
 *
 * Whether evaluation continues while the window is closed (Tray_Mode) is a
 * concern of `tray.ts` + `main.ts` wiring: this scheduler simply keeps ticking
 * until {@link Scheduler.stop} is called.
 */

import { dueLeadTimes, prune, reminderDay, unfired } from "core/notify";
import { rollForward, type ISODate } from "core/renewal";
import type { ReminderEvent, ReminderLedger } from "core/models/reminder";
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
  /** Read the persisted reminder ledger (lock-free snapshot read). */
  readReminderLedger(): Promise<ReminderLedger>;
  /** Write the reminder ledger back (serialized under `lock("reminderLedger")`). */
  writeReminderLedger(ledger: ReminderLedger): Promise<void>;
}

/** Default periodic evaluation interval: every 30 minutes. */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How many days of fired-reminder entries the ledger retains. `prune` drops
 * entries whose `localDay` is older than `localDay - RETENTION_DAYS` on every
 * write, keeping the file bounded without a separate maintenance pass.
 *
 * 90 days is the real coupling constraint: Story 4.3's launch catch-up consults
 * the ledger to avoid re-firing a reminder whose moment passed while the app was
 * closed, so a `fired` entry MUST survive at least as long as the longest
 * downtime 4.3 can look back over. 90 days sits far above that 24h look-back cap
 * with ample safety margin, so a pruned entry can never be one catch-up still
 * needs to dedupe against — while keeping the file small.
 */
export const RETENTION_DAYS = 90;

/** Construction options for {@link Scheduler}. */
export interface SchedulerOptions {
  /** Reads settings + subscriptions + the ledger each cycle, writes the ledger back. */
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
  /**
   * Injectable OS timezone offset in minutes EAST of UTC (so IST = +330).
   * Defaults to the live OS local offset (`-new Date().getTimezoneOffset()`,
   * which JS reports as minutes WEST, hence the negation). Tests inject a fixed
   * offset so the canonical local-day bucket is deterministic. This is the ONLY
   * source of the local-day offset (AD-18) — there is no second derivation.
   */
  offsetMinutes?: () => number;
}

/** Derive the UTC `YYYY-MM-DD` "today" from a `Date`. */
function toISODate(date: Date): ISODate {
  // UTC slice keeps "today" consistent with core's UTC date arithmetic — this
  // is the RENEWAL-DUE comparison date passed to `dueLeadTimes`, distinct from
  // the canonical LOCAL day used as the ledger dedupe bucket.
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
  private readonly offsetMinutes: () => number;

  /** The active periodic timer handle, or `null` when stopped. */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Guards against overlapping async cycles (re-entrancy). */
  private evaluating = false;

  constructor(opts: SchedulerOptions) {
    this.services = opts.services;
    this.notifier = opts.notifier;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    // JS `getTimezoneOffset()` is minutes WEST of UTC; negate it to minutes EAST
    // (so IST reports +330), matching `reminderDay`'s offset convention (AD-18).
    this.offsetMinutes =
      opts.offsetMinutes ?? (() => -new Date().getTimezoneOffset());
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
   *  1. Read settings (Req 13.5). If notifications are disabled, return — a
   *     no-op that writes NOTHING (`lastRunAt` is not advanced).
   *  2. Read subscriptions + the ledger. A ledger READ failure degrades the
   *     whole cycle: emit nothing, write nothing, do not crash.
   *  3. Compute the canonical LOCAL day via `reminderDay(now, offsetMinutes)` —
   *     the single dedupe bucket (AD-18).
   *  4. Build the due `ReminderEvent`s: roll each sub forward (autoRenew only),
   *     skip Paused (Active/Trial are eligible), map each due lead time to a
   *     `{kind:"renewal", subscriptionId, leadTime, localDay}` event.
   *  5. Filter through `unfired(due, ledger)` so an already-recorded reminder
   *     never re-fires (SM-2).
   *  6. Emit one notification per surviving event.
   *  7. Append the fired events, advance `lastRunAt`, `prune` to the retention
   *     window, and atomically write the ledger back under its lock. A WRITE
   *     failure is caught and logged (never thrown): the shown reminders are not
   *     recorded, so a subsequent same-day cycle could re-show them — an
   *     at-most-rare duplicate under disk failure, strictly safer than
   *     recording-before-showing (which could drop a reminder on a crash).
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
      // Capture the clock ONCE so the UTC `today` (renewal-due arithmetic), the
      // canonical `localDay` bucket, and the advanced `lastRunAt` all derive from
      // the SAME instant — no sub-millisecond skew between the two date roles.
      const now = this.now();
      const nowIso = now.toISOString();
      const today = toISODate(now);

      // (2) Current subscription set + the persisted ledger (the dedupe source).
      //     A ledger READ failure degrades the whole cycle (emit nothing, write
      //     nothing, no crash — the next cycle re-reads the prior ledger).
      let subs: SubscriptionV2[];
      let ledger: ReminderLedger;
      try {
        [subs, ledger] = await Promise.all([
          this.services.listSubscriptions(),
          this.services.readReminderLedger(),
        ]);
      } catch (err) {
        console.error(
          `[subby] scheduler cycle skipped: ledger/subscriptions read failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      // (3) The ONE canonical local-day bucket (AD-18).
      const localDay = reminderDay(nowIso, this.offsetMinutes());

      // (4) Build the due events across eligible subs. A sub lookup by id lets
      //     the emit step pass the ACTUAL (rolled-forward) subscription to the
      //     notifier even though the event only carries ids.
      const subById = new Map<string, SubscriptionV2>();
      const due: ReminderEvent[] = [];
      for (const sub of subs) {
        // Roll a past renewal forward (autoRenew only) so the evaluated date is
        // the genuine upcoming renewal.
        const evaluated = rollForward(sub, today);
        // Paused subscriptions never generate reminders (AD-17); Active and
        // Trial are both reminder-eligible.
        if (evaluated.state === "Paused") continue;
        subById.set(evaluated.id, evaluated);
        // Pure due-decision against the UTC `today` (renewal-date arithmetic).
        for (const leadTime of dueLeadTimes(evaluated, today, enabled)) {
          due.push({
            kind: "renewal",
            subscriptionId: evaluated.id,
            leadTime,
            // The canonical LOCAL-day dedupe bucket (AD-18).
            localDay,
          });
        }
      }

      // (5) Exactly-once dedupe against the PERSISTED ledger (SM-2).
      const fresh = unfired(due, ledger);

      // (6) Emit each surviving event (local OS notification, zero network).
      for (const event of fresh) {
        const sub = subById.get(event.subscriptionId);
        if (sub !== undefined) {
          this.notifier.notify(sub, event.leadTime);
        }
      }

      // (7) Record the fired events, advance `lastRunAt`, prune to the retention
      //     window, and atomically write back under the lock. Notifications were
      //     shown BEFORE this write (the user-visible action is the point): a
      //     caught write failure leaves the prior ledger intact (no partial
      //     write — the adapter is atomic) and never throws into the event loop.
      const next: ReminderLedger = {
        ...ledger,
        lastRunAt: nowIso,
        fired: prune(
          { ...ledger, fired: [...ledger.fired, ...fresh] },
          localDay,
          RETENTION_DAYS,
        ).fired,
      };
      try {
        await this.services.writeReminderLedger(next);
      } catch (err) {
        console.error(
          `[subby] scheduler ledger write failed (reminders shown, not recorded): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } catch (err) {
      // DEGRADE, never propagate (AD-28): the scheduler must never throw into the
      // event loop. This covers the DECIDE + WRITE region — e.g. `reminderDay`'s
      // fail-closed `RangeError` on a bad offset, a bad clock making
      // `now.toISOString()`/`toISODate` throw, or an unexpected `prune` throw. On
      // any such throw the cycle emits/writes nothing beyond what already ran and
      // `lastRunAt` is left unchanged (a partial-emit followed by a throw before
      // the write simply leaves the prior ledger intact — safe under-fire). The
      // dedicated read-failure catch above handles its case with a specific
      // message; this is the catch-all backstop for everything else.
      console.error(
        `[subby] scheduler cycle degraded (caught, not thrown): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.evaluating = false;
    }
  }
}
