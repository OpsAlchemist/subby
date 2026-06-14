import { afterEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../electron/services/scheduler";
import type { SchedulerServices, SubscriptionNotifier } from "../electron/services/scheduler";
import type { ReminderLeadTime, Settings } from "core/models/settings";
import type { Subscription } from "core/models/subscription";

/**
 * Integration tests for the reminder Scheduler (Task 28.3) — Req 13.2, 13.3, 13.4.
 *
 * The real Electron Tray + window lifecycle (`main.ts` / `tray.ts`) cannot be
 * driven headlessly in a Node test env. Instead these tests exercise the
 * SCHEDULER behavior that REALIZES the Tray_Mode and offline requirements,
 * using the scheduler's injectable seams:
 *   - `now()`       — a fixed/controllable wall clock so "today" is deterministic.
 *   - `notifier`    — an in-memory `vi.fn()` spy (no real OS notification center).
 *   - `services`    — tiny local stubs for `getSettings` + `listSubscriptions`.
 *
 * How each requirement is exercised:
 *   - 13.2 (offline emission): the scheduler produces notifications using ONLY
 *           the injected in-memory notifier and local stub services — no network,
 *           no Electron, no I/O. Emission is purely local.
 *   - 13.3 (Tray_Mode ON, window closed): modeled as the scheduler continuing to
 *           evaluate across repeated cycles regardless of any window state. Due
 *           reminders keep emitting; in-day dedupe prevents re-emitting the same
 *           `(sub, leadTime)`, but a NEW due item — or a NEW day via a different
 *           `now` — does emit.
 *   - 13.4 (Tray_Mode OFF, only while open): modeled as "evaluation only runs
 *           while the scheduler is running". `stop()` cancels the periodic timer
 *           so no further cycles fire; evaluation then happens only when the app
 *           explicitly invokes `evaluateNow()` (i.e. while the window is open).
 *   - 13.5 (settings gating, supports 13.3/13.4): when `notification.enabled` is
 *           false, a cycle is a no-op and nothing is emitted.
 */

/** Fixed clock: midnight UTC on 2025-03-07 => "today" === "2025-03-07". */
const FIXED_NOW = () => new Date("2025-03-07T00:00:00Z");
const TODAY = "2025-03-07";

/** A complete, type-valid subscription; only `nextRenewal` drives due-ness. */
function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amount: 499,
    currency: "INR",
    billingCycle: "Monthly",
    // Default to "today" so the same-day lead time is due for FIXED_NOW.
    nextRenewal: TODAY,
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://netflix.com",
    notes: "",
    color: "#E50914",
    icon: "netflix",
    isActive: true,
    // Renewal dates are today/future, so roll-forward is a no-op regardless.
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Settings with notifications enabled and an arbitrary set of lead times. */
function makeSettings(
  leadTimes: ReminderLeadTime[],
  enabled = true,
): Settings {
  return {
    defaultCurrency: "INR",
    notification: { enabled, leadTimes },
    backupFrequency: "weekly",
    theme: "dark",
    accentColor: "#7C5CFF",
    trayMode: false,
    dataFolder: null,
  };
}

/**
 * Build a local stub `SchedulerServices`. `subsRef`/`settingsRef` are read on
 * every call so a test can mutate them between cycles (simulating data/settings
 * changes across ticks). Returns the spies too, so call counts can be asserted.
 */
function makeServices(initialSettings: Settings, initialSubs: Subscription[]) {
  const state = { settings: initialSettings, subs: initialSubs };
  const getSettings = vi.fn(async () => state.settings);
  const listSubscriptions = vi.fn(async () => state.subs);
  const services: SchedulerServices = { getSettings, listSubscriptions };
  return { services, state, getSettings, listSubscriptions };
}

/** An in-memory notifier spy — stands in for the real (offline) NotificationService. */
function makeNotifier(): SubscriptionNotifier & { notify: ReturnType<typeof vi.fn> } {
  return { notify: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("offline emission (Req 13.2)", () => {
  it("emits a notification for a due (sub, leadTime) using only local seams — no network", async () => {
    // Settings + subscriptions come from local stubs; the notifier is an
    // in-memory spy. Nothing here touches the network, the filesystem, or
    // Electron — emission is purely local (Req 13.2).
    const sameDaySub = makeSubscription({ id: "today", nextRenewal: TODAY });
    const { services } = makeServices(makeSettings(["same-day"]), [sameDaySub]);
    const notifier = makeNotifier();

    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW });

    await scheduler.evaluateNow();

    // Exactly one local notification was produced for the due same-day reminder.
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sameDaySub, "same-day");
  });

  it("emits one notification per due lead time across multiple subscriptions", async () => {
    // today, today+1, today+3 exercise same-day / one-day / three-days.
    const subs = [
      makeSubscription({ id: "same", nextRenewal: "2025-03-07" }),
      makeSubscription({ id: "one", nextRenewal: "2025-03-08" }),
      makeSubscription({ id: "three", nextRenewal: "2025-03-10" }),
      // today+2 is NOT a configured lead time => never due.
      makeSubscription({ id: "two", nextRenewal: "2025-03-09" }),
    ];
    const { services } = makeServices(
      makeSettings(["same-day", "one-day", "three-days"]),
      subs,
    );
    const notifier = makeNotifier();

    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW });
    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(3);
    expect(notifier.notify).toHaveBeenCalledWith(subs[0], "same-day");
    expect(notifier.notify).toHaveBeenCalledWith(subs[1], "one-day");
    expect(notifier.notify).toHaveBeenCalledWith(subs[2], "three-days");
  });
});

describe("Tray_Mode ON keeps the scheduler evaluating while the window is closed (Req 13.3)", () => {
  it("keeps emitting due reminders across repeated cycles, with in-day dedupe", async () => {
    // Model: the window is "closed" but Tray_Mode keeps the scheduler alive, so
    // periodic cycles keep evaluating. We simulate that by calling evaluateNow()
    // multiple times.
    const subs = [
      makeSubscription({ id: "same", nextRenewal: "2025-03-07" }),
      makeSubscription({ id: "one", nextRenewal: "2025-03-08" }),
      makeSubscription({ id: "three", nextRenewal: "2025-03-10" }),
    ];
    const { services, state } = makeServices(
      makeSettings(["same-day", "one-day", "three-days"]),
      subs,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW });

    // First cycle (window closed): all three due reminders emit.
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(3);

    // Subsequent cycles on the SAME day: dedupe prevents re-emitting the same
    // (sub, leadTime) pairs — the count stays at 3.
    await scheduler.evaluateNow();
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(3);

    // A NEW due item appearing while the window is still closed DOES emit.
    const newlyDue = makeSubscription({ id: "new", nextRenewal: "2025-03-07" });
    state.subs = [...subs, newlyDue];
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(4);
    expect(notifier.notify).toHaveBeenLastCalledWith(newlyDue, "same-day");
  });

  it("re-emits the same reminder on a NEW day (different `now`)", async () => {
    // A mutable clock + a subscription that is due each day lets us prove the
    // dedupe key includes the day: the same (sub, leadTime) re-emits when the
    // day changes (Req 13.3 — evaluation keeps running across days while closed).
    let nowDate = new Date("2025-03-07T00:00:00Z");
    const now = () => nowDate;

    const sub = makeSubscription({ id: "daily", nextRenewal: "2025-03-07" });
    const { services, state } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now });

    // Day 1: due same-day -> emits once; repeat cycle deduped.
    await scheduler.evaluateNow();
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);

    // Advance to the next day and move the subscription's renewal to that day.
    nowDate = new Date("2025-03-08T00:00:00Z");
    const nextDaySub = makeSubscription({ id: "daily", nextRenewal: "2025-03-08" });
    state.subs = [nextDaySub];

    // New day => new dedupe key => emits again.
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(notifier.notify).toHaveBeenLastCalledWith(nextDaySub, "same-day");
  });
});

describe("Tray_Mode OFF means evaluation only runs while the app is open (Req 13.4)", () => {
  it("start() schedules periodic cycles and stop() cancels them (no ticks after stop)", async () => {
    vi.useFakeTimers();

    const subs = [makeSubscription({ id: "same", nextRenewal: "2025-03-07" })];
    const { services, listSubscriptions } = makeServices(
      makeSettings(["same-day"]),
      subs,
    );
    const notifier = makeNotifier();
    const intervalMs = 1000;
    const scheduler = new Scheduler({ services, notifier, intervalMs, now: FIXED_NOW });

    // start() runs an immediate launch evaluation (one cycle).
    await scheduler.start();
    expect(listSubscriptions).toHaveBeenCalledTimes(1);

    // While running, each interval triggers another evaluation cycle.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(listSubscriptions).toHaveBeenCalledTimes(2);

    // stop() cancels the timer: advancing time produces NO further cycles.
    // This models Tray_Mode OFF — once the app stops running, evaluation halts.
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(intervalMs * 5);
    expect(listSubscriptions).toHaveBeenCalledTimes(2);
  });

  it("when stopped, evaluation happens only on explicit evaluateNow() (while open)", async () => {
    // With Tray_Mode OFF, the app evaluates only while open by invoking the
    // scheduler directly. A never-started scheduler emits when (and only when)
    // evaluateNow() is called.
    const sub = makeSubscription({ id: "same", nextRenewal: "2025-03-07" });
    const { services } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW });

    // No background timer was started, so nothing has emitted yet.
    expect(notifier.notify).not.toHaveBeenCalled();

    // The app invokes evaluation explicitly (i.e. while the window is open).
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day");
  });
});

describe("settings gating supports Tray_Mode evaluation (Req 13.5)", () => {
  it("emits nothing when notifications are disabled, even for due subscriptions", async () => {
    // A subscription that WOULD be due same-day, but notifications are off.
    const sub = makeSubscription({ id: "same", nextRenewal: "2025-03-07" });
    const { services, listSubscriptions } = makeServices(
      makeSettings(["same-day"], /* enabled */ false),
      [sub],
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW });

    await scheduler.evaluateNow();

    // The cycle short-circuits after reading settings: nothing is emitted and
    // subscriptions are not even read.
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(listSubscriptions).not.toHaveBeenCalled();
  });
});
