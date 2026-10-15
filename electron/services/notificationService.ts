/**
 * Notification_Service (Electron MAIN process) — Req 13.1, 13.2.
 *
 * Emits desktop renewal reminders via the Electron `Notification` API. Electron
 * notifications are delivered by the OS notification center and require NO
 * network access, so reminders work fully offline (Req 13.2).
 *
 * The actual emission is performed through an injectable {@link Notifier}
 * dependency. Production uses {@link electronNotifier}, which constructs and
 * `.show()`s a real `Notification`. Tests inject a spy `Notifier` so they can
 * assert what would be shown without a display/OS notification center and
 * without touching the real Electron API (see task 28.3).
 *
 * The pure decision of WHICH lead times are due lives in
 * `core/notify.dueLeadTimes`; this service only turns a `(sub, leadTime)` pair
 * into human-readable title/body text and hands it to the notifier.
 */

import { Notification } from "electron";

import { conversionDate } from "core/trial";
import { toMajor } from "core/money";
import type { ReminderEventKind } from "core/models/reminder";
import type { ReminderLeadTime } from "core/models/settings";
import type { SubscriptionV2 } from "core/models/subscription";

/** A renderable desktop notification payload. */
export interface NotificationPayload {
  /** Short headline shown in bold by the OS. */
  title: string;
  /** Supporting detail line. */
  body: string;
}

/**
 * The single side-effecting seam. A `Notifier` takes a fully-rendered payload
 * and surfaces it to the user. Injecting this (rather than calling
 * `new Notification(...)` directly) keeps {@link NotificationService} unit- and
 * integration-testable without a real OS notification center (task 28.3).
 */
export type Notifier = (payload: NotificationPayload) => void;

/** Human-readable RENEWAL phrasing for each lead time, relative to "today". */
const LEAD_TIME_PHRASE: Record<ReminderLeadTime, string> = {
  "same-day": "renews today",
  "one-day": "renews tomorrow",
  "three-days": "renews in 3 days",
};

/**
 * Human-readable TRIAL-END phrasing for each lead time (Story 5.2) — the "ends
 * in …" framing a trial-conversion warning uses, so the copy names WHEN the free
 * trial converts to a paid charge rather than a recurring renewal.
 */
const TRIAL_END_PHRASE: Record<ReminderLeadTime, string> = {
  "same-day": "trial ends today",
  "one-day": "trial ends tomorrow",
  "three-days": "trial ends in 3 days",
};

/**
 * Production {@link Notifier}: construct and show a real Electron
 * `Notification`. Local-only and offline (Req 13.2).
 *
 * Guards on `Notification.isSupported()` so that on platforms/environments
 * without notification support the call is a safe no-op rather than a throw.
 */
export const electronNotifier: Notifier = ({ title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
};

/**
 * Build the title/body text summarizing a subscription reminder for a given
 * lead time and event `kind`. Pure and exported so tests can assert the copy
 * without emitting.
 *
 * `kind:"renewal"` renders the recurring-renewal body (unchanged), e.g.
 *   `{ title: "Netflix renews tomorrow", body: "INR 499.00 • renews on 2025-02-01" }`.
 *
 * `kind:"trial-end"` (Story 5.2) renders a factual trial-conversion warning that
 * NAMES the post-trial price — the amount that will actually be charged once the
 * free trial converts — drawn from `sub.trial.postAmountMinor` through the money
 * seam (`toMajor`, no "/mo" — a per-cycle figure, consistent with 5.1), e.g.
 *   `{ title: "Notion trial ends in 3 days", body: "USD 10.00 after • converts 2026-12-15" }`.
 * No hype, no emoji — the copy states the facts plainly.
 */
export function renderReminder(
  sub: SubscriptionV2,
  leadTime: ReminderLeadTime,
  kind: ReminderEventKind,
): NotificationPayload {
  if (kind === "trial-end" && sub.trial !== undefined) {
    const phrase = TRIAL_END_PHRASE[leadTime];
    const title = `${sub.name} ${phrase}`;
    const converts = conversionDate(sub.trial);
    // Post-trial price: the amount charged once the trial converts, routed
    // through the money seam. No "/mo" — a per-cycle figure (consistent with
    // 5.1's framing). The plain "ends …"/"… after" wording stays factual.
    //
    // DEGRADE, never throw (AD-28): `toMajor` throws on an unknown currency or a
    // non-integer minor amount. A throw here would propagate through `notify`
    // into the scheduler emit loop and abort the cycle BEFORE `commitLedger`,
    // leaving already-shown reminders unrecorded (so they could re-fire). The
    // notifier must never throw: fall back to a price-less body that still names
    // the conversion so the user is warned, factually, even on bad money data.
    try {
      const postMajor = toMajor(sub.trial.postAmountMinor, sub.currency);
      const body = `${sub.currency} ${postMajor} after • converts ${converts}`;
      return { title, body };
    } catch {
      return { title, body: `converts ${converts}` };
    }
  }
  const phrase = LEAD_TIME_PHRASE[leadTime];
  const title = `${sub.name} ${phrase}`;
  const amountPart = `${sub.currency} ${toMajor(sub.amountMinor, sub.currency)}`;
  const body = `${amountPart} • renews on ${sub.nextRenewal}`;
  return { title, body };
}

/**
 * Emits desktop renewal reminders. The scheduler (see `scheduler.ts`) decides
 * WHEN to evaluate and WHICH `(sub, leadTime)` pairs are due (via
 * `core/notify.dueLeadTimes`) and calls {@link NotificationService.notify} for
 * each due pair.
 */
export class NotificationService {
  private readonly notifier: Notifier;

  /**
   * @param notifier The emission seam. Defaults to {@link electronNotifier};
   *                 tests pass a spy to capture payloads instead.
   */
  constructor(notifier: Notifier = electronNotifier) {
    this.notifier = notifier;
  }

  /**
   * Emit a single desktop reminder for `sub` at the given `leadTime` and event
   * `kind`. Builds the summary copy (renewal vs trial-end) and hands it to the
   * injected {@link Notifier}. Offline by construction (Req 13.2).
   */
  notify(sub: SubscriptionV2, leadTime: ReminderLeadTime, kind: ReminderEventKind): void {
    this.notifier(renderReminder(sub, leadTime, kind));
  }
}
