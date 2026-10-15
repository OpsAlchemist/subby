import { afterEach, describe, expect, it, vi } from "vitest";

import { LOOKBACK_HOURS, Scheduler } from "../electron/services/scheduler";
import type { SchedulerServices, SubscriptionNotifier } from "../electron/services/scheduler";
import type { ReminderLedger } from "core/models/reminder";
import type { ReminderLeadTime, SettingsV2 } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";
import { defaultReminderLedger } from "core/models/schema";

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

/**
 * Fixed OS timezone offset for the default harness: 0 minutes (UTC). With
 * {@link FIXED_NOW} at midnight UTC, the canonical LOCAL day (`reminderDay`)
 * then equals the UTC day {@link TODAY}, so the ledger-dedupe bucket lines up
 * with the renewal-due arithmetic for these tests. Local-day-boundary cases
 * inject a non-zero offset explicitly.
 */
const OFFSET_UTC = () => 0;

/** A complete, type-valid v2 subscription; only `nextRenewal` drives due-ness. */
function makeSubscription(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Netflix",
    provider: "Netflix Inc.",
    category: "Streaming",
    amountMinor: 49900,
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
    state: "Active",
    priceHistory: [],
    tags: [],
    // Renewal dates are today/future, so roll-forward is a no-op regardless.
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** v2 settings with notifications enabled and an arbitrary set of lead times. */
function makeSettings(
  leadTimes: ReminderLeadTime[],
  enabled = true,
): SettingsV2 {
  return {
    homeCurrency: "INR",
    notification: { enabled, leadTimes },
    backupFrequency: "weekly",
    theme: "dark",
    accentColor: "#92400e",
    trayMode: false,
    dataFolder: null,
    online: { liveLogoFetch: false, fxRefresh: false },
  };
}

/**
 * A tiny in-memory reminder-ledger store standing in for the persisted
 * `reminder-ledger.json`. `read` returns a defensive COPY (so a caller mutating
 * the returned ledger cannot corrupt the store) and `write` replaces the stored
 * value. Shared across two `Scheduler` instances it models a same-day restart:
 * the second scheduler reads the ledger the first persisted. The optional
 * `failReads`/`failWrites` flags inject storage faults for the degrade cases.
 */
function makeLedgerStore(initial: ReminderLedger = defaultReminderLedger()) {
  const store = { ledger: initial, failReads: false, failWrites: false };
  const readReminderLedger = vi.fn(async (): Promise<ReminderLedger> => {
    if (store.failReads) throw new Error("injected ledger read fault");
    return {
      version: store.ledger.version,
      lastRunAt: store.ledger.lastRunAt,
      fired: store.ledger.fired.map((e) => ({ ...e })),
    };
  });
  const writeReminderLedger = vi.fn(async (ledger: ReminderLedger): Promise<void> => {
    if (store.failWrites) throw new Error("injected ledger write fault");
    store.ledger = {
      version: ledger.version,
      lastRunAt: ledger.lastRunAt,
      fired: ledger.fired.map((e) => ({ ...e })),
    };
  });
  return { store, readReminderLedger, writeReminderLedger };
}

/**
 * Build a local stub `SchedulerServices`. `subsRef`/`settingsRef` are read on
 * every call so a test can mutate them between cycles (simulating data/settings
 * changes across ticks). An in-memory ledger store backs the persisted
 * exactly-once dedupe (4.2); pass a shared `ledgerStore` to model a same-day
 * restart across two scheduler instances. Returns the spies + the ledger store
 * so call counts, ledger contents, and `lastRunAt` can be asserted.
 */
function makeServices(
  initialSettings: SettingsV2,
  initialSubs: SubscriptionV2[],
  ledger = makeLedgerStore(),
) {
  const state = { settings: initialSettings, subs: initialSubs };
  const getSettings = vi.fn(async () => state.settings);
  const listSubscriptions = vi.fn(async () => state.subs);
  const services: SchedulerServices = {
    getSettings,
    listSubscriptions,
    readReminderLedger: ledger.readReminderLedger,
    writeReminderLedger: ledger.writeReminderLedger,
  };
  return {
    services,
    state,
    getSettings,
    listSubscriptions,
    ledger: ledger.store,
    readReminderLedger: ledger.readReminderLedger,
    writeReminderLedger: ledger.writeReminderLedger,
  };
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

    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    // Exactly one local notification was produced for the due same-day reminder.
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sameDaySub, "same-day", "renewal");
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

    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });
    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(3);
    expect(notifier.notify).toHaveBeenCalledWith(subs[0], "same-day", "renewal");
    expect(notifier.notify).toHaveBeenCalledWith(subs[1], "one-day", "renewal");
    expect(notifier.notify).toHaveBeenCalledWith(subs[2], "three-days", "renewal");
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
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

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
    expect(notifier.notify).toHaveBeenLastCalledWith(newlyDue, "same-day", "renewal");
  });

  it("re-emits the same reminder on a NEW day (different `now`)", async () => {
    // A mutable clock + a subscription that is due each day lets us prove the
    // persisted ledger's dedupe bucket includes the canonical local day: the
    // same (sub, leadTime) re-emits when the LOCAL day changes (Req 13.3 —
    // evaluation keeps running across days while closed). The ledger persists
    // across cycles, so the only reason it re-fires is the new `localDay`.
    let nowDate = new Date("2025-03-07T00:00:00Z");
    const now = () => nowDate;

    const sub = makeSubscription({ id: "daily", nextRenewal: "2025-03-07" });
    const { services, state, ledger } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now, offsetMinutes: OFFSET_UTC });

    // Day 1: due same-day -> emits once; repeat cycle deduped via the ledger.
    await scheduler.evaluateNow();
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    // The day-1 fire is recorded in the ledger with the local-day bucket.
    expect(ledger.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "daily", leadTime: "same-day", localDay: "2025-03-07" },
    ]);

    // Advance to the next day and move the subscription's renewal to that day.
    nowDate = new Date("2025-03-08T00:00:00Z");
    const nextDaySub = makeSubscription({ id: "daily", nextRenewal: "2025-03-08" });
    state.subs = [nextDaySub];

    // New LOCAL day => different `localDay` bucket => not deduped => emits again.
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(notifier.notify).toHaveBeenLastCalledWith(nextDaySub, "same-day", "renewal");
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
    const scheduler = new Scheduler({ services, notifier, intervalMs, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // start() runs the launch catch-up pass (one read) THEN the immediate launch
    // evaluation (one read) — two subscription reads before any periodic tick.
    await scheduler.start();
    expect(listSubscriptions).toHaveBeenCalledTimes(2);

    // While running, each interval triggers another evaluation cycle.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(listSubscriptions).toHaveBeenCalledTimes(3);

    // stop() cancels the timer: advancing time produces NO further cycles.
    // This models Tray_Mode OFF — once the app stops running, evaluation halts.
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(intervalMs * 5);
    expect(listSubscriptions).toHaveBeenCalledTimes(3);
  });

  it("when stopped, evaluation happens only on explicit evaluateNow() (while open)", async () => {
    // With Tray_Mode OFF, the app evaluates only while open by invoking the
    // scheduler directly. A never-started scheduler emits when (and only when)
    // evaluateNow() is called.
    const sub = makeSubscription({ id: "same", nextRenewal: "2025-03-07" });
    const { services } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // No background timer was started, so nothing has emitted yet.
    expect(notifier.notify).not.toHaveBeenCalled();

    // The app invokes evaluation explicitly (i.e. while the window is open).
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day", "renewal");
  });
});

describe("state-based reminder eligibility (AD-17)", () => {
  it("a due Paused subscription produces NO notification", async () => {
    // Same-day due, but Paused subs never generate reminders (AD-17).
    const paused = makeSubscription({ id: "paused", nextRenewal: TODAY, state: "Paused" });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [paused]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).not.toHaveBeenCalled();
    // A Paused sub never fires and never persists a ledger entry (matrix).
    expect(ledger.ledger.fired).toEqual([]);
  });

  it("a due Trial subscription DOES produce a notification (Trial is reminder-eligible)", async () => {
    // Same-day due; Trial is live and reminder-eligible alongside Active (AD-17).
    // The trial's conversion is far in the future so ONLY the renewal fires here —
    // this test pins the renewal eligibility of a Trial state; the trial-END
    // reminder gets its own dedicated coverage below (Story 5.2).
    const trial = makeSubscription({
      id: "trial",
      nextRenewal: TODAY,
      state: "Trial",
      trial: { endDate: "2099-01-01", postAmountMinor: 49900 },
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(trial, "same-day", "renewal");
    // A fired Trial renewal reminder is recorded in the ledger.
    expect(ledger.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "trial", leadTime: "same-day", localDay: TODAY },
    ]);
  });
});

describe("settings gating supports Tray_Mode evaluation (Req 13.5)", () => {
  it("emits nothing when notifications are disabled, even for due subscriptions", async () => {
    // A subscription that WOULD be due same-day, but notifications are off.
    const sub = makeSubscription({ id: "same", nextRenewal: "2025-03-07" });
    const { services, listSubscriptions, writeReminderLedger } = makeServices(
      makeSettings(["same-day"], /* enabled */ false),
      [sub],
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    // The cycle short-circuits after reading settings: nothing is emitted,
    // subscriptions are not even read, AND the ledger is not written (so
    // `lastRunAt` is NOT advanced — matrix "Notifications disabled").
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(listSubscriptions).not.toHaveBeenCalled();
    expect(writeReminderLedger).not.toHaveBeenCalled();
  });
});

describe("ledger-backed exactly-once dedupe (Story 4.2 — SM-2)", () => {
  it("empty ledger: a due reminder emits once, appends its event, and advances lastRunAt", async () => {
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day", "renewal");
    expect(ledger.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "a", leadTime: "same-day", localDay: TODAY },
    ]);
    // `lastRunAt` advanced to the cycle's `now` (UTC ISO).
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("same-day RESTART does NOT re-fire: a fresh Scheduler over the persisted ledger emits nothing", async () => {
    // SM-2: the ledger (not an in-memory Set) is the dedupe source, so a NEW
    // Scheduler instance sharing the SAME persisted store suppresses the already
    // -fired reminder on a same-day restart.
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const sharedLedger = makeLedgerStore();

    // First process: fires once and persists the event.
    const first = makeServices(makeSettings(["same-day"]), [sub], sharedLedger);
    const notifier1 = makeNotifier();
    const scheduler1 = new Scheduler({
      services: first.services,
      notifier: notifier1,
      now: FIXED_NOW,
      offsetMinutes: OFFSET_UTC,
    });
    await scheduler1.evaluateNow();
    expect(notifier1.notify).toHaveBeenCalledTimes(1);
    expect(sharedLedger.store.ledger.fired).toHaveLength(1);

    // Second process (restart, same local day): a brand-new Scheduler + services
    // over the SAME persisted ledger store. `unfired` suppresses it — nothing fires.
    const second = makeServices(makeSettings(["same-day"]), [sub], sharedLedger);
    const notifier2 = makeNotifier();
    const scheduler2 = new Scheduler({
      services: second.services,
      notifier: notifier2,
      now: FIXED_NOW,
      offsetMinutes: OFFSET_UTC,
    });
    await scheduler2.evaluateNow();
    expect(notifier2.notify).not.toHaveBeenCalled();
    // No duplicate entry was appended.
    expect(sharedLedger.store.ledger.fired).toHaveLength(1);
  });

  it("multiple due lead times each dedupe independently", async () => {
    // Two subs: one due same-day, one due one-day. Each is a distinct ledger
    // identity, so both fire once, then neither re-fires on the next same-day
    // cycle (independent dedupe).
    const subs = [
      makeSubscription({ id: "same", nextRenewal: "2025-03-07" }),
      makeSubscription({ id: "one", nextRenewal: "2025-03-08" }),
    ];
    const { services, ledger } = makeServices(
      makeSettings(["same-day", "one-day"]),
      subs,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(ledger.ledger.fired).toHaveLength(2);

    // A second same-day cycle re-fires nothing (both identities already present).
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(ledger.ledger.fired).toHaveLength(2);
  });

  it("local-day boundary: dueness AND the ledger bucket are both reminderDay(now, offset)", async () => {
    // SEAM FIX (4.3): now = 2026-03-07T23:30Z, offset +330 (IST) => the canonical
    // LOCAL day is 2026-03-08. Dueness is now decided on that LOCAL day (not the
    // UTC day), so a sub is due same-day only when it renews ON the local day
    // (2026-03-08); the stored `localDay` is that same due date — one canonical
    // key shared with catchUp. (Under the old 4.2 split, dueness used the UTC day
    // 2026-03-07 while storing the local day 2026-03-08; the fixture is updated
    // for local-dueness keying — the emit outcome still holds, keyed on the due
    // date.)
    const now = () => new Date("2026-03-07T23:30:00Z");
    const sub = makeSubscription({ id: "boundary", nextRenewal: "2026-03-08" });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({
      services,
      notifier,
      now,
      offsetMinutes: () => 330, // IST, minutes EAST of UTC
    });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    // The stored `localDay` is the canonical LOCAL day (2026-03-08) = the due
    // date, proving dueness and the dedupe bucket share `reminderDay(now, offset)`.
    expect(ledger.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "boundary", leadTime: "same-day", localDay: "2026-03-08" },
    ]);
    expect(ledger.ledger.lastRunAt).toBe("2026-03-07T23:30:00.000Z");
  });

  it("a ledger READ failure degrades the cycle: emits nothing, writes nothing, does not crash", async () => {
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const ledgerStore = makeLedgerStore();
    ledgerStore.store.failReads = true;
    const { services, writeReminderLedger } = makeServices(
      makeSettings(["same-day"]),
      [sub],
      ledgerStore,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // Must not throw.
    await expect(scheduler.evaluateNow()).resolves.toBeUndefined();

    // Degraded: nothing emitted, nothing written, lastRunAt unchanged (null).
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(writeReminderLedger).not.toHaveBeenCalled();
    expect(ledgerStore.store.ledger.lastRunAt).toBeNull();
  });

  it("a ledger WRITE failure is caught: the reminder was shown, no crash, prior ledger intact", async () => {
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const ledgerStore = makeLedgerStore();
    ledgerStore.store.failWrites = true;
    const { services } = makeServices(
      makeSettings(["same-day"]),
      [sub],
      ledgerStore,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // Must not throw even though the write rejects.
    await expect(scheduler.evaluateNow()).resolves.toBeUndefined();

    // The reminder was shown BEFORE the (failed) write — the user-visible action.
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    // The write failed, so the prior (empty) ledger is intact: nothing persisted.
    expect(ledgerStore.store.ledger.fired).toEqual([]);
    expect(ledgerStore.store.ledger.lastRunAt).toBeNull();
  });

  it("a throw in the DECIDE region (bad offset → reminderDay RangeError) degrades, not propagates", async () => {
    // `offsetMinutes: () => NaN` makes `reminderDay` throw its fail-closed
    // RangeError INSIDE the cycle (after settings/subs/ledger reads, in the
    // decide region). The widened catch must degrade the cycle: resolve without
    // throwing, emit nothing, write nothing (lastRunAt unchanged).
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const ledgerStore = makeLedgerStore();
    const { services, writeReminderLedger } = makeServices(
      makeSettings(["same-day"]),
      [sub],
      ledgerStore,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({
      services,
      notifier,
      now: FIXED_NOW,
      offsetMinutes: () => Number.NaN, // reminderDay fail-closes with a RangeError
    });

    // Must not throw into the event loop (AD-28) — the DECIDE region throw is caught.
    await expect(scheduler.evaluateNow()).resolves.toBeUndefined();

    // Degraded: nothing emitted, nothing written, lastRunAt unchanged (null).
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(writeReminderLedger).not.toHaveBeenCalled();
    expect(ledgerStore.store.ledger.lastRunAt).toBeNull();
  });

  it("enabled cycle with nothing due still advances lastRunAt (4.3's catch-up anchor)", async () => {
    // No sub is due today (renewal is far in the future), notifications enabled.
    // The completed cycle emits nothing but STILL writes the ledger with
    // `lastRunAt` advanced and `fired` unchanged — the anchor Story 4.3 reads.
    const sub = makeSubscription({ id: "a", nextRenewal: "2025-12-31" });
    const ledgerStore = makeLedgerStore();
    const { services, writeReminderLedger } = makeServices(
      makeSettings(["same-day"]),
      [sub],
      ledgerStore,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(writeReminderLedger).toHaveBeenCalledTimes(1);
    // `lastRunAt` advanced to the cycle's `now`; `fired` stays empty (nothing due).
    expect(ledgerStore.store.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
    expect(ledgerStore.store.ledger.fired).toEqual([]);
  });

  it("prune on write drops stale entries (older than RETENTION_DAYS) and keeps recent ones", async () => {
    // Seed the ledger with a STALE entry (~100 days before today) and a RECENT
    // one (yesterday). A due sub makes the cycle emit + write; the write-back
    // must prune the stale entry (localDay < today - RETENTION_DAYS) and keep the
    // recent one — proving the scheduler passes (localDay, RETENTION_DAYS) to prune.
    const staleEntry = {
      kind: "renewal" as const,
      subscriptionId: "old",
      leadTime: "same-day" as const,
      localDay: "2024-11-27", // ~100 days before 2025-03-07 (> 90-day retention)
    };
    const recentEntry = {
      kind: "renewal" as const,
      subscriptionId: "recent",
      leadTime: "same-day" as const,
      localDay: "2025-03-06", // yesterday — within retention
    };
    const ledgerStore = makeLedgerStore({
      version: 1,
      lastRunAt: "2025-03-06T00:00:00.000Z",
      fired: [staleEntry, recentEntry],
    });
    const sub = makeSubscription({ id: "due", nextRenewal: TODAY });
    const { services } = makeServices(makeSettings(["same-day"]), [sub], ledgerStore);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    // The stale entry was pruned; the recent one and the newly-fired one remain.
    const localDays = ledgerStore.store.ledger.fired.map((e) => e.localDay).sort();
    expect(localDays).toEqual(["2025-03-06", TODAY]);
    expect(
      ledgerStore.store.ledger.fired.some((e) => e.subscriptionId === "old"),
    ).toBe(false);
    expect(
      ledgerStore.store.ledger.fired.some((e) => e.subscriptionId === "due"),
    ).toBe(true);
  });
});

describe("launch catch-up pass (Story 4.3 — AD-20) + live/catch-up seam (SM-2)", () => {
  // The headline seam cases prove the live tick and the launch catch-up share ONE
  // canonical dedupe key (the TARGET DUE DATE) even near a UTC-midnight boundary
  // with a non-zero offset — so a reminder shown by one path is never re-shown by
  // the other.
  //
  // Trace (verified): now 2026-03-09T20:00Z, offset +330 (IST) => the canonical
  // LOCAL day is 2026-03-10. A sub renewing 2026-03-11 (one-day lead) is due on
  // that local day, and BOTH paths key it on the due date 2026-03-10:
  //   - live tick: localToday = reminderDay(now,+330) = 2026-03-10; dueness is
  //     localToday+1 == renewal; stored localDay = localToday = 2026-03-10.
  //   - catch-up:  targetDate = renewal - 1 day = 2026-03-10 (its localDay key).
  const SEAM_OFFSET = () => 330; // IST, minutes EAST of UTC
  const SEAM_LIVE_NOW = () => new Date("2026-03-09T20:00:00Z"); // local day 2026-03-10
  const SEAM_CATCHUP_NOW = () => new Date("2026-03-10T02:00:00Z"); // same local day, within 24h
  const SEAM_RENEWAL = "2026-03-11"; // one-day lead => due date 2026-03-10
  const SEAM_DUE_DATE = "2026-03-10";

  it("SEAM: a reminder shown by the live tick is NOT re-fired by a relaunch catch-up (same localDay key)", async () => {
    const sub = makeSubscription({ id: "seam", nextRenewal: SEAM_RENEWAL });
    const sharedLedger = makeLedgerStore();

    // Live tick near the UTC-midnight boundary fires the one-day reminder and
    // persists it keyed on the DUE DATE (2026-03-10).
    const live = makeServices(makeSettings(["one-day"]), [sub], sharedLedger);
    const liveNotifier = makeNotifier();
    const liveScheduler = new Scheduler({
      services: live.services,
      notifier: liveNotifier,
      now: SEAM_LIVE_NOW,
      offsetMinutes: SEAM_OFFSET,
    });
    await liveScheduler.evaluateNow();
    expect(liveNotifier.notify).toHaveBeenCalledTimes(1);
    expect(sharedLedger.store.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "seam", leadTime: "one-day", localDay: SEAM_DUE_DATE },
    ]);

    // Relaunch: catch-up runs over the SAME persisted ledger + sub. It computes
    // the IDENTICAL localDay (= due date), so `catchUp`'s already-fired filter
    // suppresses it — NO double-fire across the seam (SM-2).
    const relaunch = makeServices(makeSettings(["one-day"]), [sub], sharedLedger);
    const cuNotifier = makeNotifier();
    const cuScheduler = new Scheduler({
      services: relaunch.services,
      notifier: cuNotifier,
      now: SEAM_CATCHUP_NOW,
      offsetMinutes: SEAM_OFFSET,
    });
    await cuScheduler.catchUpOnLaunch();

    expect(cuNotifier.notify).not.toHaveBeenCalled();
    // The ledger still has exactly the one entry (no duplicate appended).
    expect(
      sharedLedger.store.ledger.fired.filter((e) => e.subscriptionId === "seam"),
    ).toHaveLength(1);
  });

  it("SEAM (inverse): a reminder caught up at launch is NOT re-fired by the live tick (same localDay key)", async () => {
    const sub = makeSubscription({ id: "seam", nextRenewal: SEAM_RENEWAL });
    const sharedLedger = makeLedgerStore();

    // Catch-up fires first (empty ledger): emits the missed one-day reminder and
    // records it keyed on the due date 2026-03-10.
    const launch = makeServices(makeSettings(["one-day"]), [sub], sharedLedger);
    const cuNotifier = makeNotifier();
    const cuScheduler = new Scheduler({
      services: launch.services,
      notifier: cuNotifier,
      now: SEAM_CATCHUP_NOW,
      offsetMinutes: SEAM_OFFSET,
    });
    await cuScheduler.catchUpOnLaunch();
    expect(cuNotifier.notify).toHaveBeenCalledTimes(1);
    expect(cuNotifier.notify).toHaveBeenCalledWith(sub, "one-day", "renewal");
    expect(sharedLedger.store.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "seam", leadTime: "one-day", localDay: SEAM_DUE_DATE },
    ]);

    // The live tick on the same local day over the SAME ledger dedupes it: the
    // tick computes the identical key, so `unfired` drops it — no double-fire.
    const live = makeServices(makeSettings(["one-day"]), [sub], sharedLedger);
    const liveNotifier = makeNotifier();
    const liveScheduler = new Scheduler({
      services: live.services,
      notifier: liveNotifier,
      now: SEAM_LIVE_NOW,
      offsetMinutes: SEAM_OFFSET,
    });
    await liveScheduler.evaluateNow();

    expect(liveNotifier.notify).not.toHaveBeenCalled();
    expect(
      sharedLedger.store.ledger.fired.filter((e) => e.subscriptionId === "seam"),
    ).toHaveLength(1);
  });

  it("missed-while-closed: fires a reminder due within 24h once, appends it, advances lastRunAt", async () => {
    // now = 2025-03-07T00:00Z (UTC). A sub renewing 2025-03-10 has only its
    // THREE-days fire moment (UTC midnight of 2025-03-07 == now) inside the 24h
    // window; its same-day/one-day moments are in the future. three-days is
    // enabled, so catch-up fires exactly that one reminder.
    // NOTE: `catchUp` (frozen 4.1) evaluates ALL lead times whose moment lands in
    // the window — the enabled-lead-times filter is applied at the call site — so
    // the single emit here comes from a renewal that places only the (enabled)
    // three-days moment in-window.
    const sub = makeSubscription({ id: "missed", nextRenewal: "2025-03-10" });
    const { services, ledger } = makeServices(makeSettings(["three-days"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "three-days", "renewal");
    // Appended, keyed on the due date (renewal - 3 days = TODAY), lastRunAt advanced.
    expect(ledger.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "missed", leadTime: "three-days", localDay: TODAY },
    ]);
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("already-fired: catch-up emits nothing for a reminder already in the ledger", async () => {
    // Same single-in-window setup as missed-while-closed (renewal 2025-03-10 =>
    // only the enabled three-days moment lands in the window, keyed on due date
    // TODAY), but the ledger ALREADY has that identity. `catchUp` drops it => no
    // emit (dedupe is the cause, not the lead-time filter — three-days is enabled).
    const sub = makeSubscription({ id: "dup", nextRenewal: "2025-03-10" });
    const seeded = makeLedgerStore({
      version: 1,
      lastRunAt: null,
      fired: [
        { kind: "renewal", subscriptionId: "dup", leadTime: "three-days", localDay: TODAY },
      ],
    });
    const { services, ledger } = makeServices(makeSettings(["three-days"]), [sub], seeded);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).not.toHaveBeenCalled();
    // No duplicate appended; still exactly one entry for that identity.
    expect(
      ledger.ledger.fired.filter((e) => e.subscriptionId === "dup"),
    ).toHaveLength(1);
  });

  it("beyond look-back: a reminder whose moment is > 24h before now is not caught up", async () => {
    // now = 2025-03-07T00:00Z. A sub renewing 2025-03-05 (same-day) has its fire
    // moment at UTC midnight 2025-03-05 == 48h before now — outside the 24h cap.
    const sub = makeSubscription({ id: "old", nextRenewal: "2025-03-05" });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).not.toHaveBeenCalled();
    // Nothing fired, but a completed pass still advances `lastRunAt`.
    expect(ledger.ledger.fired).toEqual([]);
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("Paused: a Paused sub due in the window is never caught up", async () => {
    const paused = makeSubscription({ id: "paused", nextRenewal: TODAY, state: "Paused" });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [paused]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(ledger.ledger.fired).toEqual([]);
  });

  it("lastRunAt anchors the window: a reminder before lastRunAt (but within 24h) is not caught up", async () => {
    // now = 2025-03-07T00:00Z, lastRunAt = 2h before now (2025-03-06T22:00Z). The
    // sub renews 2025-03-06 (same-day), fire moment UTC midnight 2025-03-06 — that
    // is within the 24h cap but BEFORE lastRunAt, so the anchored window
    // [max(lastRunAt, now-24h), now] = [2025-03-06T22:00Z, now] excludes it.
    const sub = makeSubscription({ id: "pre-anchor", nextRenewal: "2025-03-06" });
    const seeded = makeLedgerStore({
      version: 1,
      lastRunAt: "2025-03-06T22:00:00.000Z",
      fired: [],
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [sub], seeded);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).not.toHaveBeenCalled();
    // The pass completes and advances `lastRunAt` forward to `now`.
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("read failure degrades the pass: emits nothing, writes nothing, does not crash", async () => {
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const ledgerStore = makeLedgerStore();
    ledgerStore.store.failReads = true;
    const { services, writeReminderLedger } = makeServices(
      makeSettings(["same-day"]),
      [sub],
      ledgerStore,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // Must not throw — launch continues.
    await expect(scheduler.catchUpOnLaunch()).resolves.toBeUndefined();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(writeReminderLedger).not.toHaveBeenCalled();
    expect(ledgerStore.store.ledger.lastRunAt).toBeNull();
  });

  it("disabled notifications: catch-up emits nothing and writes nothing (no lastRunAt advance)", async () => {
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const { services, listSubscriptions, writeReminderLedger, ledger } = makeServices(
      makeSettings(["same-day"], /* enabled */ false),
      [sub],
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(listSubscriptions).not.toHaveBeenCalled();
    expect(writeReminderLedger).not.toHaveBeenCalled();
    expect(ledger.ledger.lastRunAt).toBeNull();
  });

  it("start() runs the catch-up pass before the first periodic evaluation", async () => {
    // A reminder missed while closed (its three-days moment is in-window; renewal
    // 2025-03-10, due date TODAY) is caught by start()'s catch-up FIRST. The
    // chained immediate launch evaluation finds the SAME three-days reminder due
    // (localToday 2025-03-07 + 3 == renewal) but dedupes it against the entry the
    // catch-up just recorded — so the reminder emits exactly once overall, proving
    // the catch-up ran before (and shares one key with) the live evaluation.
    const sub = makeSubscription({ id: "launch", nextRenewal: "2025-03-10" });
    const { services, ledger } = makeServices(makeSettings(["three-days"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.start();
    scheduler.stop();

    // Exactly once (caught up at launch; the chained live evaluation adds nothing).
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "three-days", "renewal");
    expect(
      ledger.ledger.fired.filter((e) => e.subscriptionId === "launch"),
    ).toEqual([
      { kind: "renewal", subscriptionId: "launch", leadTime: "three-days", localDay: TODAY },
    ]);
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("respects enabled lead times: a DISABLED lead time whose moment is in-window is NOT caught up", async () => {
    // now = 2025-03-07T00:00Z. A sub renewing 2025-03-08 has only its ONE-day fire
    // moment (UTC midnight 2025-03-07 == now) in the 24h window. Settings enable
    // ONLY same-day, so the live tick would never fire one-day — and catch-up must
    // match: the disabled lead time is filtered out at the call site (`catchUp`
    // itself has no enabled param), so NOTHING is caught up.
    const sub = makeSubscription({ id: "disabled-lt", nextRenewal: "2025-03-08" });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).not.toHaveBeenCalled();
    // Nothing fired (one-day disabled), but a completed pass still advances lastRunAt.
    expect(ledger.ledger.fired).toEqual([]);
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("rolls lapsed autoRenew renewals forward: catch-up keys on the next occurrence, matching the live tick", async () => {
    // A monthly autoRenew sub whose nextRenewal LAPSED while the app was closed
    // (2025-02-07, a month before now). Catch-up must roll it forward on the same
    // local-day basis the live tick uses (rollForward(sub, localToday)) so it keys
    // on the NEXT occurrence 2025-03-07 (== TODAY) — NOT the stale Feb date. With
    // same-day enabled, catch-up fires same-day keyed on the rolled-forward date.
    const lapsed = makeSubscription({
      id: "lapsed",
      nextRenewal: "2025-02-07",
      billingCycle: "Monthly",
      autoRenew: true,
    });
    const sharedLedger = makeLedgerStore();
    const cu = makeServices(makeSettings(["same-day"]), [lapsed], sharedLedger);
    const cuNotifier = makeNotifier();
    const cuScheduler = new Scheduler({
      services: cu.services,
      notifier: cuNotifier,
      now: FIXED_NOW,
      offsetMinutes: OFFSET_UTC,
    });

    await cuScheduler.catchUpOnLaunch();

    // Caught up and keyed on the rolled-forward occurrence (2025-03-07 == TODAY),
    // the SAME key a live tick would store — not the stale 2025-02-07.
    expect(cuNotifier.notify).toHaveBeenCalledTimes(1);
    expect(cuNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lapsed", nextRenewal: TODAY }),
      "same-day",
      "renewal",
    );
    expect(sharedLedger.store.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "lapsed", leadTime: "same-day", localDay: TODAY },
    ]);

    // Seam proof: a live tick over the SAME ledger + sub dedupes it (the tick also
    // rolls forward to 2025-03-07 and computes the identical key) — no re-fire.
    const live = makeServices(makeSettings(["same-day"]), [lapsed], sharedLedger);
    const liveNotifier = makeNotifier();
    const liveScheduler = new Scheduler({
      services: live.services,
      notifier: liveNotifier,
      now: FIXED_NOW,
      offsetMinutes: OFFSET_UTC,
    });
    await liveScheduler.evaluateNow();
    expect(liveNotifier.notify).not.toHaveBeenCalled();
    expect(
      sharedLedger.store.ledger.fired.filter((e) => e.subscriptionId === "lapsed"),
    ).toHaveLength(1);
  });

  it("degrades on a DECIDE-region throw (bad offset → reminderDay RangeError): no emit, no write, no crash", async () => {
    // Mirrors the live-tick DECIDE-region degrade test: `offsetMinutes: () => NaN`
    // makes `reminderDay` throw its fail-closed RangeError inside the pass (after
    // the settings/subs/ledger reads). The catch-all backstop must degrade: resolve
    // without throwing, emit nothing, write nothing (lastRunAt unchanged) — AD-28.
    const sub = makeSubscription({ id: "a", nextRenewal: TODAY });
    const ledgerStore = makeLedgerStore();
    const { services, writeReminderLedger } = makeServices(
      makeSettings(["same-day"]),
      [sub],
      ledgerStore,
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({
      services,
      notifier,
      now: FIXED_NOW,
      offsetMinutes: () => Number.NaN, // reminderDay fail-closes with a RangeError
    });

    await expect(scheduler.catchUpOnLaunch()).resolves.toBeUndefined();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(writeReminderLedger).not.toHaveBeenCalled();
    expect(ledgerStore.store.ledger.lastRunAt).toBeNull();
  });

  it("a repeat start() does NOT re-run the catch-up pass (once per launch)", async () => {
    // start() runs catch-up once inside the first-start guard. A second start()
    // with the timer already live must NOT re-run catch-up — only a single launch
    // evaluation. We track catch-up runs via subscription reads: the first start()
    // reads subs twice (catch-up + evaluate); the second start() reads once (just
    // the evaluate), proving no second catch-up pass.
    const sub = makeSubscription({ id: "once", nextRenewal: "2025-12-31" });
    const { services, listSubscriptions } = makeServices(
      makeSettings(["same-day"]),
      [sub],
    );
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.start();
    expect(listSubscriptions).toHaveBeenCalledTimes(2); // catch-up + launch eval

    await scheduler.start(); // timer already live → no second catch-up
    expect(listSubscriptions).toHaveBeenCalledTimes(3); // only one more (eval)

    scheduler.stop();
  });

  it("LOOKBACK_HOURS is the 24h PRD FR-7 cap (guard against widening)", () => {
    // Executable boundary: the look-back must never widen past 24h (spec Boundaries).
    expect(LOOKBACK_HOURS).toBe(24);
  });
});

describe("Trial-End reminders (Story 5.2) — tick, seam, catch-up, eligibility", () => {
  /**
   * A Trial sub whose conversion is `TODAY` with same-day enabled fires a
   * trial-end reminder on the live tick, keyed on the conversion target day, and
   * records a `kind:"trial-end"` ledger entry. The notifier is called with the
   * `trial-end` kind so it renders the post-trial body.
   */
  it("live tick fires a due trial-end (notifier called with kind:'trial-end') and records it", async () => {
    // Conversion TODAY, same-day lead => targetDay = TODAY => due. nextRenewal is
    // far in the future so NO renewal reminder fires — isolating the trial-end.
    const trial = makeSubscription({
      id: "notion",
      name: "Notion",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: TODAY, postAmountMinor: 1000 }, // $10.00-equivalent
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(trial, "same-day", "trial-end");
    // The ledger records a distinct trial-end event keyed on the conversion day.
    expect(ledger.ledger.fired).toEqual([
      { kind: "trial-end", subscriptionId: "notion", leadTime: "same-day", localDay: TODAY },
    ]);
  });

  it("trial-end fires on an enabled lead time BEFORE the conversion day (three-days)", async () => {
    // Conversion 2025-03-10, three-days enabled => targetDay = 2025-03-07 = TODAY.
    const trial = makeSubscription({
      id: "ahead",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: "2025-03-10", postAmountMinor: 500 },
    });
    const { services, ledger } = makeServices(makeSettings(["three-days"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(trial, "three-days", "trial-end");
    expect(ledger.ledger.fired).toEqual([
      { kind: "trial-end", subscriptionId: "ahead", leadTime: "three-days", localDay: TODAY },
    ]);
  });

  it("earlier-of-local/UTC: fires on the UTC interpretation when it reaches the target first (west offset)", async () => {
    // now 2026-12-14T02:00Z, offset -480 (PST) => localToday 2026-12-13,
    // utcToday 2026-12-14. A trial converting 2026-12-14 with same-day lead has
    // targetDay 2026-12-14 — equal to utcToday (NOT localToday). The conservative
    // earlier-of rule fires it on the UTC interpretation (never after the charge).
    const trial = makeSubscription({
      id: "west",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: "2026-12-14", postAmountMinor: 999 },
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({
      services,
      notifier,
      now: () => new Date("2026-12-14T02:00:00Z"),
      offsetMinutes: () => -480,
    });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(trial, "same-day", "trial-end");
    // Dedupe key is the STABLE target day (= conversion day for a same-day lead),
    // not whichever interpretation fired.
    expect(ledger.ledger.fired).toEqual([
      { kind: "trial-end", subscriptionId: "west", leadTime: "same-day", localDay: "2026-12-14" },
    ]);
  });

  it("a Paused (or plain Active) sub NEVER fires a trial-end", async () => {
    // A Paused sub (even with a stale embedded trial) and a plain Active sub both
    // produce no trial-end. The Active sub's renewal is also future, so nothing
    // fires at all.
    const paused = makeSubscription({
      id: "paused",
      nextRenewal: "2099-01-01",
      state: "Paused",
      trial: { endDate: TODAY, postAmountMinor: 1000 },
    });
    const active = makeSubscription({
      id: "active",
      nextRenewal: "2099-01-01",
      state: "Active",
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [paused, active]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(ledger.ledger.fired).toEqual([]);
  });

  it("disabled lead time: a trial-end whose target is today is not emitted (enabled-gated)", async () => {
    // Conversion TODAY, but ONLY three-days enabled => same-day target (TODAY) is
    // gated off; three-days target would be 3 days ago (not today) => nothing.
    const trial = makeSubscription({
      id: "gated",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: TODAY, postAmountMinor: 1000 },
    });
    const { services, ledger } = makeServices(makeSettings(["three-days"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(ledger.ledger.fired).toEqual([]);
  });

  it("same-day restart: a trial-end already in the ledger does NOT re-fire", async () => {
    const trial = makeSubscription({
      id: "restart",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: TODAY, postAmountMinor: 1000 },
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // First tick fires + records it.
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    // Re-run on the same day over the SAME persisted ledger: unfired suppresses it.
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(ledger.ledger.fired).toHaveLength(1);
  });

  // Seam fixtures: a trial converting on SEAM_CONVERSION with one-day lead has a
  // stable target day SEAM_DUE_DATE. The live tick (local day = SEAM_DUE_DATE via
  // +330 near the UTC-midnight boundary) and the launch catch-up (fire-moment =
  // UTC midnight of SEAM_DUE_DATE, in the 24h window) stamp the IDENTICAL
  // (trial-end, sub, one-day, SEAM_DUE_DATE) identity — so neither re-fires it.
  const SEAM_OFFSET = () => 330; // IST
  const SEAM_LIVE_NOW = () => new Date("2026-03-09T20:00:00Z"); // local day 2026-03-10
  const SEAM_CATCHUP_NOW = () => new Date("2026-03-10T02:00:00Z"); // same local day, within 24h
  const SEAM_CONVERSION = "2026-03-11"; // one-day lead => target 2026-03-10
  const SEAM_DUE_DATE = "2026-03-10";

  it("SEAM: a trial-end shown by the live tick is NOT re-fired by a relaunch catch-up", async () => {
    const sub = makeSubscription({
      id: "seam",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: SEAM_CONVERSION, postAmountMinor: 1000 },
    });
    const sharedLedger = makeLedgerStore();

    const live = makeServices(makeSettings(["one-day"]), [sub], sharedLedger);
    const liveNotifier = makeNotifier();
    const liveScheduler = new Scheduler({
      services: live.services,
      notifier: liveNotifier,
      now: SEAM_LIVE_NOW,
      offsetMinutes: SEAM_OFFSET,
    });
    await liveScheduler.evaluateNow();
    expect(liveNotifier.notify).toHaveBeenCalledTimes(1);
    expect(liveNotifier.notify).toHaveBeenCalledWith(sub, "one-day", "trial-end");
    expect(sharedLedger.store.ledger.fired).toEqual([
      { kind: "trial-end", subscriptionId: "seam", leadTime: "one-day", localDay: SEAM_DUE_DATE },
    ]);

    // Relaunch catch-up over the SAME ledger computes the IDENTICAL key => no re-fire.
    const relaunch = makeServices(makeSettings(["one-day"]), [sub], sharedLedger);
    const cuNotifier = makeNotifier();
    const cuScheduler = new Scheduler({
      services: relaunch.services,
      notifier: cuNotifier,
      now: SEAM_CATCHUP_NOW,
      offsetMinutes: SEAM_OFFSET,
    });
    await cuScheduler.catchUpOnLaunch();

    expect(cuNotifier.notify).not.toHaveBeenCalled();
    expect(
      sharedLedger.store.ledger.fired.filter((e) => e.subscriptionId === "seam"),
    ).toHaveLength(1);
  });

  it("missed-while-closed: catch-up fires a missed trial-end once and records it", async () => {
    // now 2025-03-07T00:00Z (UTC). A trial converting 2025-03-10 with three-days
    // lead has its target day = TODAY; the UTC-midnight fire moment == now, inside
    // the 24h window => catch-up fires exactly one trial-end.
    const trial = makeSubscription({
      id: "missed",
      nextRenewal: "2099-01-01",
      state: "Trial",
      trial: { endDate: "2025-03-10", postAmountMinor: 1000 },
    });
    const { services, ledger } = makeServices(makeSettings(["three-days"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.catchUpOnLaunch();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(trial, "three-days", "trial-end");
    expect(ledger.ledger.fired).toEqual([
      { kind: "trial-end", subscriptionId: "missed", leadTime: "three-days", localDay: TODAY },
    ]);
    expect(ledger.ledger.lastRunAt).toBe(FIXED_NOW().toISOString());
  });

  it("renewal AND trial-end fire together when both are due in the same cycle", async () => {
    // Same sub: renewal due same-day (nextRenewal TODAY) AND trial converts TODAY
    // (same-day lead) => BOTH a renewal and a trial-end event, distinct kinds.
    const sub = makeSubscription({
      id: "both",
      nextRenewal: TODAY,
      state: "Trial",
      trial: { endDate: TODAY, postAmountMinor: 1000 },
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [sub]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day", "renewal");
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day", "trial-end");
    // Both distinct-kind events recorded; renewal keying unchanged alongside.
    expect(ledger.ledger.fired).toEqual([
      { kind: "renewal", subscriptionId: "both", leadTime: "same-day", localDay: TODAY },
      { kind: "trial-end", subscriptionId: "both", leadTime: "same-day", localDay: TODAY },
    ]);
  });
});
