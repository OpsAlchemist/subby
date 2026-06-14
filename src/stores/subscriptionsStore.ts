/**
 * Subscriptions store (task 17.1, Req 8.6).
 *
 * Holds the current subscription list, reloaded via `subscriptionsApi.list()`.
 * Reloaded automatically on `onDataChanged` by {@link initStores}.
 */

import type { Subscription } from "core/models/subscription";
import { subscriptionsApi } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton subscriptions store. Initial data is an empty list. */
export const subscriptionsStore: Store<Subscription[]> = createStore<
  Subscription[]
>([], () => subscriptionsApi.list());
