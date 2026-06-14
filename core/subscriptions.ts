/**
 * Pure subscription mutation helpers and filtering predicates
 * (Req 3.1, 3.2, 3.3, 3.7, 9.2, 9.4, 9.7, 8.4).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 * `crypto.randomUUID` is a runtime global (Node 19+, modern browsers) and is
 * acceptable here; it keeps `core/` dependency-light (no `uuid` package).
 *
 * Every function in this module is PURE:
 *   - it never mutates its inputs in place (arrays/objects are copied), and
 *   - it never reads the wall clock; callers pass `now` for determinism.
 */

import type {
  BillingCycle,
  Subscription,
} from "./models/subscription";
import type { SubscriptionInput } from "shared/types";

/**
 * Fields a caller may change on an existing subscription. System-managed
 * fields (`id`, `createdAt`, `updatedAt`) are excluded: `id` and `createdAt`
 * are immutable after creation, and `updatedAt` is set by {@link editSubscription}.
 */
export type SubscriptionPatch = Partial<
  Omit<Subscription, "id" | "createdAt" | "updatedAt">
>;

/**
 * Generate a unique identifier for a new subscription (uuid v4).
 *
 * Uses the `crypto.randomUUID` global so `core/` stays free of a `uuid`
 * dependency and free of platform imports.
 */
function newId(): string {
  return crypto.randomUUID();
}

// --- Mutations ---------------------------------------------------------------

/**
 * Append a new subscription built from `input`, returning a new array
 * (the `existing` array is never mutated) (Req 3.1).
 *
 * The created subscription gets a unique id and `createdAt === updatedAt === now`.
 */
export function createSubscription(
  existing: Subscription[],
  input: SubscriptionInput,
  now: string,
): Subscription[] {
  const created: Subscription = {
    ...input,
    id: newId(),
    createdAt: now,
    updatedAt: now, // createdAt === updatedAt on creation (Req 3.1)
  };
  return [...existing, created];
}

/**
 * Apply `patch` to the subscription with the matching `id` and set its
 * `updatedAt` to `now`, returning a new array (Req 3.2, 9.7).
 *
 * Non-matching subscriptions are returned unchanged. If no subscription
 * matches `id`, the list is returned with the same contents (a fresh array).
 */
export function editSubscription(
  existing: Subscription[],
  id: string,
  patch: SubscriptionPatch,
  now: string,
): Subscription[] {
  return existing.map((s) =>
    s.id === id ? { ...s, ...patch, updatedAt: now } : s,
  );
}

/**
 * Set `isActive` to `value` on the subscription with the matching `id` and
 * advance its `updatedAt` to `now`, returning a new array (Req 3.7).
 */
export function toggleActive(
  existing: Subscription[],
  id: string,
  value: boolean,
  now: string,
): Subscription[] {
  return existing.map((s) =>
    s.id === id ? { ...s, isActive: value, updatedAt: now } : s,
  );
}

/**
 * Remove exactly the subscription with the matching `id`, returning a new
 * array (Req 3.3). Other subscriptions are preserved in their original order.
 */
export function deleteSubscription(
  existing: Subscription[],
  id: string,
): Subscription[] {
  return existing.filter((s) => s.id !== id);
}

// --- Predicates and filtering ------------------------------------------------

/** A predicate over a subscription, used to filter lists. */
export type SubscriptionPredicate = (s: Subscription) => boolean;

/**
 * Return a new array of subscriptions satisfying `predicate`, preserving the
 * original order. The input array is never mutated (Req 9.2, 9.4, 8.4).
 */
export function filterByPredicate(
  subs: Subscription[],
  predicate: SubscriptionPredicate,
): Subscription[] {
  return subs.filter(predicate);
}

/** Predicate matching subscriptions in the given `category` (Req 9.4). */
export function byCategory(category: string): SubscriptionPredicate {
  return (s) => s.category === category;
}

/** Predicate matching subscriptions whose `isActive` equals `status` (Req 9.4). */
export function byStatus(status: boolean): SubscriptionPredicate {
  return (s) => s.isActive === status;
}

/** Predicate matching subscriptions on the given billing `cycle` (Req 9.4). */
export function byCycle(cycle: BillingCycle): SubscriptionPredicate {
  return (s) => s.billingCycle === cycle;
}

/** Predicate matching only active subscriptions (Req 8.4). */
export const isActive: SubscriptionPredicate = (s) => s.isActive;

/**
 * Compose predicates with logical AND. The combined predicate matches only
 * when every given predicate matches. With no predicates it matches all.
 */
export function and(...predicates: SubscriptionPredicate[]): SubscriptionPredicate {
  return (s) => predicates.every((p) => p(s));
}

/**
 * Compose predicates with logical OR. The combined predicate matches when any
 * given predicate matches. With no predicates it matches none.
 */
export function or(...predicates: SubscriptionPredicate[]): SubscriptionPredicate {
  return (s) => predicates.some((p) => p(s));
}

/**
 * Convenience helper returning only the active subscriptions, used by the
 * dashboard and analytics (Req 8.4). Equivalent to
 * `filterByPredicate(subs, isActive)`.
 */
export function activeSubscriptions(subs: Subscription[]): Subscription[] {
  return filterByPredicate(subs, isActive);
}
