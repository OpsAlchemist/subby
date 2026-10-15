import { afterEach, describe, expect, it, vi } from "vitest";

import { Scheduler } from "../electron/services/scheduler";
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

    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });
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
    expect(notifier.notify).toHaveBeenLastCalledWith(newlyDue, "same-day");
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
    const scheduler = new Scheduler({ services, notifier, intervalMs, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

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
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    // No background timer was started, so nothing has emitted yet.
    expect(notifier.notify).not.toHaveBeenCalled();

    // The app invokes evaluation explicitly (i.e. while the window is open).
    await scheduler.evaluateNow();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day");
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
    const trial = makeSubscription({
      id: "trial",
      nextRenewal: TODAY,
      state: "Trial",
      trial: { endDate: TODAY, postAmountMinor: 49900 },
    });
    const { services, ledger } = makeServices(makeSettings(["same-day"]), [trial]);
    const notifier = makeNotifier();
    const scheduler = new Scheduler({ services, notifier, now: FIXED_NOW, offsetMinutes: OFFSET_UTC });

    await scheduler.evaluateNow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith(trial, "same-day");
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
    expect(notifier.notify).toHaveBeenCalledWith(sub, "same-day");
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

  it("local-day boundary: the ledger bucket is reminderDay(now, offset), not the UTC day", async () => {
    // now = 2026-03-07T23:30Z, offset +330 (IST) => local day 2026-03-08. The
    // renewal-due comparison uses the UTC `today` (2026-03-07), so a sub renewing
    // same-day on 2026-03-07 is due; the DEDUPE bucket stored is the LOCAL day.
    const now = () => new Date("2026-03-07T23:30:00Z");
    const sub = makeSubscription({ id: "boundary", nextRenewal: "2026-03-07" });
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
    // The stored `localDay` is the canonical LOCAL day (2026-03-08), proving the
    // dedupe bucket is `reminderDay(now, offset)` — the one canonical clock.
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
