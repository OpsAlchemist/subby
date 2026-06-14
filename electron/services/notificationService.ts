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

import type { ReminderLeadTime } from "core/models/settings";
import type { Subscription } from "core/models/subscription";

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

/** Human-readable phrasing for each lead time, relative to "today". */
const LEAD_TIME_PHRASE: Record<ReminderLeadTime, string> = {
  "same-day": "renews today",
  "one-day": "renews tomorrow",
  "three-days": "renews in 3 days",
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
 * lead time. Pure and exported so tests can assert the copy without emitting.
 *
 * Example: `{ title: "Netflix renews tomorrow", body: "₹—  •  INR 499 on 2025-02-01" }`
 * (amount/currency only included when an amount is present).
 */
export function renderReminder(
  sub: Subscription,
  leadTime: ReminderLeadTime,
): NotificationPayload {
  const phrase = LEAD_TIME_PHRASE[leadTime];
  const title = `${sub.name} ${phrase}`;
  const amountPart = `${sub.currency} ${sub.amount}`;
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
   * Emit a single desktop reminder for `sub` at the given `leadTime`. Builds the
   * summary copy and hands it to the injected {@link Notifier}. Offline by
   * construction (Req 13.2).
   */
  notify(sub: Subscription, leadTime: ReminderLeadTime): void {
    this.notifier(renderReminder(sub, leadTime));
  }
}
