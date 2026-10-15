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
 * SEAM FIX (Story 4.3): the live tick now decides dueness AND stores the dedupe
 * bucket on the SAME single value — `localToday = reminderDay(now, offset)`. This
 * CORRECTS the shipped 4.2 split (which decided dueness on a UTC `today` yet
 * stored the local day): because `catchUp` keys each event on
 * `targetDate = nextRenewal - leadDays`, and on the firing local day
 * `localToday === targetDate` (dueness means `localToday + leadDays ===
 * nextRenewal`), the live tick and the launch catch-up now produce an IDENTICAL
 * dedupe identity for the same `(sub, leadTime, renewal)` — so a reminder shown by
 * one is never re-shown by the other (SM-2 across the live/catch-up seam). Dueness
 * is now genuinely LOCAL (AD-18), not UTC.
 *
 * The launch catch-up pass ({@link Scheduler.catchUpOnLaunch}) fires reminders
 * whose moment passed while the app was closed, within the 24h look-back cap
 * anchored on `lastRunAt`. It is run ONCE by {@link Scheduler.start} before the
 * first periodic evaluation, after `main.ts`'s migration barrier (AD-28). It
 * reuses the SAME shared write tail ({@link Scheduler.commitLedger}) as the live
 * tick — one write path, one lock, one degrade stance.
 *
 * Whether evaluation continues while the window is closed (Tray_Mode) is a
 * concern of `tray.ts` + `main.ts` wiring: this scheduler simply keeps ticking
 * until {@link Scheduler.stop} is called.
 */

import {
  catchUp,
  catchUpTrialEnds,
  dueLeadTimes,
  prune,
  reminderDay,
  trialEndDue,
  unfired,
} from "core/notify";
import { rollForward } from "core/renewal";
import type {
  ReminderEvent,
  ReminderEventKind,
  ReminderLedger,
} from "core/models/reminder";
import type { ReminderLeadTime, SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";

/** Emits one desktop reminder for a `(subscription, leadTime, kind)` triple. */
export interface SubscriptionNotifier {
  notify(sub: SubscriptionV2, leadTime: ReminderLeadTime, kind: ReminderEventKind): void;
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

/**
 * How far back the launch catch-up pass (Story 4.3) looks for reminders whose
 * moment passed while the app was closed. 24h is the PRD FR-7 look-back cap — the
 * MAXIMUM, not a blind window: `catchUp` anchors the real window on
 * `max(lastRunAt, now - LOOKBACK_HOURS)`, so a 2h-ago last run yields a 2h window
 * (never a flat 24h). This value must never widen past 24h (spec Boundaries).
 */
export const LOOKBACK_HOURS = 24;

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

/**
 * Periodic + launch reminder evaluator. Construct with injected seams, then
 * call {@link start} (runs the launch catch-up pass, then begins ticking with an
 * immediate launch evaluation) or {@link evaluateNow} to run a single cycle
 * directly (used by the deferred launch tick and by tests).
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
   * Run the launch catch-up pass (Story 4.3), begin periodic evaluation, and run
   * an immediate launch evaluation. Safe to call repeatedly: a second call
   * without {@link stop} is a no-op so the timer is never duplicated. Returns a
   * promise for the launch work so callers (and tests) can await it.
   *
   * Launch ORDERING (AD-28): the single catch-up pass runs ONCE here, BEFORE the
   * first periodic `evaluateNow()`, so a reminder missed while the app was closed
   * is caught before the live path evaluates. The scheduler is only constructed
   * and started AFTER `main.ts`'s migration barrier, so catch-up never reads
   * un-migrated data. The catch-up degrades on throw internally (never rejects),
   * so chaining the launch evaluation after it cannot be short-circuited by a
   * catch-up fault.
   */
  start(): Promise<void> {
    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.evaluateNow();
      }, this.intervalMs);
      // Don't let the timer keep the (headless/test) event loop alive.
      this.timer.unref?.();
      // FIRST start only: the launch catch-up pass runs ONCE per launch (AD-20),
      // inside this guard, so a repeat `start()` (timer already live) does NOT
      // re-run it. Catch-up FIRST (Req 13.1): fire reminders missed while closed,
      // THEN the immediate launch evaluation for anything due right now.
      return this.catchUpOnLaunch().then(() => this.evaluateNow());
    }
    // Repeat `start()` with the timer already live: idempotent — no second
    // catch-up pass; just run a single launch evaluation (the prior contract).
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
      // Capture the clock ONCE so the local-day `today` (dueness AND the stored
      // dedupe bucket) and the advanced `lastRunAt` derive from the SAME instant.
      const now = this.now();
      const nowIso = now.toISOString();

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

      // (3) The ONE canonical local day (AD-18), used as BOTH the dueness `today`
      //     AND the stored dedupe bucket. SEAM FIX (4.3): the live tick now decides
      //     dueness on the LOCAL day — not a UTC `today` — and stores that SAME
      //     local day as `localDay`. On the firing local day the resulting bucket
      //     equals catchUp's `targetDate = nextRenewal - leadDays` (because dueness
      //     means `localToday + leadDays === nextRenewal`), so the live tick and
      //     the launch catch-up produce an identical dedupe identity for the same
      //     `(sub, leadTime, renewal)` and never double-fire across the seam (SM-2).
      const localToday = reminderDay(nowIso, this.offsetMinutes());
      // The UTC calendar day of `nowIso` — the SECOND interpretation the
      // trial-end earlier-of-local/UTC rule needs (Story 5.2). It is derived from
      // the SAME captured instant as `localToday` (no second clock): `reminderDay`
      // with a zero offset yields the UTC `YYYY-MM-DD` day. Renewal dueness still
      // keys purely on `localToday` — this is used only by `trialEndDue`.
      const utcToday = reminderDay(nowIso, 0);

      // (4) Build the due events across eligible subs. A sub lookup by id lets
      //     the emit step pass the ACTUAL (rolled-forward) subscription to the
      //     notifier even though the event only carries ids.
      const subById = new Map<string, SubscriptionV2>();
      const due: ReminderEvent[] = [];
      for (const sub of subs) {
        // Roll a past renewal forward (autoRenew only) so the evaluated date is
        // the genuine upcoming renewal.
        const evaluated = rollForward(sub, localToday);
        // Paused subscriptions never generate reminders (AD-17); Active and
        // Trial are both reminder-eligible.
        if (evaluated.state === "Paused") continue;
        subById.set(evaluated.id, evaluated);
        // Pure due-decision against the LOCAL day (AD-18 local dueness).
        for (const leadTime of dueLeadTimes(evaluated, localToday, enabled)) {
          due.push({
            kind: "renewal",
            subscriptionId: evaluated.id,
            leadTime,
            // The canonical LOCAL-day dedupe bucket = the due date (AD-18).
            localDay: localToday,
          });
        }
        // Trial-End reminders (Story 5.2): a Trial sub ALSO contributes trial-end
        // events, keyed on the STABLE conversion-target day and due on the
        // conservative earlier of the local/UTC interpretation (never after the
        // charge). `trialEndDue` returns [] for a non-Trial sub, so this is a
        // no-op for plain-Active subs — renewal keying is untouched.
        due.push(...trialEndDue(evaluated, localToday, utcToday, enabled));
      }

      // (5) Exactly-once dedupe against the PERSISTED ledger (SM-2).
      const fresh = unfired(due, ledger);

      // (6) Emit each surviving event (local OS notification, zero network). The
      //     event `kind` (renewal vs trial-end) selects the notifier's body copy.
      for (const event of fresh) {
        const sub = subById.get(event.subscriptionId);
        if (sub !== undefined) {
          this.notifier.notify(sub, event.leadTime, event.kind);
        }
      }

      // (7) Record the fired events, advance `lastRunAt`, prune to the retention
      //     window, and atomically write back under the lock (shared write tail).
      //     Notifications were shown BEFORE this write (the user-visible action is
      //     the point): a caught write failure leaves the prior ledger intact (no
      //     partial write — the adapter is atomic) and never throws into the event
      //     loop. `localToday` is the prune anchor and matches the fired buckets.
      await this.commitLedger(ledger, fresh, nowIso, localToday);
    } catch (err) {
      // DEGRADE, never propagate (AD-28): the scheduler must never throw into the
      // event loop. This covers the DECIDE + WRITE region — e.g. `reminderDay`'s
      // fail-closed `RangeError` on a bad offset, a bad clock making
      // `now.toISOString()` throw, or an unexpected `prune` throw. On any such
      // throw the cycle emits/writes nothing beyond what already ran and
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

  /**
   * Launch catch-up pass (Story 4.3, AD-20). Runs ONCE per launch — invoked by
   * {@link start} BEFORE the first periodic evaluation, and only after `main.ts`
   * has crossed the migration barrier (AD-28), so it never reads un-migrated
   * data. It fires reminders whose moment passed while the app was CLOSED,
   * consulting the SAME persisted ledger as the live tick so an already-shown
   * reminder never re-fires (SM-2 across the live/catch-up seam).
   *
   *  1. Read settings. If notifications are disabled, return — a no-op that
   *     writes NOTHING (`lastRunAt` is not advanced), matching the live tick.
   *  2. Capture `now` once; read subscriptions + the ledger. A read failure
   *     degrades the whole pass (emit nothing, write nothing, no crash) — launch
   *     continues.
   *  3. Roll each sub forward on the canonical local day (as the tick does), then
   *     `catchUp(evaluatedSubs, ledger, now, LOOKBACK_HOURS)` — the pure decision:
   *     only Active/Trial subs (never Paused), only events in `[max(lastRunAt,
   *     now-24h), now]`, only identities not already in `ledger.fired`. The
   *     returned events already key `localDay` on the TARGET DUE DATE, the same
   *     canonical bucket the (seam-fixed) live tick stores. `catchUp` has no
   *     enabled-lead-time param, so its result is filtered by the user's enabled
   *     lead times — the live tick respects them, and catch-up must too.
   *  4. Emit one notification per surviving event via the existing notifier.
   *  5. Append + advance `lastRunAt` + prune + atomic locked write — the SAME
   *     shared write tail as the live tick ({@link commitLedger}). The prune
   *     anchor is the catch-up `now`'s local day (today), consistent with the tick.
   *
   * The pass never throws into the event loop (AD-28): every failure path above
   * is caught here and degrades. `lastRunAt` is advanced even when zero reminders
   * are caught up, so the next window is anchored forward.
   */
  async catchUpOnLaunch(): Promise<void> {
    try {
      // (1) Settings gate (Req 13.5), mirroring the live tick: disabled → no-op,
      //     write nothing.
      const settings = await this.services.getSettings();
      if (!settings.notification.enabled) return;

      // (2) Capture the clock ONCE so the catch-up window `now`, the advanced
      //     `lastRunAt`, and the prune anchor all derive from the SAME instant.
      const now = this.now();
      const nowIso = now.toISOString();

      // Current subscription set + the persisted ledger. A read failure degrades
      // the whole pass (emit nothing, write nothing, no crash); launch continues.
      let subs: SubscriptionV2[];
      let ledger: ReminderLedger;
      try {
        [subs, ledger] = await Promise.all([
          this.services.listSubscriptions(),
          this.services.readReminderLedger(),
        ]);
      } catch (err) {
        console.error(
          `[subby] scheduler catch-up skipped: ledger/subscriptions read failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      // (3) The ONE canonical local day (AD-18), used BOTH to roll subs forward
      //     (so a lapsed autoRenew renewal keys on its NEXT occurrence, matching
      //     the live tick's `rollForward(sub, localToday)`) AND as the prune
      //     anchor. Keeping the same local-day basis as the tick is what keeps the
      //     seam key identical for lapsed renewals.
      const localToday = reminderDay(nowIso, this.offsetMinutes());

      // (4) Roll each sub forward on the SAME local-day basis as the tick, then
      //     run the pure catch-up decision (eligibility + window + already-fired)
      //     over the rolled-forward subs. `SubscriptionV2[]` structurally
      //     satisfies `CatchUpSubscription[]`. `catchUp` has no enabled-lead-time
      //     param, so filter its result by the user's enabled lead times — the
      //     live tick respects them, and catch-up must too.
      const evaluatedSubs = subs.map((sub) => rollForward(sub, localToday));
      const enabled = new Set(settings.notification.leadTimes);
      // Renewal catch-up (frozen 4.1) AND the Story 5.2 trial-end catch-up sibling
      // run over the SAME window/ledger with the SAME `(now, LOOKBACK_HOURS)`
      // signature (both are offset-independent). Both are filtered by the user's
      // enabled lead times (the live tick respects them, and catch-up must too)
      // and both flow through the one shared `commitLedger` write tail below. The
      // ledger's discriminated `kind` keeps renewal and trial-end identities
      // distinct, so the two result sets never collide.
      const fresh = [
        ...catchUp(evaluatedSubs, ledger, nowIso, LOOKBACK_HOURS),
        ...catchUpTrialEnds(evaluatedSubs, ledger, nowIso, LOOKBACK_HOURS),
      ].filter((event) => enabled.has(event.leadTime));

      // (5) Emit each caught-up reminder (local OS notification, zero network).
      //     The map is keyed over the ROLLED-FORWARD subs so the notifier receives
      //     the same evaluated subscription the identity was keyed on. The event
      //     `kind` selects the renewal vs trial-end body copy.
      const subById = new Map<string, SubscriptionV2>();
      for (const sub of evaluatedSubs) subById.set(sub.id, sub);
      for (const event of fresh) {
        const sub = subById.get(event.subscriptionId);
        if (sub !== undefined) {
          this.notifier.notify(sub, event.leadTime, event.kind);
        }
      }

      // (6) Shared write tail: append + advance `lastRunAt` + prune + atomic
      //     locked write. The prune anchor is the catch-up `now`'s local day.
      await this.commitLedger(ledger, fresh, nowIso, localToday);
    } catch (err) {
      // DEGRADE, never propagate (AD-28): a bad clock/offset (`reminderDay`
      // RangeError) or any unexpected throw degrades the pass — emit/write nothing
      // beyond what already ran, leave the prior ledger intact, and let launch
      // proceed. The read-failure catch above handles its case specifically; this
      // is the catch-all backstop.
      console.error(
        `[subby] scheduler catch-up degraded (caught, not thrown): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The SHARED ledger write tail used by BOTH the live tick ({@link evaluateNow})
   * and the launch catch-up ({@link catchUpOnLaunch}) — one write path, one lock,
   * one degrade stance, no duplication.
   *
   * Appends `fresh` to the prior `fired`, advances `lastRunAt` to `nowIso`, prunes
   * to the retention window anchored on `localToday`, and atomically writes the
   * ledger back under `lock("reminderLedger")`. The caller has ALREADY emitted the
   * notifications (the user-visible action is the point): a caught write failure
   * leaves the prior ledger intact (the adapter write is atomic — no partial
   * write) and NEVER throws into the event loop. The under-fire-is-safer stance is
   * inherited unchanged — a shown-but-unrecorded reminder may re-show on a later
   * same-day cycle, strictly safer than recording-before-showing (which could drop
   * a reminder on a crash).
   */
  private async commitLedger(
    ledger: ReminderLedger,
    fresh: ReminderEvent[],
    nowIso: string,
    localToday: string,
  ): Promise<void> {
    const next: ReminderLedger = {
      ...ledger,
      lastRunAt: nowIso,
      fired: prune(
        { ...ledger, fired: [...ledger.fired, ...fresh] },
        localToday,
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
  }
}
