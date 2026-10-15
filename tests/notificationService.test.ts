import { describe, it, expect, vi } from "vitest";

import {
  NotificationService,
  renderReminder,
  type NotificationPayload,
  type Notifier,
} from "../electron/services/notificationService";
import type { SubscriptionV2 } from "core/models/subscription";

/**
 * Notification_Service copy tests (Story 5.2). The service is PURE given its
 * injected {@link Notifier}: `renderReminder` turns a `(sub, leadTime, kind)`
 * triple into title/body text with no I/O, so these assert the copy directly
 * (and the `notify` path forwards the same payload to the injected notifier).
 *
 * The trial-end branch must NAME the post-trial price (the amount charged once
 * the free trial converts) and use the "ends …" framing — factual, no hype or
 * emoji — while the renewal branch stays exactly as before.
 */

/** A complete, type-valid v2 subscription; overridable per case. */
function makeSub(overrides: Partial<SubscriptionV2> = {}): SubscriptionV2 {
  return {
    id: "sub-1",
    name: "Notion",
    provider: "Notion Labs",
    category: "Productivity",
    amountMinor: 49900,
    currency: "USD",
    billingCycle: "Monthly",
    nextRenewal: "2026-12-15",
    startDate: "2024-01-01",
    paymentMethod: "Card",
    website: "https://notion.so",
    notes: "",
    color: "#000000",
    icon: "notion",
    state: "Active",
    priceHistory: [],
    tags: [],
    autoRenew: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** No hype / no emoji: reject common emoji + exclamation-mark nagging. */
function assertFactual(payload: NotificationPayload): void {
  const text = `${payload.title} ${payload.body}`;
  expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  expect(text).not.toContain("!");
}

describe("renderReminder — trial-end body names the post-trial price (Story 5.2)", () => {
  it("three-days: title uses the 'ends' framing, body names the post-trial price + conversion date", () => {
    const sub = makeSub({
      name: "Notion",
      currency: "USD",
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 }, // $10.00
    });

    const payload = renderReminder(sub, "three-days", "trial-end");

    expect(payload.title).toBe("Notion trial ends in 3 days");
    // Post-trial price = toMajor(1000, USD) = "10.00"; no "/mo"; conversion date.
    expect(payload.body).toBe("USD 10.00 after • converts 2026-12-15");
    assertFactual(payload);
  });

  it("same-day / one-day use 'ends today' / 'ends tomorrow'", () => {
    const sub = makeSub({
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 },
    });
    expect(renderReminder(sub, "same-day", "trial-end").title).toBe("Notion trial ends today");
    expect(renderReminder(sub, "one-day", "trial-end").title).toBe("Notion trial ends tomorrow");
  });

  it("names the post-trial price from `trial.postAmountMinor`, NOT the current amount", () => {
    // amountMinor (49900) is the trial's $0 current spend; the body must use the
    // POST-trial amount (1000 => $10.00) — the figure that will actually be charged.
    const sub = makeSub({
      currency: "USD",
      amountMinor: 49900,
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 },
    });
    const payload = renderReminder(sub, "three-days", "trial-end");
    expect(payload.body).toContain("10.00");
    expect(payload.body).not.toContain("499.00");
  });

  it("derives the conversion date from startDate + lengthDays when no endDate is set", () => {
    const sub = makeSub({
      currency: "USD",
      state: "Trial",
      trial: { startDate: "2026-12-01", lengthDays: 14, postAmountMinor: 1500 },
    });
    const payload = renderReminder(sub, "same-day", "trial-end");
    // conversionDate = 2026-12-01 + 14 days = 2026-12-15.
    expect(payload.body).toBe("USD 15.00 after • converts 2026-12-15");
  });

  it("a 0-decimal currency (JPY) renders the post amount with no fractional part", () => {
    const sub = makeSub({
      name: "Mangabox",
      currency: "JPY",
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 }, // JPY has exponent 0
    });
    const payload = renderReminder(sub, "three-days", "trial-end");
    // toMajor(1000, JPY) = "1000" (no fractional digits for a 0-decimal currency).
    expect(payload.body).toBe("JPY 1000 after • converts 2026-12-15");
  });

  it("DEGRADES on an unknown currency: still a trial-end payload, price omitted, never throws", () => {
    const sub = makeSub({
      name: "Mystery",
      currency: "ZZZ", // not in the money exponent table → toMajor throws
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 },
    });
    let payload: NotificationPayload | undefined;
    expect(() => {
      payload = renderReminder(sub, "one-day", "trial-end");
    }).not.toThrow();
    // The user is still warned (title + conversion date), with the unparseable
    // price safely omitted rather than crashing the notifier.
    expect(payload).toEqual({
      title: "Mystery trial ends tomorrow",
      body: "converts 2026-12-15",
    });
  });

  it("DEGRADES through NotificationService.notify without throwing (unknown currency)", () => {
    const captured: NotificationPayload[] = [];
    const notifier: Notifier = (p) => captured.push(p);
    const service = new NotificationService(notifier);
    const sub = makeSub({
      name: "Mystery",
      currency: "ZZZ",
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 },
    });
    expect(() => service.notify(sub, "same-day", "trial-end")).not.toThrow();
    expect(captured).toEqual([{ title: "Mystery trial ends today", body: "converts 2026-12-15" }]);
  });
});

describe("renderReminder — renewal body is unchanged (Story 5.2)", () => {
  it("renders the existing renewal title/body for kind:'renewal'", () => {
    const sub = makeSub({
      name: "Netflix",
      currency: "INR",
      amountMinor: 49900,
      nextRenewal: "2025-02-01",
    });
    const payload = renderReminder(sub, "one-day", "renewal");
    expect(payload.title).toBe("Netflix renews tomorrow");
    expect(payload.body).toBe("INR 499.00 • renews on 2025-02-01");
    assertFactual(payload);
  });

  it("a trial-end kind on a sub WITHOUT a trial block falls back to the renewal body", () => {
    // Defensive: no embedded trial => render the renewal body rather than throw.
    const sub = makeSub({ name: "Spotify", currency: "USD", nextRenewal: "2025-02-01" });
    const payload = renderReminder(sub, "same-day", "trial-end");
    expect(payload.title).toBe("Spotify renews today");
  });
});

describe("NotificationService.notify forwards the rendered payload to the injected notifier", () => {
  it("passes the trial-end payload through for a trial-end kind", () => {
    const captured: NotificationPayload[] = [];
    const notifier: Notifier = (p) => captured.push(p);
    const service = new NotificationService(notifier);
    const sub = makeSub({
      currency: "USD",
      state: "Trial",
      trial: { endDate: "2026-12-15", postAmountMinor: 1000 },
    });

    service.notify(sub, "three-days", "trial-end");

    expect(captured).toEqual([
      { title: "Notion trial ends in 3 days", body: "USD 10.00 after • converts 2026-12-15" },
    ]);
  });

  it("passes the renewal payload through for a renewal kind", () => {
    const notify = vi.fn();
    const service = new NotificationService(notify);
    const sub = makeSub({ name: "Netflix", currency: "INR", amountMinor: 49900, nextRenewal: "2025-02-01" });

    service.notify(sub, "one-day", "renewal");

    expect(notify).toHaveBeenCalledWith({
      title: "Netflix renews tomorrow",
      body: "INR 499.00 • renews on 2025-02-01",
    });
  });
});
